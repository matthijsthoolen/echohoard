import { describe, expect, it, vi } from "vitest";
import type { ArchivePrincipal } from "../../../../../application/auth";
import type { SearchResultRead } from "../../../../../application/reads";
import { createSearchRoute } from "./route-handler";

const principal: ArchivePrincipal = {
  userId: "user-1",
  archiveId: "archive-1",
  issuer: "https://issuer.example",
  subject: "owner",
};
const auth = { principalForRequest: () => principal };
const results: readonly SearchResultRead[] = [
  { id: "message-1", kind: "message", score: 0.9, conversationId: "chat-1", sentAt: "2026-01-01" },
];

describe("search route", () => {
  it("denies anonymous requests without revealing archive state", async () => {
    const route = createSearchRoute({ getRuntime: () => undefined });
    expect((await route(new Request("http://localhost/api/search?q=secret"))).status).toBe(401);
    const denied = createSearchRoute({
      getRuntime: () => ({ auth: { principalForRequest: () => null }, reads: { search: vi.fn() } }),
    });
    expect((await denied(new Request("http://localhost/api/search"))).status).toBe(401);
  });

  it("maps every supported filter and keeps the principal archive", async () => {
    const search = vi.fn(async () => ({
      items: results,
      hasMore: true,
      nextCursor: "signed.cursor",
    }));
    const route = createSearchRoute({ getRuntime: () => ({ auth, reads: { search } }) });
    const response = await route(
      new Request(
        "http://localhost/api/search?q=needle&conversation=chat-1&person=person-1&direction=received&from=2026-01-01&to=2026-02-01&media=image&name=Alice&text=hello&limit=2&cursor=previous",
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: results,
      hasMore: true,
      nextCursor: "signed.cursor",
    });
    expect(search).toHaveBeenCalledWith({
      archiveId: "archive-1",
      query: "needle",
      conversationId: "chat-1",
      personId: "person-1",
      senderDirection: "received",
      from: "2026-01-01",
      to: "2026-02-01",
      mediaType: "image",
      fuzzyName: "Alice",
      fuzzyText: "hello",
      limit: 2,
      direction: "forward",
      cursor: "previous",
    });
  });

  it.each([
    ["limit", "limit=101"],
    ["direction", "direction=wat"],
    ["media", "media=archive"],
    ["date", "from=not-a-date"],
    ["order", "from=2026-02-01&to=2026-01-01"],
  ])("rejects invalid %s before calling the service", async (_name, query) => {
    const search = vi.fn();
    const route = createSearchRoute({ getRuntime: () => ({ auth, reads: { search } }) });
    expect((await route(new Request(`http://localhost/api/search?${query}`))).status).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });

  it("sanitizes service failures and preserves no-store responses", async () => {
    const route = createSearchRoute({
      getRuntime: () => ({
        auth,
        reads: {
          search: vi.fn(async () => {
            throw new Error("secret SQL");
          }),
        },
      }),
    });
    const response = await route(new Request("http://localhost/api/search?q=%27%20OR%201%3D1"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Search unavailable" });
  });
});
