import { describe, expect, it } from "vitest";
import { createAdminPairingRoute, createAdminPairingStatusRoute } from "./route-handler.js";

const context = { params: Promise.resolve({ accountId: "account-1" }) };
const session = {
  sessionId: "session-1",
  accountId: "account-1",
  state: "awaiting_qr" as const,
  qrExpiresAt: "2026-01-01T00:05:00.000Z",
  qr: "synthetic-qr",
  connection: "disconnected" as const,
};

describe("admin pairing routes", () => {
  it("requires admin access and confirmation for a re-pair", async () => {
    const beginPairing = async (
      _archiveId: string,
      _accountId: string,
      input: { rePair: boolean },
    ) => {
      if (input.rePair) throw new Error("pairing confirmation required");
      return session;
    };
    const route = createAdminPairingRoute({
      getRuntime: () => ({
        auth: {
          principalForRequest: async () => ({ archiveId: "archive-1", role: "admin" as const }),
        },
        accountSettings: { beginPairing },
      }),
    });
    const denied = await route(
      new Request("http://localhost", { method: "POST", body: JSON.stringify({ rePair: true }) }),
      context,
    );
    expect(denied.status).toBe(409);
    expect(await denied.json()).toEqual({ error: "pairing confirmation required" });
    const anonymous = createAdminPairingRoute({
      getRuntime: () => ({
        auth: { principalForRequest: async () => null },
        accountSettings: { beginPairing },
      }),
    });
    expect(
      (
        await anonymous(
          new Request("http://localhost", { method: "POST", body: JSON.stringify({}) }),
          context,
        )
      ).status,
    ).toBe(403);
  });

  it("returns ephemeral session material with no-store and scopes status", async () => {
    const route = createAdminPairingRoute({
      getRuntime: () => ({
        auth: {
          principalForRequest: async () => ({ archiveId: "archive-1", role: "admin" as const }),
        },
        accountSettings: { beginPairing: async () => session },
      }),
    });
    const response = await route(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({ confirm: true, rePair: false }),
      }),
      context,
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await response.json()).qr).toBe("synthetic-qr");

    const status = createAdminPairingStatusRoute({
      getRuntime: () => ({
        auth: {
          principalForRequest: async () => ({ archiveId: "archive-1", role: "admin" as const }),
        },
        accountSettings: {
          pairingStatus: async () => ({ ...session, state: "expired" as const, qr: undefined }),
        },
      }),
    });
    const statusResponse = await status(
      new Request("http://localhost?sessionId=session-1"),
      context,
    );
    expect(statusResponse.headers.get("cache-control")).toBe("private, no-store");
    expect((await statusResponse.json()).state).toBe("expired");
  });
});
