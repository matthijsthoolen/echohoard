import { describe, expect, it } from "vitest";
import { classifyFreshness, classifyHealth, DEFAULT_HEALTH_THRESHOLDS } from "./health";

const now = new Date("2026-09-10T12:00:00.000Z");
const base = {
  now,
  latestCompletedSnapshotAt: new Date("2026-09-10T11:00:00.000Z"),
  importStatus: "completed" as const,
  messageCount: 10,
  mediaReferencedCount: 2,
  mediaAvailableCount: 2,
  unsupportedCount: 0,
};

describe("archive health classification", () => {
  it.each([
    ["healthy", {}],
    ["warning", { mediaAvailableCount: 1 }],
    ["failed", { importStatus: "failed" }],
    ["empty", { messageCount: 0 }],
    ["in-progress", { importStatus: "in-progress" }],
    ["stale", { latestCompletedSnapshotAt: new Date("2026-09-08T23:59:59.999Z") }],
    ["unsupported", { unsupportedCount: 1 }],
  ] as const)("returns %s", (state, changes) => {
    expect(classifyHealth({ ...base, ...changes }).state).toBe(state);
  });

  it("uses deterministic precedence when multiple conditions apply", () => {
    expect(
      classifyHealth({ ...base, importStatus: "failed", unsupportedCount: 2, messageCount: 0 })
        .state,
    ).toBe("failed");
    expect(
      classifyHealth({ ...base, importStatus: "in-progress", unsupportedCount: 2 }).state,
    ).toBe("in-progress");
    expect(classifyHealth({ ...base, unsupportedCount: 2, mediaAvailableCount: 0 }).state).toBe(
      "unsupported",
    );
  });

  it("changes only freshness when the threshold changes", () => {
    const defaultResult = classifyHealth(base);
    const shortResult = classifyHealth(base, { staleAfterMilliseconds: 30 * 60 * 1000 });
    expect(defaultResult.state).toBe("healthy");
    expect(shortResult.state).toBe("stale");
    expect(shortResult.counts).toEqual(defaultResult.counts);
  });

  it("treats the stale boundary as fresh and missing timestamps as unknown", () => {
    const atBoundary = new Date(now.getTime() - DEFAULT_HEALTH_THRESHOLDS.staleAfterMilliseconds);
    expect(classifyFreshness(atBoundary, now)).toBe("fresh");
    expect(classifyFreshness(undefined, now)).toBe("unknown");
  });

  it("redacts arbitrary diagnostics and never returns content, secrets, or paths", () => {
    const secret = "super-secret /private/archive/message.txt: hello message";
    const result = classifyHealth({
      ...base,
      importStatus: "failed",
      diagnostics: [
        { code: "INVALID_KEY", retryable: false },
        { code: "not-allowed", retryable: true },
        { code: secret, retryable: true },
      ],
    });
    expect(result.diagnostics).toEqual([
      {
        code: "INVALID_KEY",
        message: "The configured decryption key was rejected.",
        retryable: false,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("normalizes negative, fractional, invalid, and large counts safely", () => {
    const result = classifyHealth({
      ...base,
      messageCount: 5_000_000.9,
      mediaReferencedCount: -1,
      mediaAvailableCount: Number.NaN,
      unsupportedCount: Number.POSITIVE_INFINITY,
    });
    expect(result.counts).toEqual({
      messages: 5_000_000,
      mediaReferenced: 0,
      mediaAvailable: 0,
      unsupported: 0,
    });
  });

  it("rejects invalid freshness thresholds", () => {
    expect(() => classifyHealth(base, { staleAfterMilliseconds: -1 })).toThrow(RangeError);
    expect(() => classifyHealth(base, { staleAfterMilliseconds: Number.NaN })).toThrow(RangeError);
  });
});
