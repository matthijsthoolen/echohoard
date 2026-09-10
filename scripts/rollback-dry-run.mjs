const valueFor = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const current = valueFor("--current");
const previous = valueFor("--previous");
const digest = /^sha256:[a-f0-9]{64}$/;
if (!digest.test(current ?? "") || !digest.test(previous ?? "")) {
  console.error(
    "Usage: node scripts/rollback-dry-run.mjs --current sha256:<64 hex> --previous sha256:<64 hex>",
  );
  process.exit(2);
}
if (current === previous) {
  console.error("Current and previous digests must be different.");
  process.exit(2);
}

console.log("Rollback dry run (no registry or deployment mutation)");
console.log(`current:  ${current}`);
console.log(`previous: ${previous}`);
console.log("would verify: docker buildx imagetools inspect <registry>/echohoard@" + previous);
console.log("would pin:    <deployment-manifest>.image = <registry>/echohoard@" + previous);
console.log("would retain: current digest and its matching SBOM for forward rollback");
