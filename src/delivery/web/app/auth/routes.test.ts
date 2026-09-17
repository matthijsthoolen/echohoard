import { describe, expect, it, vi } from "vitest";
import { createUnlockRelockRoute } from "./routes";

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
