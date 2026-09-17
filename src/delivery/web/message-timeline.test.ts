import { describe, expect, it, vi } from "vitest";
import type { MessageRead } from "../../application/reads.js";
import {
  emptyTimeline,
  compareMessages,
  fetchMessagePage,
  MAX_RETAINED_MESSAGES,
  mergeTimelinePage,
  parseMessagePage,
  parseGroupingState,
  virtualRange,
} from "./components/message-timeline";

const message = (id: string, sentAt: string, text = id): MessageRead => ({
  id,
  conversationId: "conversation-1",
  sentAt,
  text,
  attachmentCount: 0,
  direction: "received",
  messageType: "text",
  revisions: [],
  reactions: [],
});

describe("virtual message timeline", () => {
  it("merges adjacent pages by stable ID without duplicate or skipped messages", () => {
    const newest = mergeTimelinePage(
      emptyTimeline,
      {
        items: [message("m3", "2026-01-03"), message("m2", "2026-01-02")],
        nextCursor: "older",
        hasMore: true,
      },
      "backward",
    );
    const withOlder = mergeTimelinePage(
      newest,
      {
        items: [message("m2", "2026-01-02"), message("m1", "2026-01-01")],
        nextCursor: "oldest",
        hasMore: false,
      },
      "backward",
    );
    const withNewer = mergeTimelinePage(
      withOlder,
      {
        items: [message("m3", "2026-01-03"), message("m4", "2026-01-04")],
        nextCursor: "newer",
        hasMore: false,
      },
      "forward",
    );
    expect(withNewer.messages.map(({ id }) => id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(new Set(withNewer.messages.map(({ id }) => id)).size).toBe(4);
    expect(withNewer.olderCursor).toBe("oldest");
    expect(withNewer.newerCursor).toBe("newer");
  });

  it("keeps a bounded virtual range for a 150,000-message conversation", () => {
    const range = virtualRange(150_000, 6_000_000, 600);
    expect(range.end - range.start).toBeLessThan(30);
    expect(range.start).toBeGreaterThan(0);
  });

  it("caps retained rows while walking a large chat", () => {
    const existing = Array.from({ length: MAX_RETAINED_MESSAGES }, (_, index) =>
      message(`m${index + 1000}`, `2026-01-${String((index % 28) + 1).padStart(2, "0")}`),
    );
    const state = mergeTimelinePage(
      { ...emptyTimeline, messages: existing },
      { items: [message("m1", "2025-01-01")], nextCursor: "older", hasMore: true },
      "backward",
    );
    expect(state.messages).toHaveLength(MAX_RETAINED_MESSAGES);
    expect(state.messages[0]?.id).toBe("m1");
  });

  it("rejects hostile or malformed message payloads before rendering", () => {
    expect(() =>
      parseMessagePage({
        items: [
          {
            ...message("x", "2026-01-01"),
            text: "<img src=x onerror=alert(1)>",
          },
        ],
        hasMore: false,
      }),
    ).not.toThrow();
    expect(() =>
      parseMessagePage({
        items: [{ ...message("x", "2026-01-01"), direction: "evil" }],
        hasMore: false,
      }),
    ).toThrow("invalid message");
    expect(() =>
      parseMessagePage({
        items: [{ ...message("x", "2026-01-01"), text: "x".repeat(16_001) }],
        hasMore: false,
      }),
    ).toThrow("invalid message text");
  });

  it("requests bounded pages in both directions and preserves the signed cursor", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("limit=50");
      expect(String(input)).toContain("cursor=signed.cursor");
      expect(String(input)).toContain("direction=forward");
      return new Response(JSON.stringify({ items: [message("m4", "2026-01-04")], hasMore: false }));
    });
    await expect(
      fetchMessagePage(fetcher, "chat/one", "forward", "signed.cursor"),
    ).resolves.toEqual({
      items: [message("m4", "2026-01-04")],
      hasMore: false,
    });
  });

  it("preserves a privacy folder mode while fetching timeline pages", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("mode=locked");
      return new Response(JSON.stringify({ items: [], hasMore: false }));
    });
    await expect(
      fetchMessagePage(fetcher, "chat/one", "backward", undefined, undefined, "locked"),
    ).resolves.toEqual({ items: [], hasMore: false });
  });

  it("keeps exact source IDs separate from unified conversation IDs", () => {
    const state = parseGroupingState({
      targetConversationId: "unified-id",
      version: 2,
      sources: [
        {
          id: "source-id",
          title: "same-jid",
          accountLabel: "Account A",
          sourceNamespace: "backup",
          sourceConversationKey: "same-jid",
          unifiedConversationId: "unified-id",
        },
      ],
      currentSourceIds: ["source-id"],
      mergeSourceIds: ["source-id"],
      mergeAuditId: "audit-id",
    });
    expect(state.targetConversationId).toBe("unified-id");
    expect(state.sources[0]?.id).toBe("source-id");
    expect(state.sources[0]?.id).not.toBe(state.sources[0]?.unifiedConversationId);
  });

  it("orders equal-timestamp messages deterministically by message ID", () => {
    expect(compareMessages(message("b", "2026-01-01"), message("a", "2026-01-01"))).toBeGreaterThan(
      0,
    );
  });
});
