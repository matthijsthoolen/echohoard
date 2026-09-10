import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalMediaCasStore, MediaCasError } from "./media-cas.js";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("local media CAS", () => {
  it("streams, hashes, and atomically publishes duplicate bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "echohoard-cas-"));
    const source = join(root, "source.bin");
    const bytes = Buffer.from("same media bytes");
    await writeFile(source, bytes);
    const store = new LocalMediaCasStore(join(root, "media"));
    const first = await store.store(source);
    const second = await store.store(source, first.sha256);
    expect(first).toMatchObject({ sha256: hash(bytes), size: bytes.length, duplicate: false });
    expect(second).toMatchObject({ ...first, duplicate: true });
    await expect(readFile(first.path)).resolves.toEqual(bytes);
    await expect(readFile(source)).resolves.toEqual(bytes);
  });

  it("deduplicates concurrent writers without exposing temporary objects", async () => {
    const root = await mkdtemp(join(tmpdir(), "echohoard-cas-"));
    const source = join(root, "source.bin");
    await writeFile(source, Buffer.alloc(512 * 1024, 7));
    const store = new LocalMediaCasStore(join(root, "media"));
    const results = await Promise.all([
      store.store(source),
      store.store(source),
      store.store(source),
    ]);
    expect(new Set(results.map((result) => result.path)).size).toBe(1);
    expect(results.filter((result) => result.duplicate)).toHaveLength(2);
    await expect(readdir(join(root, "media"))).resolves.toContain("sha256");
  });

  it("fails closed on mismatches, symlinks, and bounded/interrupted copies", async () => {
    const root = await mkdtemp(join(tmpdir(), "echohoard-cas-"));
    const source = join(root, "source.bin");
    await writeFile(source, Buffer.alloc(256, 1));
    const media = join(root, "media");
    const store = new LocalMediaCasStore(media, { maxBytes: 100 });
    await expect(store.store(source)).rejects.toThrow("size limit");
    await expect(readdir(media)).resolves.not.toContain("sha256");
    await expect(store.store(source, "a".repeat(64))).rejects.toThrow(MediaCasError);
    const linked = join(root, "linked.bin");
    await symlink(source, linked);
    await expect(new LocalMediaCasStore(join(root, "other-media")).store(linked)).rejects.toThrow(
      "regular file",
    );
    const existing = await stat(source);
    expect(existing.size).toBe(256);
  });

  it("supports large streaming input with a caller-provided expected hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "echohoard-cas-"));
    const source = join(root, "large.bin");
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 42);
    await writeFile(source, bytes);
    const result = await new LocalMediaCasStore(join(root, "media"), {
      maxBytes: bytes.length,
    }).store(source, hash(bytes));
    expect(result.size).toBe(bytes.length);
    await expect(readFile(result.path)).resolves.toHaveLength(bytes.length);
  });
});
