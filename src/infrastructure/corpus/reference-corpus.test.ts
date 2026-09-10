import { describe, expect, it } from "vitest";
import { corpusDistribution, corpusRecords, CI_CORPUS } from "./reference-corpus.js";

describe("reference corpus", () => {
  it("produces the requested records across two archives", () => {
    const records = [...corpusRecords({ ...CI_CORPUS, messages: 20, attachments: 4 })];
    expect(records).toHaveLength(24);
    expect(new Set(records.map((record) => record.archive))).toEqual(new Set([0, 1]));
    expect(
      records
        .filter((record) => record.kind === "message")
        .every((record) => record.body?.startsWith("synthetic-")),
    ).toBe(true);
  });
  it("is reproducible for the same seed and changes with another seed", () => {
    expect(corpusDistribution(CI_CORPUS)).toBe(corpusDistribution(CI_CORPUS));
    expect(corpusDistribution(CI_CORPUS)).not.toBe(
      corpusDistribution({ ...CI_CORPUS, seed: CI_CORPUS.seed + 1 }),
    );
  });
});
