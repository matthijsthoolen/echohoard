import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const release = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");
const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const dryRun = resolve(root, "scripts/release-dry-run.mjs");
const sha = "0123456789abcdef0123456789abcdef01234567";

describe("tagged release workflow", () => {
  it("requires the reusable quality workflow and exact tagged SHA before the push boundary", () => {
    expect(ci).toContain("workflow_call:");
    expect(release).toContain("uses: ./.github/workflows/ci.yml");
    expect(release).toContain("needs: [quality, supply-chain]");
    expect(release).toContain("ref: ${{ github.sha }}");
    expect(release).toContain('git rev-parse "${GITHUB_REF_NAME}^{commit}"');

    const pushBoundary = release.indexOf("push: true");
    expect(pushBoundary).toBeGreaterThan(release.indexOf("needs: [quality, supply-chain]"));
    expect(release.slice(0, pushBoundary)).toContain("pnpm supply-chain:verify -- --release");
  });

  it("preserves provenance, SBOM, immutable tags, and commit metadata", () => {
    expect(release).toContain("provenance: true");
    expect(release).toContain("sbom: true");
    expect(release).toContain("type=sha,format=long");
    expect(release).toContain('"commit":"%s"');
    expect(release).toContain("GITHUB_SHA");
  });

  it("reaches the no-push boundary when quality succeeds", () => {
    const output = execFileSync(
      process.execPath,
      [dryRun, "--quality", "passed", "--sha", sha, "--tag", "v1.2.3"],
      {
        encoding: "utf8",
      },
    );
    expect(output).toContain("boundary reached (no push)");
    expect(output).toContain(sha);
  });

  it("blocks publication when quality fails", () => {
    const result = spawnSync(
      process.execPath,
      [dryRun, "--quality", "failed", "--sha", sha, "--tag", "v1.2.3"],
      {
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("publication blocked");
    expect(result.stdout).toBe("");
  });
});
