import { describe, expect, it, vi } from "vitest";
import {
  fetchArchiveOverview,
  overviewStateLabel,
  parseHealth,
  parseStatistics,
} from "./components/archive-overview";

const health = (state: string) => ({
  archiveId: "archive-1",
  state,
  freshness: state === "stale" ? "stale" : "fresh",
  snapshots: {},
  jobs: [],
  counts: {
    messages: 2_500_000,
    conversations: 12,
    people: 20,
    mediaReferenced: 100,
    mediaAvailable: state === "warning" ? 80 : 100,
    unsupported: state === "unsupported" ? 4 : 0,
  },
  media: { referenced: 100, available: 80, missing: 20, unsafe: 0, unresolved: 0 },
  unsupportedTypes: [],
  failures:
    state === "failed" ? [{ code: "IMPORT_FAILURE", message: "secret", retryable: true }] : [],
});

const statistics = {
  archiveId: "archive-1",
  range: { bucket: "day" },
  totals: { messages: 2_500_000, conversations: 12, people: 20, media: 100 },
  mediaByTypeAndState: [],
  direction: { sent: 1_000_000, received: 1_499_999, unknown: 1 },
  activity: [],
  mostActiveConversations: [],
};

describe("archive overview delivery", () => {
  it("labels every health state with an explicit user-facing status", () => {
    expect(
      ["healthy", "warning", "failed", "empty", "in-progress", "stale", "unsupported"].map(
        overviewStateLabel,
      ),
    ).toEqual([
      "Healthy",
      "Needs attention",
      "Import failed",
      "No messages yet",
      "Import in progress",
      "Archive is stale",
      "Unsupported data found",
    ]);
  });

  it("fetches both authenticated bounded reads and handles unauthorized", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBe("same-origin");
      return new Response(
        JSON.stringify(String(input).includes("statistics") ? statistics : health("healthy")),
      );
    });
    const result = await fetchArchiveOverview(fetcher, "/health", "/statistics");
    expect(result).not.toBe("unauthorized");
    if (result !== "unauthorized") expect(result.statistics.totals.messages).toBe(2_500_000);
    await expect(
      fetchArchiveOverview(vi.fn(async () => new Response("denied", { status: 401 }))),
    ).resolves.toBe("unauthorized");
  });

  it("keeps hostile diagnostics out of the rendered contract and preserves large counts", () => {
    const parsedHealth = parseHealth(health("failed"));
    expect(parsedHealth.counts.messages).toBe(2_500_000);
    expect(parsedHealth.failures[0]).toEqual({
      code: "IMPORT_FAILURE",
      message: "Import requires attention.",
      retryable: false,
    });
    expect(JSON.stringify(parsedHealth)).not.toContain("secret");
    expect(parseHealth(health("empty")).state).toBe("empty");
    expect(parseHealth(health("in-progress")).state).toBe("in-progress");
    expect(parseHealth(health("stale")).freshness).toBe("stale");
    expect(parseHealth(health("unsupported")).state).toBe("unsupported");
    expect(parseStatistics(statistics).direction.unknown).toBe(1);
  });
});
