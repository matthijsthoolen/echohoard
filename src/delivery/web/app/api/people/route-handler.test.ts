import { describe, expect, it, vi } from "vitest";
import type { ArchivePrincipal } from "../../../../../application/auth";
import type { PersonRead } from "../../../../../application/reads";
import { createPeopleRoute } from "./route-handler";

const principal: ArchivePrincipal = {
  userId: "user-1",
  archiveId: "archive-1",
  issuer: "https://issuer.example",
  subject: "owner",
};

describe("people route", () => {
  it("denies requests without a runtime or principal", async () => {
    const missing = createPeopleRoute({ getRuntime: () => undefined });
    expect((await missing(new Request("http://localhost/api/people"))).status).toBe(401);

    const denied = createPeopleRoute({
      getRuntime: () => ({
        auth: { principalForRequest: async () => null },
        reads: { listPeople: vi.fn() },
      }),
    });
    expect((await denied(new Request("http://localhost/api/people"))).status).toBe(401);
  });

  it("uses the principal archive and bounded search pagination", async () => {
    const listPeople = vi.fn(
      async (): Promise<{
        items: readonly PersonRead[];
        hasMore: boolean;
        nextCursor: string;
      }> => ({
        items: [{ id: "p1", displayName: "Ada", identityCount: 2 }],
        hasMore: true,
        nextCursor: "signed.next",
      }),
    );
    const route = createPeopleRoute({
      getRuntime: () => ({
        auth: { principalForRequest: async () => principal },
        reads: { listPeople },
      }),
    });
    const response = await route(
      new Request("http://localhost/api/people?limit=2&search=Ada&cursor=signed.previous"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [{ id: "p1", displayName: "Ada", identityCount: 2 }],
      hasMore: true,
      nextCursor: "signed.next",
    });
    expect(listPeople).toHaveBeenCalledWith({
      archiveId: "archive-1",
      limit: 2,
      search: "Ada",
      cursor: "signed.previous",
    });
  });

  it("rejects an unbounded page before calling the read service", async () => {
    const listPeople = vi.fn();
    const route = createPeopleRoute({
      getRuntime: () => ({
        auth: { principalForRequest: async () => principal },
        reads: { listPeople },
      }),
    });
    expect((await route(new Request("http://localhost/api/people?limit=1000"))).status).toBe(400);
    expect(listPeople).not.toHaveBeenCalled();
  });
});
