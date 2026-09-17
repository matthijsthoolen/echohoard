import { describe, expect, it, vi } from "vitest";
import { relockProtectedSession } from "./relock";

describe("protected navigation relock protocol", () => {
  it("uses a same-origin keepalive POST rather than relying on unload alone", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    await relockProtectedSession(fetcher);
    expect(fetcher).toHaveBeenCalledWith("/auth/unlock/relock", {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: { Accept: "application/json" },
    });
  });
});
