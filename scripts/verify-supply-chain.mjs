import { readFile } from "node:fs/promises";

const root = new URL("..", import.meta.url);
const readJson = async (name) => JSON.parse(await readFile(new URL(name, root), "utf8"));
const packageJson = await readJson("package.json");
const sbom = await readJson("docs/supply-chain/echohoard.cdx.json");
const pins = await readJson("docs/supply-chain/upstream-pins.json");
const lock = await readFile(new URL("pnpm-lock.yaml", root), "utf8");
const requirements = await readFile(new URL("container/worker-requirements.txt", root), "utf8");

const releaseMode = process.argv.includes("--release");
const components = new Map(sbom.components.map((component) => [component.name, component]));
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

check(sbom.bomFormat === "CycloneDX" && sbom.specVersion === "1.5", "SBOM must be CycloneDX 1.5");
check(
  sbom.metadata?.component?.name === packageJson.name,
  "SBOM application name does not match package.json",
);
check(
  sbom.metadata?.component?.licenses?.[0]?.license?.id === "NOASSERTION",
  "application license must remain an explicit NOASSERTION decision",
);

for (const [name, version] of Object.entries(packageJson.dependencies)) {
  check(
    version === version.trim() && /^[0-9]/.test(version),
    `runtime dependency ${name} is not exact-pinned`,
  );
  const component = components.get(name);
  check(
    component?.version === version,
    `SBOM is missing exact runtime dependency ${name}@${version}`,
  );
  const lockEntry = `${name}@${version}`;
  check(
    lock.includes(`'${lockEntry}':`) || lock.includes(`  ${lockEntry}:`),
    `pnpm lockfile has no ${name}@${version} package entry`,
  );
  check(
    component?.properties?.some(({ name: property }) => property === "pnpm-integrity"),
    `SBOM has no pnpm integrity for ${name}`,
  );
}

const requirementLines = requirements
  .replaceAll(/\\\s*\r?\n/g, " ")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .filter((line) => !line.startsWith("#"));
const requirementPattern =
  /^([A-Za-z0-9][A-Za-z0-9._-]*)==([0-9][^ ]*)\s+--hash=sha256:([a-f0-9]{64})$/;
check(
  requirementLines.length === 4,
  "worker requirements must contain the four pinned dependencies",
);
for (const line of requirementLines) {
  const match = requirementPattern.exec(line);
  check(Boolean(match), `worker requirement is not exact and hash-pinned: ${line}`);
  if (!match) continue;
  const [, name, version, hash] = match;
  const component = components.get(name);
  check(
    component?.version === version,
    `SBOM is missing exact Python dependency ${name}==${version}`,
  );
  check(
    component?.properties?.some(
      ({ name: property, value }) => property === "sha256" && value === hash,
    ),
    `SBOM hash mismatch for ${name}`,
  );
}

check(
  pins.waCryptTools?.license === "GPL-3.0-only",
  "wa-crypt-tools GPL-3.0-only attribution is required",
);
for (const image of pins.baseImages ?? []) {
  check(
    typeof image.reference === "string" && image.reference.includes(":"),
    `base image ${image.name} has no version tag`,
  );
  if (releaseMode)
    check(
      /^sha256:[a-f0-9]{64}$/.test(image.digest ?? ""),
      `${image.name} has no immutable release digest`,
    );
}

if (failures.length) {
  console.error("Supply-chain verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Supply-chain verification passed${releaseMode ? " (release mode)" : ""}.`);
  console.log(
    `SBOM components: ${sbom.components.length}; hashed Python artifacts: ${requirementLines.length}.`,
  );
  if (!releaseMode) console.log("Release mode additionally requires immutable base-image digests.");
}
