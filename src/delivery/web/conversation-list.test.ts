import { describe, expect, it, vi } from "vitest";
import {
  conversationHref,
  conversationAriaLabel,
  fetchConversationPage,
  parseConversationPage,
} from "./components/conversation-list";

const page = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("conversation list delivery contract", () => {
  it.each([
    ["ordinary", "/?view=chats&conversation=private-chat"],
    ["hidden", "/?view=hidden&conversation=private-chat"],
    ["locked", "/?view=locked&conversation=private-chat"],
  ] as const)("keeps %s folder context when opening a conversation", (mode, expected) => {
    expect(conversationHref("private-chat", mode)).toBe(expected);
  });

  it("keeps folder context stable for back and refresh navigation", () => {
    const first = conversationHref("private-chat", "hidden");
    const restored = conversationHref("private-chat", "hidden");
    expect(restored).toBe(first);
    expect(restored).not.toContain("view=chats");
  });

  it("uses contextual accessible labels for privacy folder entries", () => {
    expect(conversationAriaLabel("Quiet chat", "hidden")).toBe("Open Quiet chat in hidden chats");
    expect(conversationAriaLabel("Secret chat", "locked")).toBe("Open Secret chat in locked chats");
  });

  it("requests a bounded page and handles an authenticated empty archive", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/archive/conversations?limit=50");
      expect(init?.credentials).toBe("same-origin");
      return page({ items: [], hasMore: false });
    });
    await expect(
      fetchConversationPage(fetcher, undefined, "/archive/conversations"),
    ).resolves.toEqual({
      items: [],
      hasMore: false,
    });
  });

  it("recognizes auth denial without exposing archive existence", async () => {
    const fetcher = vi.fn(async () => page({ error: "Authentication required" }, 401));
    await expect(fetchConversationPage(fetcher)).resolves.toBe("unauthorized");
  });

  it("preserves a server cursor for the next bounded page", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/conversations?limit=50&cursor=next.signed");
      return page({
        items: [{ id: "c2", title: "Second", participantCount: 2 }],
        nextCursor: "later.signed",
        hasMore: true,
      });
    });
    await expect(fetchConversationPage(fetcher, "next.signed")).resolves.toEqual({
      items: [{ id: "c2", title: "Second", participantCount: 2 }],
      nextCursor: "later.signed",
      hasMore: true,
    });
  });

  it("rejects malformed source data instead of rendering it", () => {
    expect(() =>
      parseConversationPage({
        items: [{ id: "c1", title: "<script>", participantCount: "1" }],
        hasMore: false,
      }),
    ).toThrow("invalid conversation");
    expect(() =>
      parseConversationPage({
        items: [{ id: "c1", title: "Safe", participantCount: 1, lastMessageAt: "not-a-date" }],
        hasMore: false,
      }),
    ).not.toThrow();
  });
});
