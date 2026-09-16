import {
  copyFile,
  mkdir,
  readdir,
  rename,
  stat,
  writeFile,
  readFile,
  rm,
  rmdir,
} from "node:fs/promises";
import { join } from "node:path";
import type {
  DeliveryFile,
  DeliveryId,
  InboxPort,
  Snapshot,
  SnapshotManifest,
  SnapshotStorePort,
} from "../../application/echohoard.js";
import type { ImportJobId, LeaseId } from "../../application/echohoard.js";
import type { JobWorkPort } from "../../application/intake.js";

/** Disposable plaintext workspace. Job ids are treated as opaque path
 * components and rejected unless they are safe UUID-like identifiers. */
export class LocalJobWork implements JobWorkPort {
  public constructor(private readonly root: string) {}

  public async prepare(
    jobId: ImportJobId,
    lease: LeaseId,
  ): Promise<{ path: string; restarted: boolean }> {
    const path = this.pathFor(jobId, lease);
    let restarted = false;
    try {
      await stat(path);
      await rm(path, { recursive: true, force: true });
      restarted = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(join(this.root, this.validateComponent(jobId)), { recursive: true });
    await mkdir(path, { recursive: false });
    return { path, restarted };
  }

  public async cleanup(jobId: ImportJobId, lease: LeaseId, path: string): Promise<void> {
    if (path !== this.pathFor(jobId, lease)) throw new Error("work path is not owned by lease");
    await rm(path, { recursive: true, force: true });
    await this.removeEmptyJobDirectory(jobId);
  }

  public async cleanupStale(jobId: ImportJobId, lease: LeaseId): Promise<void> {
    await rm(this.pathFor(jobId, lease), { recursive: true, force: true });
    await this.removeEmptyJobDirectory(jobId);
  }

  private pathFor(jobId: ImportJobId, lease: LeaseId): string {
    return join(this.root, this.validateComponent(jobId), this.validateComponent(lease));
  }

  private validateComponent(value: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid work identifier");
    return value;
  }

  private async removeEmptyJobDirectory(jobId: ImportJobId): Promise<void> {
    try {
      await rmdir(join(this.root, this.validateComponent(jobId)));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
    }
  }
}

export class LocalInbox implements InboxPort {
  public async listDeliveries(inboxPath: string): Promise<readonly string[]> {
    const entries = await readdir(inboxPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  }
  public async inspect(deliveryPath: string): Promise<readonly DeliveryFile[]> {
    const entries = await readdir(deliveryPath, { withFileTypes: true });
    const files: DeliveryFile[] = [];
    for (const entry of entries
      .filter((candidate) => candidate.isFile())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const details = await stat(join(deliveryPath, entry.name));
      files.push({ name: entry.name, size: details.size, modifiedAt: details.mtime });
    }
    return files;
  }
  public async claim(deliveryPath: string, deliveryId: DeliveryId): Promise<string | null> {
    const destination = join(join(deliveryPath, ".."), ".claimed", deliveryId);
    await mkdir(join(destination, ".."), { recursive: true });
    try {
      await rename(deliveryPath, destination);
      return destination;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EEXIST") return null;
      throw error;
    }
  }
}

export class LocalSnapshotStore implements SnapshotStorePort {
  public constructor(private readonly root: string) {}
  public async createStaging(snapshotId: string): Promise<string> {
    const path = join(this.root, `.staging-${snapshotId}`);
    await mkdir(this.root, { recursive: true });
    await mkdir(path, { recursive: false });
    return path;
  }
  public async copy(source: string, destination: string): Promise<void> {
    await copyFile(source, destination);
  }
  public async writeManifest(stagingPath: string, manifest: SnapshotManifest): Promise<void> {
    await writeFile(join(stagingPath, "manifest.json.tmp"), JSON.stringify(manifest) + "\n", {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(join(stagingPath, "manifest.json.tmp"), join(stagingPath, "manifest.json"));
  }
  public async publish(stagingPath: string, snapshotId: string): Promise<string> {
    const destination = join(this.root, snapshotId);
    await rename(stagingPath, destination);
    return destination;
  }
  public async findReadyBySourceHash(sourceHash: string): Promise<Snapshot | null> {
    await mkdir(this.root, { recursive: true });
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".staging-")) continue;
      try {
        const manifest = JSON.parse(
          await readFile(join(this.root, entry.name, "manifest.json"), "utf8"),
        ) as SnapshotManifest;
        if (manifest.sourceHash === sourceHash)
          return {
            id: manifest.snapshotId,
            deliveryId: manifest.deliveryId,
            sourceHash,
            path: join(this.root, entry.name),
            createdAt: new Date(manifest.capturedAt),
            status: "ready",
          };
      } catch {
        /* incomplete or unrelated directory is not ready */
      }
    }
    return null;
  }
}

export const infrastructureFiles = "files";

export * from "./media-paths.js";
export * from "./media-cas.js";
