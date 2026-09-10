import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { allWhatsAppSqliteFixtures } from "../src/adapters/whatsapp/fixtures.js";

const outputDirectory = resolve("fixtures/whatsapp");
async function main(): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  for (const fixture of allWhatsAppSqliteFixtures()) {
    await writeFile(
      resolve(outputDirectory, `${fixture.name.replace(":", "-")}.sql`),
      fixture.sql,
      "utf8",
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
