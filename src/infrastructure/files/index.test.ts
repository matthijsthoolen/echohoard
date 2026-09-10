import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalJobWork } from "./index.js";

describe("local disposable job work", () => {
  it("creates an isolated directory and removes it after cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "echohoard-work-"));
    const work = new LocalJobWork(root);
    const created = await work.prepare("job-1");
    await writeFile(join(created.path, "msgstore.db"), "synthetic plaintext");
    await work.cleanup("job-1", created.path);
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("restarts abandoned work and rejects an unowned path", async () => {
    const root = await mkdtemp(join(tmpdir(), "echohoard-work-"));
    const work = new LocalJobWork(root);
    const first = await work.prepare("job-2");
    await writeFile(join(first.path, "db"), "stale");
    const restarted = await work.prepare("job-2");
    expect(restarted.restarted).toBe(true);
    await expect(work.cleanup("job-2", join(root, "other"))).rejects.toThrow(
      "work path is not owned by job",
    );
    await work.cleanupStale("job-2");
  });

  it("rejects path traversal job identifiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "echohoard-work-"));
    await expect(new LocalJobWork(root).prepare("../escape")).rejects.toThrow(
      "invalid job identifier",
    );
  });
});
