import { describe, expect, it, vi } from "vitest";
import { ArchiveReadService, CursorCodec, type ReadPersistencePort } from "./reads.js";

const port = (rows: {
  conversations?: any[];
  people?: any[];
  messages?: any[];
  search?: any[];
}): ReadPersistencePort => ({
  listConversations: async (q) =>
    (rows.conversations ?? [])
      .filter(
        (r) =>
          !q.after || r.createdAt > q.after[0] || (r.createdAt === q.after[0] && r.id > q.after[1]),
      )
      .slice(0, q.limit),
  listPeople: async (q) =>
    (rows.people ?? [])
      .filter(
        (r) =>
          !q.after ||
          r.displayName > q.after[0] ||
          (r.displayName === q.after[0] && r.id > q.after[1]),
      )
      .slice(0, q.limit),
  listMessages: async (q) =>
    (rows.messages ?? [])
      .filter((r) => r.archiveId === undefined || r.archiveId === q.archiveId)
      .filter(
        (r) =>
          r.conversationId === q.conversationId &&
          (!q.after || r.sentAt > q.after[0] || (r.sentAt === q.after[0] && r.id > q.after[1])),
      )
      .slice(0, q.limit),
  searchMessages: async (q) =>
    (rows.search ?? [])
      .filter((r) => r.archiveId === undefined || r.archiveId === q.archiveId)
      .filter(
        (r) =>
          !q.after ||
          r.score < q.after[0] ||
          (r.score === q.after[0] &&
            (r.sortSentAt > q.after[1] ||
              (r.sortSentAt === q.after[1] && r.id > q.after[2]))),
      )
      .slice(0, q.limit),
});

describe("archive read services", () => {
  const codec = new CursorCodec("read-test-secret");

  it("returns bounded conversations and a usable cursor", async () => {
    const service = new ArchiveReadService(
      port({
        conversations: [
          { id: "a", title: "A", participantCount: 1, createdAt: "2026-01-01T00:00:00.000Z" },
          { id: "b", title: "B", participantCount: 2, createdAt: "2026-01-02T00:00:00.000Z" },
        ],
      }),
      codec,
    );
    const first = await service.listConversations({ archiveId: "archive-a", limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    expect(
      (
        await service.listConversations({
          archiveId: "archive-a",
          limit: 1,
          cursor: first.nextCursor,
        })
      ).items[0]?.id,
    ).toBe("b");
  });

  it("rejects a cursor for a different read kind", async () => {
    const cursor = codec.encode({
      archiveId: "archive-a",
      direction: "forward",
      sort: "sentAt,id",
      values: ["2026-01-01", "m1"],
    });
    await expect(
      new ArchiveReadService(port({}), codec).listPeople({ archiveId: "archive-a", cursor }),
    ).rejects.toThrow("Invalid or expired cursor");
  });

  it("cannot read a conversation from another archive", async () => {
    const service = new ArchiveReadService(
      port({
        messages: [
          {
            id: "m",
            archiveId: "archive-a",
            conversationId: "conversation-a",
            sentAt: "2026-01-01T00:00:00.000Z",
            attachmentCount: 0,
          },
        ],
      }),
      codec,
    );
    expect(
      (await service.listMessages({ archiveId: "archive-b", conversationId: "conversation-a" }))
        .items,
    ).toEqual([]);
  });

  it("returns bounded ranked message matches and a stable cursor", async () => {
    const service = new ArchiveReadService(
      port({
        search: [
          { id: "m1", score: 0.9, sortSentAt: "2026-01-01T00:00:00.000Z" },
          { id: "m2", score: 0.4, sortSentAt: "2026-01-02T00:00:00.000Z" },
        ],
      }),
      codec,
    );
    const first = await service.search({ archiveId: "archive-a", query: "needle", limit: 1 });
    expect(first.items).toEqual([{ id: "m1", kind: "message", score: 0.9 }]);
    expect(first.hasMore).toBe(true);
    expect(
      (
        await service.search({
          archiveId: "archive-a",
          query: "needle",
          limit: 1,
          cursor: first.nextCursor,
        })
      ).items[0]?.id,
    ).toBe("m2");
  });

  it("treats whitespace-only search as a deterministic empty page", async () => {
    const searchMessages = vi.fn(async () => []);
    const service = new ArchiveReadService(
      { ...port({}), searchMessages },
      codec,
    );
    await expect(service.search({ archiveId: "archive-a", query: "  " })).resolves.toEqual({
      items: [],
      hasMore: false,
    });
    expect(searchMessages).not.toHaveBeenCalled();
  });
});
