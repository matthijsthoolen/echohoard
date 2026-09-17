import { describe, expect, it, vi } from "vitest";
import { createUnlockRelockRoute, createUnlockStartRoute } from "./routes";

describe("unlock relock route", () => {
  it("revokes the server-side grant and never returns protected data", async () => {
    const relock = vi.fn(async () => undefined);
    const route = createUnlockRelockRoute({ getRuntime: () => ({ auth: { relock } }) });
    const response = await route(
      new Request("http://localhost/auth/unlock/relock", {
        method: "POST",
        headers: { cookie: "echohoard_session=session-token" },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(relock).toHaveBeenCalledWith(expect.any(Request));
  });

  it("fails closed when the revocation protocol is unavailable", async () => {
    const route = createUnlockRelockRoute({
      getRuntime: () => ({
        auth: {
          relock: vi.fn(async () => {
            throw new Error("down");
          }),
        },
      }),
    });
    expect(
      (await route(new Request("http://localhost/auth/unlock/relock", { method: "POST" }))).status,
    ).toBe(403);
  });
});

describe("targeted unlock start route", () => {
  it("binds the target through the authenticated server-side unlock flow", async () => {
    const unlockStart = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://issuer.test/authorize?state=opaque" },
        }),
    );
    const route = createUnlockStartRoute({ getRuntime: () => ({ auth: { unlockStart } }) });
    const response = await route(
      new Request(
        "http://localhost/auth/unlock/start?archiveId=archive-a&conversationId=conversation-a&returnTo=/",
      ),
    );
    expect(response.status).toBe(302);
    expect(unlockStart).toHaveBeenCalledWith(expect.any(Request), "archive-a", "conversation-a");
    const location = response.headers.get("location");
    expect(location).not.toContain("archive-a");
    expect(location).not.toContain("conversation-a");
  });

  it("fails closed for an archive mismatch or unavailable target", async () => {
    const unlockStart = vi.fn(async () => new Response(null, { status: 403 }));
    const route = createUnlockStartRoute({ getRuntime: () => ({ auth: { unlockStart } }) });
    await expect(
      route(
        new Request(
          "http://localhost/auth/unlock/start?archiveId=other-archive&conversationId=locked-chat",
        ),
      ),
    ).resolves.toMatchObject({ status: 403 });
    const failingRoute = createUnlockStartRoute({
      getRuntime: () => ({
        auth: {
          unlockStart: vi.fn(async () => {
            throw new Error("step-up unavailable");
          }),
        },
      }),
    });
    await expect(
      failingRoute(
        new Request(
          "http://localhost/auth/unlock/start?archiveId=archive-a&conversationId=locked-chat",
        ),
      ),
    ).resolves.toMatchObject({ status: 403 });
  });

  it("does not accept a partial target", async () => {
    const route = createUnlockStartRoute({
      getRuntime: () => ({ auth: { unlockStartFolder: vi.fn() } }),
    });
    await expect(
      route(new Request("http://localhost/auth/unlock/start?conversationId=locked-chat")),
    ).resolves.toMatchObject({ status: 403 });
  });
});
