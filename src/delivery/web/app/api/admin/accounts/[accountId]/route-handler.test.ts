import { describe, expect, it } from "vitest";
import { createAdminAccountActionRoute, createAdminAccountGetRoute } from "./route-handler.js";

const context = { params: Promise.resolve({ accountId: "account-1" }) };
const principal = { archiveId: "archive-1", role: "admin" as const };
const account = { id: "account-1", label: "Synthetic account", liveEnabled: true };

describe("admin owned account routes", () => {
  it("reads an archive-scoped account for administrators", async () => {
    let seenArchive = "";
    const route = createAdminAccountGetRoute({
      getRuntime: () => ({
        auth: { principalForRequest: async () => principal },
        accountSettings: {
          read: async (archiveId: string) => {
            seenArchive = archiveId;
            return account;
          },
        },
      }),
    });
    const response = await route(new Request("http://localhost?archiveId=other"), context);
    expect(response.status).toBe(200);
    expect(seenArchive).toBe("archive-1");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("denies non-admin reads and does not reveal missing accounts", async () => {
    const denied = createAdminAccountGetRoute({
      getRuntime: () => ({
        auth: { principalForRequest: async () => ({ ...principal, role: "member" as const }) },
        accountSettings: { read: async () => account },
      }),
    });
    expect((await denied(new Request("http://localhost"), context)).status).toBe(403);
    const missing = createAdminAccountGetRoute({
      getRuntime: () => ({
        auth: { principalForRequest: async () => principal },
        accountSettings: { read: async () => null },
      }),
    });
    const response = await missing(new Request("http://localhost"), context);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("requires a confirmation before pausing and supports resume", async () => {
    const actions: string[] = [];
    const route = createAdminAccountActionRoute({
      getRuntime: () => ({
        auth: { principalForRequest: async () => principal },
        accountSettings: {
          pause: async (_archiveId: string, _accountId: string, confirm: boolean) => {
            if (!confirm) throw new Error("pause confirmation required");
            actions.push("pause");
            return account;
          },
          resume: async () => {
            actions.push("resume");
            return account;
          },
        },
      }),
    });
    const unconfirmed = await route(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({ action: "pause", confirm: false }),
      }),
      context,
    );
    expect(unconfirmed.status).toBe(409);
    const resumed = await route(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({ action: "resume" }),
      }),
      context,
    );
    expect(resumed.status).toBe(200);
    expect(actions).toEqual(["resume"]);
  });

  it("rejects malformed actions and sanitizes service errors", async () => {
    const route = createAdminAccountActionRoute({
      getRuntime: () => ({
        auth: { principalForRequest: async () => principal },
        accountSettings: {
          pause: async () => {
            throw new Error("secret /private/path");
          },
          resume: async () => {
            throw new Error("account not found");
          },
        },
      }),
    });
    expect(
      (
        await route(
          new Request("http://localhost", {
            method: "POST",
            body: JSON.stringify({ action: "delete" }),
          }),
          context,
        )
      ).status,
    ).toBe(400);
    const unavailable = await route(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({ action: "pause", confirm: true }),
      }),
      context,
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "Account settings unavailable" });
    const notFound = await route(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({ action: "resume" }),
      }),
      context,
    );
    expect(notFound.status).toBe(404);
  });
});
