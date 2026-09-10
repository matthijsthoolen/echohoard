import { readdirSync, readFileSync } from "node:fs";

const rules = [
  [/src\/domain\//, /from ["'](?:.*\/(?:next|react|prisma)|node:)/],
  [/src\/application\//, /from ["'](?:.*\/(?:next|react|prisma)|node:fs|node:child_process)/],
];
const files = [];
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) visit(path);
    else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) files.push(path);
  }
}
visit("src");
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const [scope, forbidden] of rules)
    if (scope.test(file) && forbidden.test(text)) {
      console.error(`Forbidden dependency in ${file}`);
      process.exitCode = 1;
    }
}
