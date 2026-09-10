import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decryptCrypt15, DecryptError } from "./wa-crypt-tools";

const roots: string[] = [];

async function fixture(): Promise<{ encrypted: string; output: string; secret: string }> {
  const root = await mkdtemp(join(tmpdir(), "echohoard-wa-crypt-"));
  roots.push(root);
  const encrypted = join(root, "encrypted.db");
  const output = join(root, "decrypted.db");
  const secret = join(root, "key");
  await writeFile(encrypted, "encrypted");
  await writeFile(secret, "sentinel-key\n");
  return { encrypted, output, secret };
}

const nodeFixture = async (body: string) => {
  const root = await mkdtemp(join(tmpdir(), "echohoard-wa-command-"));
  roots.push(root);
  const command = join(root, "command.cjs");
  await writeFile(command, `#!/usr/bin/env node\n${body}`);
  await chmod(command, 0o755);
  return command;
};

afterEach(async () => {
  // Temporary files are confined to unique OS directories; test runners clean them up.
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("decryptCrypt15", () => {
  it("rejects a missing and an empty key", async () => {
    const f = await fixture();
    await expect(
      decryptCrypt15(f.encrypted, f.output, join(f.secret, "missing")),
    ).rejects.toMatchObject({ kind: "io" });
    await writeFile(f.secret, " \n");
    await expect(decryptCrypt15(f.encrypted, f.output, f.secret)).rejects.toMatchObject({
      kind: "invalid-key",
    });
  });

  it("rejects encrypted input over the configured limit", async () => {
    const f = await fixture();
    await expect(
      decryptCrypt15(f.encrypted, f.output, f.secret, { maxInputBytes: 1 }),
    ).rejects.toMatchObject({ kind: "io" });
  });

  it("classifies a nonzero command and redacts its output", async () => {
    const f = await fixture();
    const command = await nodeFixture(
      "process.stderr.write('bad sentinel-key key\\n'); process.exit(7);",
    );
    await expect(
      decryptCrypt15(f.encrypted, f.output, f.secret, { executable: command, timeoutMs: 1000 }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof DecryptError &&
        error.kind === "invalid-key" &&
        !error.message.includes("sentinel-key") &&
        error.message.includes("[REDACTED]")
      );
    });
  });

  it("reports timeout", async () => {
    const f = await fixture();
    const command = await nodeFixture("setTimeout(() => {}, 1000);");
    await expect(
      decryptCrypt15(f.encrypted, f.output, f.secret, { executable: command, timeoutMs: 10 }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("validates SQLite output headers", async () => {
    const f = await fixture();
    const command = await nodeFixture(
      "require('fs').writeFileSync(process.argv[4], Buffer.from('not sqlite'));",
    );
    await expect(
      decryptCrypt15(f.encrypted, f.output, f.secret, { executable: command }),
    ).rejects.toMatchObject({ kind: "unsupported-format" });
    const valid = await nodeFixture(
      "require('fs').writeFileSync(process.argv[4], Buffer.concat([Buffer.from('SQLite format 3\\0'), Buffer.alloc(32)]));",
    );
    const success = await decryptCrypt15(f.encrypted, f.output, f.secret, { executable: valid });
    expect(success).toEqual({ outputPath: f.output, bytes: 48 });
  });
});
