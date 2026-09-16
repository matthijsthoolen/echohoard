import { readFileSync } from "node:fs";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const release = readFileSync(".github/workflows/release.yml", "utf8");
const aggregate = readFileSync("scripts/test-production-seams.sh", "utf8");
const required = [
  "test:functional",
  "test:entrypoint",
  "test:wacli-sidecar",
  "test:container",
  "test:compose-lifecycle",
  "test:container-acceptance",
  "test:viewer",
  "test:mcp-transport",
];
for (const command of required) {
  if (!aggregate.includes(command))
    throw new Error(`Aggregate is missing required seam: ${command}`);
}
for (const marker of ["coverage", "actions/upload-artifact@v4", "workflow_call:"]) {
  if (!ci.includes(marker)) throw new Error(`CI is missing required contract: ${marker}`);
}
if (!ci.includes("integration-seams") || !ci.includes("needs: [static, unit,")) {
  throw new Error("quality does not require every integration seam");
}
if (!ci.includes("pnpm test:production-seams")) {
  throw new Error("CI does not run the production seam aggregate");
}
if (!release.includes("uses: ./.github/workflows/ci.yml")) {
  throw new Error("release does not consume the required CI workflow");
}
console.log("CI workflow validation passed: required seams, coverage, and release reuse");
