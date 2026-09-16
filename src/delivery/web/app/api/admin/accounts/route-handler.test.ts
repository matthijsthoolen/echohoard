import { describe, expect, it } from "vitest";
import { createAdminAccountsRoute } from "./route-handler.js";

describe("admin account settings route", () => {
  it("does not enumerate service availability to anonymous callers", async () => {
    const route = createAdminAccountsRoute({ getRuntime: () => undefined });
    expect((await route(new Request("http://localhost/api/admin/accounts"))).status).toBe(403);
  });

  it("denies anonymous and non-admin requests", async () => {
    const route = createAdminAccountsRoute({
      getRuntime: () => ({
        auth: {
          principalForRequest: async () => ({ archiveId: "archive", role: "member" as const }),
        },
        accountSettings: { list: async () => [] },
      }),
    });
    expect((await route(new Request("http://localhost/api/admin/accounts"))).status).toBe(403);
    const anonymous = createAdminAccountsRoute({
      getRuntime: () => ({
        auth: { principalForRequest: async () => null },
        accountSettings: { list: async () => [] },
      }),
    });
    expect((await anonymous(new Request("http://localhost/api/admin/accounts"))).status).toBe(403);
  });

  it("uses the session archive and disables response caching", async () => {
    let archiveSeen = "";
    const route = createAdminAccountsRoute({
      getRuntime: () => ({
        auth: {
          principalForRequest: async () => ({ archiveId: "archive-owner", role: "admin" as const }),
        },
        accountSettings: {
          list: async (archiveId: string) => {
            archiveSeen = archiveId;
            return [{ id: "account-1" }];
          },
        },
      }),
    });
    const response = await route(
      new Request("http://localhost/api/admin/accounts?archiveId=other"),
    );
    expect(response.status).toBe(200);
    expect(archiveSeen).toBe("archive-owner");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ accounts: [{ id: "account-1" }] });
  });
});
