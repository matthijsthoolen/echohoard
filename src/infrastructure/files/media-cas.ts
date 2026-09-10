import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, open, rm, stat, link } from "node:fs/promises";
import { basename, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { MediaCasObject, MediaCasStorePort } from "../../application/media.js";

const SHA256 = /^[a-f0-9]{64}$/u;

export class MediaCasError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MediaCasError";
  }
}

export interface MediaCasStoreOptions {
  readonly maxBytes?: number;
}

/** A filesystem CAS. Publication uses hard-link, which is atomic and never
 * overwrites an object another importer has already published. */
export class LocalMediaCasStore implements MediaCasStorePort {
  private readonly maxBytes: number;

  public constructor(
    private readonly root: string,
    options: MediaCasStoreOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? 1024 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0)
      throw new MediaCasError("invalid media size limit");
  }

  public async store(sourcePath: string, expectedSha256?: string): Promise<MediaCasObject> {
    if (expectedSha256 !== undefined && !SHA256.test(expectedSha256))
      throw new MediaCasError("invalid expected media hash");
    const source = await lstat(sourcePath).catch(() => {
      throw new MediaCasError("media source is unavailable");
    });
    if (!source.isFile()) throw new MediaCasError("media source must be a regular file");

    await mkdir(this.root, { recursive: true });
    const temporary = join(
      this.root,
      `.upload-${process.pid}-${randomUUID()}-${basename(sourcePath)}`,
    );
    let size = 0;
    const hash = createHash("sha256");
    const bounded = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        size += chunk.length;
        if (size > this.maxBytes) {
          callback(new MediaCasError("media exceeds size limit"));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        createReadStream(sourcePath),
        bounded,
        createWriteStream(temporary, { flags: "wx" }),
      );
      const sha256 = hash.digest("hex");
      if (expectedSha256 !== undefined && expectedSha256 !== sha256)
        throw new MediaCasError("media hash does not match expected hash");
      const destination = join(this.root, "sha256", sha256.slice(0, 2), sha256);
      await mkdir(join(this.root, "sha256", sha256.slice(0, 2)), { recursive: true });
      try {
        await link(temporary, destination);
        await chmod(destination, 0o444);
        return { sha256, path: destination, size, duplicate: false };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await stat(destination).catch(() => null);
        if (!existing?.isFile()) throw new MediaCasError("CAS destination is not a regular file");
        return { sha256, path: destination, size: existing.size, duplicate: true };
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
