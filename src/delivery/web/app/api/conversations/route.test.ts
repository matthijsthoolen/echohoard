import { describe, expect, it, vi } from "vitest";
import type { ArchivePrincipal } from "../../../../../application/auth";
import type { ConversationRead } from "../../../../../application/reads";
import { createConversationsRoute } from "./route-handler";

const principal: ArchivePrincipal = {
  userId: "user-1",
  archiveId: "archive-1",
  issuer: "https://issuer.example",
  subject: "owner",
};

const auth = { principalForRequest: () => principal };

describe("conversation route", () => {
  it("denies requests without a configured runtime or principal", async () => {
    const route = createConversationsRoute({ getRuntime: () => undefined });
    expect((await route(new Request("http://localhost/api/conversations"))).status).toBe(401);

    const denied = createConversationsRoute({
      getRuntime: () =>
        ({
          auth: { principalForRequest: () => null },
          reads: { listConversations: vi.fn() },
        }) as never,
    });
    expect((await denied(new Request("http://localhost/api/conversations"))).status).toBe(401);
  });

  it("uses only the principal archive and bounded pagination service", async () => {
    const listConversations = vi.fn(
      async (): Promise<{
        items: readonly ConversationRead[];
        hasMore: boolean;
        nextCursor: string;
      }> => ({
        items: [{ id: "c1", title: "Family", participantCount: 3 }],
        hasMore: true,
        nextCursor: "signed.next",
      }),
    );
    const route = createConversationsRoute({
      getRuntime: () => ({ auth, reads: { listConversations } }),
    });
    const response = await route(
      new Request("http://localhost/api/conversations?limit=2&cursor=signed.previous"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [{ id: "c1", title: "Family", participantCount: 3 }],
      hasMore: true,
      nextCursor: "signed.next",
    });
    expect(listConversations).toHaveBeenCalledWith({
      archiveId: "archive-1",
      limit: 2,
      cursor: "signed.previous",
    });
  });

  it("rejects an unbounded page before calling the read service", async () => {
    const listConversations = vi.fn();
    const route = createConversationsRoute({
      getRuntime: () => ({ auth, reads: { listConversations } }),
    });
    const response = await route(new Request("http://localhost/api/conversations?limit=1000"));
    expect(response.status).toBe(400);
    expect(listConversations).not.toHaveBeenCalled();
  });

  it("sanitizes service failures", async () => {
    const route = createConversationsRoute({
      getRuntime: () => ({
        auth,
        reads: {
          listConversations: vi.fn(async () => {
            throw new Error("database secret");
          }),
        },
      }),
    });
    const response = await route(new Request("http://localhost/api/conversations"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Conversation list unavailable" });
  });
});
