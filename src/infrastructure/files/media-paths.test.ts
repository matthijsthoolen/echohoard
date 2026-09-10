import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { indexMediaPaths, LocalMediaPathResolver } from "./media-paths.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "echohoard-media-"));
  await writeFile(join(root, "photo.jpg"), "photo");
  await writeFile(join(root, "unicode-é.txt"), "unicode");
  await writeFile(join(root, "nested.bin"), "nested");
  return root;
}

describe("local media path resolution", () => {
  it("resolves an indexed relative path and Unicode filename", async () => {
    const root = await fixture();
    const resolver = new LocalMediaPathResolver(root, await indexMediaPaths(root));
    await expect(resolver.resolve({ relativePath: "photo.jpg" })).resolves.toMatchObject({
      state: "resolved",
      relativePath: "photo.jpg",
    });
    await expect(resolver.resolve({ filename: "unicode-e\u0301.txt" })).resolves.toMatchObject({
      state: "resolved",
      relativePath: "unicode-é.txt",
    });
  });

  it("rejects traversal and absolute paths", async () => {
    const root = await fixture();
    const resolver = new LocalMediaPathResolver(root, await indexMediaPaths(root));
    await expect(resolver.resolve({ relativePath: "../photo.jpg" })).resolves.toEqual({
      state: "unresolved",
      reason: "unsafe",
    });
    await expect(resolver.resolve({ relativePath: "/etc/passwd" })).resolves.toEqual({
      state: "unresolved",
      reason: "unsafe",
    });
    await expect(resolver.resolve({ relativePath: "C:\\Windows\\win.ini" })).resolves.toEqual({
      state: "unresolved",
      reason: "unsafe",
    });
  });

  it("returns explicit ambiguity for duplicate fallback names", async () => {
    const root = await mkdtemp(join(tmpdir(), "echohoard-media-"));
    await writeFile(join(root, "one.jpg"), "one");
    await writeFile(join(root, "two.jpg"), "two");
    const resolver = new LocalMediaPathResolver(root, [
      { relativePath: "one.jpg" },
      { relativePath: "two.jpg" },
    ]);
    await expect(resolver.resolve({ filename: "photo.jpg" })).resolves.toEqual({
      state: "unresolved",
      reason: "missing",
    });
    const duplicate = new LocalMediaPathResolver(root, [
      { relativePath: "a/photo.jpg" },
      { relativePath: "b/photo.jpg" },
    ]);
    await expect(duplicate.resolve({ filename: "photo.jpg" })).resolves.toEqual({
      state: "unresolved",
      reason: "ambiguous",
    });
  });

  it("rejects a symlink escaping the delivery root", async () => {
    const root = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "echohoard-outside-"));
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(root, "linked.txt"));
    const resolver = new LocalMediaPathResolver(root, await indexMediaPaths(root));
    await expect(resolver.resolve({ relativePath: "linked.txt" })).resolves.toEqual({
      state: "unresolved",
      reason: "unsafe",
    });
  });

  it("does not resolve unindexed or missing observations", async () => {
    const root = await fixture();
    const resolver = new LocalMediaPathResolver(root, [{ relativePath: "photo.jpg" }]);
    await expect(resolver.resolve({ relativePath: "nested.bin" })).resolves.toEqual({
      state: "unresolved",
      reason: "missing",
    });
    await expect(resolver.resolve({ filename: "unknown.bin" })).resolves.toEqual({
      state: "unresolved",
      reason: "missing",
    });
  });
});
