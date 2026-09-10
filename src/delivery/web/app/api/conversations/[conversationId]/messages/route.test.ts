import { describe, expect, it, vi } from "vitest";
import type { ArchivePrincipal } from "../../../../../../../application/auth";
import type { MessageRead } from "../../../../../../../application/reads";
import { createMessagesRoute } from "./route-handler";

const principal: ArchivePrincipal = {
  userId: "user-1",
  archiveId: "archive-1",
  issuer: "https://issuer.example",
  subject: "owner",
};
const auth = { principalForRequest: () => principal };
const row: MessageRead = {
  id: "message-1",
  conversationId: "conversation-1",
  sentAt: "2026-01-01T00:00:00.000Z",
  text: "safe text",
  attachmentCount: 0,
  direction: "sent",
  messageType: "text",
  revisions: [],
  reactions: [],
};

describe("message timeline route", () => {
  it("denies anonymous access without revealing the conversation", async () => {
    const route = createMessagesRoute({
      getRuntime: () => ({
        auth: { principalForRequest: () => null },
        reads: { listMessages: vi.fn() },
      }),
    });
    const response = await route(new Request("http://localhost/api/conversations/c1/messages"), {
      params: { conversationId: "c1" },
    });
    expect(response.status).toBe(401);
  });

  it("uses the authenticated archive, stable conversation ID, direction, and bounded cursor", async () => {
    const listMessages = vi.fn(
      async (): Promise<{
        items: readonly MessageRead[];
        hasMore: boolean;
        nextCursor: string;
      }> => ({
        items: [row],
        hasMore: true,
        nextCursor: "next.signed",
      }),
    );
    const route = createMessagesRoute({ getRuntime: () => ({ auth, reads: { listMessages } }) });
    const response = await route(
      new Request(
        "http://localhost/api/conversations/chat-1/messages?limit=2&direction=forward&cursor=before.signed",
      ),
      { params: Promise.resolve({ conversationId: "chat-1" }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [row],
      hasMore: true,
      nextCursor: "next.signed",
    });
    expect(listMessages).toHaveBeenCalledWith({
      archiveId: "archive-1",
      conversationId: "chat-1",
      limit: 2,
      direction: "forward",
      cursor: "before.signed",
    });
  });

  it("rejects unbounded and invalid direction requests before calling reads", async () => {
    const listMessages = vi.fn();
    const route = createMessagesRoute({ getRuntime: () => ({ auth, reads: { listMessages } }) });
    const tooLarge = await route(
      new Request("http://localhost/api/conversations/c1/messages?limit=101"),
      {
        params: { conversationId: "c1" },
      },
    );
    const invalidDirection = await route(
      new Request("http://localhost/api/conversations/c1/messages?direction=sideways"),
      {
        params: { conversationId: "c1" },
      },
    );
    expect(tooLarge.status).toBe(400);
    expect(invalidDirection.status).toBe(400);
    expect(listMessages).not.toHaveBeenCalled();
  });
});
