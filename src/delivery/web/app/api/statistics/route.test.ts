import { describe, expect, it, vi } from "vitest";
import type { ArchivePrincipal } from "../../../../../application/auth";
import type { ArchiveStatisticsRead } from "../../../../../application/statistics";
import { createStatisticsRoute } from "./route-handler";

const principal: ArchivePrincipal = {
  userId: "user-1",
  archiveId: "archive-1",
  issuer: "https://issuer.example",
  subject: "owner",
};

const statistics: ArchiveStatisticsRead = {
  archiveId: "archive-1",
  range: { bucket: "day" },
  totals: { messages: 2, conversations: 1, people: 2, media: 0 },
  mediaByTypeAndState: [],
  direction: { sent: 1, received: 1, unknown: 0 },
  activity: [],
  mostActiveConversations: [],
};

describe("archive statistics route", () => {
  it("requires authentication and a configured service", async () => {
    expect(
      (await createStatisticsRoute({ getRuntime: () => undefined })(new Request("http://x")))
        .status,
    ).toBe(401);
    expect(
      (
        await createStatisticsRoute({
          getRuntime: () => ({ auth: { principalForRequest: async () => principal }, reads: {} }),
        })(new Request("http://x"))
      ).status,
    ).toBe(503);
  });

  it("uses only the session archive and keeps responses private", async () => {
    const archiveStatistics = vi.fn(async () => statistics);
    const response = await createStatisticsRoute({
      getRuntime: () => ({
        auth: { principalForRequest: async () => principal },
        reads: { archiveStatistics },
      }),
    })(new Request("http://x/api/statistics?archiveId=other"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(statistics);
    expect(archiveStatistics).toHaveBeenCalledWith({ archiveId: "archive-1" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("redacts service failures", async () => {
    const response = await createStatisticsRoute({
      getRuntime: () => ({
        auth: { principalForRequest: async () => principal },
        reads: {
          archiveStatistics: vi.fn(async () => {
            throw new Error("secret /path and message body");
          }),
        },
      }),
    })(new Request("http://x"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Archive statistics unavailable" });
  });
});
