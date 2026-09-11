import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = join(root, "src");
const rules = {
  delivery: ["application", "domain"],
  worker: ["application", "domain", "config"],
  application: ["domain"],
  infrastructure: ["application", "domain", "config"],
  adapters: ["application", "domain", "config"],
  domain: [],
  config: [],
};
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const ignored = new Set([".next", "dist", "node_modules"]);
  return (
    await Promise.all(
      entries.map(async (entry) => {
        if (ignored.has(entry.name)) return [];
        const path = join(dir, entry.name);
        return entry.isDirectory()
          ? walk(path)
          : /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".tsbuildinfo")
            ? [path]
            : [];
      }),
    )
  ).flat();
}
function imports(text) {
  return [...text.matchAll(/(?:import|export)\s+(?:type\s+)?[^;]*?from\s+["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
}
function destination(from, specifier) {
  if (!specifier.startsWith(".")) return null;
  return relative(src, join(from, specifier)).split(sep)[0] || null;
}
const errors = [];
const fixtureMode = process.argv.includes("--fixture");
for (const file of await walk(src)) {
  const from = relative(src, file).split(sep)[0];
  for (const specifier of imports(await readFile(file, "utf8"))) {
    const to = destination(join(file, ".."), specifier);
    // Composition roots are intentional assembly points where a role combines
    // infrastructure adapters with application services. Runtime modules
    // remain constrained to the dependency direction above.
    const compositionRoot =
      ["delivery", "worker"].includes(from) && file.endsWith(`${sep}composition.ts`);
    if (
      to &&
      to !== from &&
      !rules[from]?.includes(to) &&
      !(compositionRoot && ["infrastructure", "config"].includes(to))
    )
      errors.push(
        `${relative(root, file)} imports ${to}; ${from} may depend only on ${rules[from]?.join(", ") || "nothing"}`,
      );
  }
}
const fixture = await readFile(join(root, "fixtures/architecture/forbidden-domain.ts"), "utf8");
if (!imports(fixture).some((specifier) => specifier.includes("src/config")))
  errors.push("forbidden fixture no longer demonstrates a domain -> config import");
if (fixtureMode) {
  const fixtureImports = imports(fixture);
  if (fixtureImports.some((specifier) => specifier.includes("src/config")))
    errors.push(
      "fixtures/architecture/forbidden-domain.ts imports config; domain may depend only on nothing",
    );
}
if (errors.length) {
  console.error("Architecture violations:\n" + errors.join("\n"));
  process.exit(1);
}
console.log(
  "Architecture source check passed (including forbidden-import fixture).\nAllowed delivery -> application direction verified.",
);
