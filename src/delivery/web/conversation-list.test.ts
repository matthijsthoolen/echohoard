import { describe, expect, it, vi } from "vitest";
import { fetchConversationPage, parseConversationPage } from "./components/conversation-list";

const page = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("conversation list delivery contract", () => {
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
