const valueFor = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const quality = valueFor("--quality");
const sha = valueFor("--sha");
const tag = valueFor("--tag");

if (!/^[a-f0-9]{40}$/.test(sha ?? "") || !/^v\d+\.\d+\.\d+$/.test(tag ?? "")) {
  console.error(
    "Usage: node scripts/release-dry-run.mjs --quality passed|failed --sha <40 hex> --tag vMAJOR.MINOR.PATCH",
  );
  process.exit(2);
}

if (quality !== "passed") {
  console.error(`Release publication blocked: required quality gate is ${quality ?? "missing"}.`);
  process.exit(1);
}

console.log(`Release publication boundary reached (no push): ${tag} at ${sha}`);
