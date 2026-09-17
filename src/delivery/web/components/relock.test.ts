import { describe, expect, it, vi } from "vitest";
import { isUnlockNavigation, relockProtectedSession } from "./relock";

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

  it("preserves the unlock grant while navigating to the step-up challenge", () => {
    expect(
      isUnlockNavigation(
        new URL("https://archive.test/auth/unlock/start?returnTo=%2F"),
        "https://archive.test",
      ),
    ).toBe(true);
    expect(isUnlockNavigation(new URL("https://archive.test/"), "https://archive.test")).toBe(
      false,
    );
    expect(
      isUnlockNavigation(new URL("https://other.test/auth/unlock/start"), "https://archive.test"),
    ).toBe(false);
  });
});
