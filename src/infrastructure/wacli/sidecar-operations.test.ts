import { describe, expect, it } from "vitest";
import { HttpFixedSidecarOperations } from "./sidecar-operations.js";

describe("fixed sidecar operations", () => {
  it("uses only the fixed account operation endpoints", async () => {
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      if (url.pathname.endsWith("/pair")) return Response.json({ qr: "synthetic-qr" });
      if (url.pathname.endsWith("/health"))
        return Response.json({
          connection: "connected",
          checkedAt: "2026-09-16T12:00:00.000Z",
          reconnectCount: 3,
        });
      if (url.pathname.endsWith("/pair/cancel")) return Response.json({ cancelled: true });
      return new Response(null, { status: 204 });
    };
    const sidecar = new HttpFixedSidecarOperations("http://wacli-control.test/private/", fetcher);

    await expect(sidecar.pair("account-a")).resolves.toEqual({ qr: "synthetic-qr" });
    await sidecar.cancelPairing("account-a");
    await sidecar.startFollowSync("account-a");
    await sidecar.stopFollowSync("account-a");
    await expect(sidecar.health("account-a")).resolves.toMatchObject({
      connection: "connected",
      reconnectCount: 3,
    });
    expect(requests).toEqual([
      "/private/accounts/account-a/pair",
      "/private/accounts/account-a/pair/cancel",
      "/private/accounts/account-a/follow-sync/start",
      "/private/accounts/account-a/follow-sync/stop",
      "/private/accounts/account-a/health",
    ]);
  });

  it("rejects malformed control responses and account paths", async () => {
    const fetcher: typeof fetch = async () =>
      Response.json({
        connection: "connected",
        checkedAt: "2026-09-16T12:00:00.000Z",
      });
    const sidecar = new HttpFixedSidecarOperations("http://wacli-control.test/", fetcher);

    await expect(sidecar.health("../other-account")).rejects.toThrow("account key is invalid");
    await expect(sidecar.health("account-a")).rejects.toThrow("reconnect count");
  });
});

it("rejects a cancellation response without an upstream confirmation", async () => {
  const sidecar = new HttpFixedSidecarOperations("http://wacli-control.test/", async () =>
    Response.json({}),
  );

  await expect(sidecar.cancelPairing("account-a")).rejects.toThrow("not confirmed");
});
