import { describe, expect, it } from "vitest";
import {
  ArchiveStatisticsService,
  MAX_STATISTICS_LIMIT,
  type StatisticsPersistenceInput,
} from "./statistics.js";

const result = {
  totals: { messages: 4, conversations: 2, people: 3, media: 2 },
  mediaByTypeAndState: [{ type: "image" as const, availability: "available" as const, count: 1 }],
  direction: { sent: 2, received: 1, unknown: 1 },
  activity: [{ bucketStart: "2026-01-01T00:00:00.000Z", count: 4 }],
  mostActiveConversations: [{ conversationId: "conversation-a", messageCount: 4 }],
};

describe("archive statistics service", () => {
  it("normalizes a bounded UTC range and preserves deterministic result contracts", async () => {
    let received: StatisticsPersistenceInput | undefined;
    const service = new ArchiveStatisticsService({
      getStatistics: async (input) => {
        received = input;
        return result;
      },
    });
    await expect(
      service.getStatistics({
        archiveId: "archive-a",
        from: "2026-01-01T00:00:00+02:00",
        to: "2026-01-02T00:00:00+02:00",
        bucket: "week",
        limit: 10,
      }),
    ).resolves.toEqual({
      archiveId: "archive-a",
      range: {
        from: "2025-12-31T22:00:00.000Z",
        to: "2026-01-01T22:00:00.000Z",
        bucket: "week",
      },
      ...result,
    });
    expect(received).toEqual({
      archiveId: "archive-a",
      from: "2025-12-31T22:00:00.000Z",
      to: "2026-01-01T22:00:00.000Z",
      bucket: "week",
      limit: 10,
    });
  });

  it.each([
    [{ archiveId: "" }, "archiveId is required"],
    [{ archiveId: "archive-a", from: "bad-date" }, "from must be a valid ISO timestamp"],
    [
      { archiveId: "archive-a", from: "2026-01-02", to: "2026-01-01" },
      "from must be earlier than to",
    ],
    [{ archiveId: "archive-a", bucket: "hour" }, "bucket is invalid"],
    [
      { archiveId: "archive-a", limit: MAX_STATISTICS_LIMIT + 1 },
      `limit must be an integer from 1 to ${MAX_STATISTICS_LIMIT}`,
    ],
  ] as const)("rejects invalid input", async (query, error) => {
    await expect(
      new ArchiveStatisticsService({ getStatistics: async () => result }).getStatistics(query),
    ).rejects.toThrow(error);
  });
});
