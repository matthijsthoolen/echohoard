import { describe, expect, it, vi } from "vitest";
import {
  buildSearchRequestUrl,
  emptySearchFilters,
  fetchSearchPage,
  filtersFromSearchParams,
  parseSearchPage,
  resultContextHref,
  searchParamsFromFilters,
} from "./components/search-panel";

describe("bounded global search delivery", () => {
  it("round trips all filter state through safe URL parameters", () => {
    const filters = {
      ...emptySearchFilters,
      query: "<script> & needle",
      conversationId: "chat/one",
      personId: "person-1",
      direction: "received" as const,
      from: "2026-01-01T00:00",
      to: "2026-02-01T00:00",
      mediaType: "image" as const,
    };
    const restored = filtersFromSearchParams(searchParamsFromFilters(filters));
    expect(restored).toEqual(filters);
    const url = buildSearchRequestUrl(filters, "opaque.cursor", "/search");
    expect(url).toContain("q=%3Cscript%3E+%26+needle");
    expect(url).toContain("limit=50");
    expect(url).toContain("cursor=opaque.cursor");
    expect(url).not.toContain("SELECT");
  });

  it("fetches bounded pages, preserves cursors, and handles authorization denial", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/search?q=needle&limit=50&cursor=next");
      expect(init?.credentials).toBe("same-origin");
      return new Response(
        JSON.stringify({ items: [{ id: "m1", kind: "message" }], hasMore: false }),
      );
    });
    await expect(
      fetchSearchPage(fetcher, { ...emptySearchFilters, query: "needle" }, "next"),
    ).resolves.toEqual({
      items: [{ id: "m1", kind: "message" }],
      hasMore: false,
    });
    await expect(
      fetchSearchPage(vi.fn(async () => new Response("denied", { status: 403 }))),
    ).resolves.toBe("unauthorized");
  });

  it("rejects malformed result payloads and creates stable context anchors", () => {
    expect(() =>
      parseSearchPage({ items: [{ id: "m1", kind: "message", score: "bad" }], hasMore: false }),
    ).toThrow("invalid search score");
    expect(resultContextHref({ id: "m1", kind: "message", conversationId: "chat/1" })).toBe(
      "/?conversation=chat%2F1&message=m1#message-m1",
    );
  });
});
