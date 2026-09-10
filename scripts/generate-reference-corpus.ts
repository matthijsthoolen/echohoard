import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CI_CORPUS,
  FULL_CORPUS,
  corpusRecords,
} from "../src/infrastructure/corpus/reference-corpus.js";

const full = process.argv.includes("--full");
const config = full ? FULL_CORPUS : CI_CORPUS;
const output = resolve(
  process.argv[process.argv.indexOf("--output") + 1] || "fixtures/reference-corpus.jsonl",
);
await mkdir(resolve(output, ".."), { recursive: true });
const stream = createWriteStream(output, { encoding: "utf8" });
for (const record of corpusRecords(config)) {
  if (!stream.write(`${JSON.stringify(record)}\n`))
    await new Promise<void>((resolvePromise) => stream.once("drain", resolvePromise));
}
await new Promise<void>((resolvePromise, reject) => {
  stream.end(resolvePromise);
  stream.on("error", reject);
});
console.log(JSON.stringify({ output, ...config }));
