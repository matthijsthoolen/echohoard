import { describe, expect, it, vi } from "vitest";
import {
  AccountSettingsService,
  PAIRING_SESSION_TTL_MS,
  PairingSessionController,
  type FixedSidecarHealth,
  type FixedSidecarOperations,
} from "./account-pairing.js";
import type {
  AccountSettingsPersistencePort,
  LiveAccountHealthPersistencePort,
  PersistenceInput,
  PersistenceRecord,
} from "./persistence.js";

const account = (overrides: Record<string, unknown> = {}): PersistenceRecord => ({
  id: "account-1",
  accountKey: "account-a",
  displayLabel: "Synthetic account A",
  liveEnabled: true,
  ...overrides,
});

class FakeAccounts implements AccountSettingsPersistencePort {
  public row: PersistenceRecord = account();
  public readonly updates: PersistenceRecord[] = [];
  public async list(): Promise<readonly PersistenceRecord[]> {
    return [this.row];
  }
  public async findById(_archiveId: string, id: string): Promise<PersistenceRecord | null> {
    return id === this.row.id ? this.row : null;
  }
  public async update(
    _archiveId: string,
    _id: string,
    input: PersistenceInput,
  ): Promise<PersistenceRecord> {
    this.row = { ...this.row, ...input };
    this.updates.push(input);
    return this.row;
  }
}

class FakeSidecar implements FixedSidecarOperations {
  public connection: FixedSidecarHealth["connection"] = "disconnected";
  public cancelError: Error | undefined;
  public readonly calls: string[] = [];
  public async pair(): Promise<{ readonly qr: string }> {
    this.calls.push("pair");
    return { qr: "synthetic-qr" };
  }
  public async cancelPairing(): Promise<void> {
    this.calls.push("cancel-pairing");
    if (this.cancelError) throw this.cancelError;
  }
  public async startFollowSync(): Promise<void> {
    this.calls.push("start-follow-sync");
  }
  public async stopFollowSync(): Promise<void> {
    this.calls.push("stop-follow-sync");
  }
  public async health(): Promise<FixedSidecarHealth> {
    this.calls.push("health");
    return {
      connection: this.connection,
      checkedAt: new Date("2026-01-01T00:00:00Z"),
      reconnectCount: 2,
    };
  }
}

const pipeline: LiveAccountHealthPersistencePort = {
  get: async () => ({
    receivedCount: 2,
    pendingCount: 1,
    failedCount: 0,
    lastReceivedAt: new Date("2026-01-01T00:00:00Z"),
  }),
};

describe("owned account pairing and settings", () => {
  it("keeps QR material process-local, bounded, and unavailable after expiry", async () => {
    const accounts = new FakeAccounts();
    const sidecar = new FakeSidecar();
    let now = new Date("2026-01-01T00:00:00Z");
    const controller = new PairingSessionController(accounts, sidecar, () => now);
    const started = await controller.begin("archive-1", "account-1");
    expect(started).toMatchObject({ state: "awaiting_qr", qr: "synthetic-qr" });
    expect(started.qrExpiresAt).toBe(
      new Date(now.getTime() + PAIRING_SESSION_TTL_MS).toISOString(),
    );
    sidecar.connection = "connected";
    now = new Date(now.getTime() + PAIRING_SESSION_TTL_MS + 1);
    const expired = await controller.status("archive-1", "account-1", started.sessionId);
    expect(expired).toMatchObject({ state: "expired" });
    expect(expired).not.toHaveProperty("qr");
    expect(sidecar.calls).not.toContain("start-follow-sync");
    expect(sidecar.calls).toContain("cancel-pairing");
    expect(await controller.status("other-archive", "account-1", started.sessionId)).toBeNull();
  });

  it("fails closed when upstream pairing cancellation fails and retries it", async () => {
    const sidecar = new FakeSidecar();
    sidecar.cancelError = new Error("sidecar unavailable");
    let now = new Date("2026-01-01T00:00:00Z");
    const controller = new PairingSessionController(new FakeAccounts(), sidecar, () => now);
    const started = await controller.begin("archive-1", "account-1");
    now = new Date(now.getTime() + PAIRING_SESSION_TTL_MS + 1);

    await expect(controller.status("archive-1", "account-1", started.sessionId)).rejects.toThrow(
      "sidecar unavailable",
    );
    await expect(controller.status("archive-1", "account-1", started.sessionId)).rejects.toThrow(
      "sidecar unavailable",
    );
    expect(sidecar.calls.filter((call) => call === "cancel-pairing")).toHaveLength(2);

    sidecar.cancelError = undefined;
    const expired = await controller.status("archive-1", "account-1", started.sessionId);
    expect(expired).toMatchObject({ state: "expired" });
    expect(expired).not.toHaveProperty("qr");
    expect(sidecar.calls.filter((call) => call === "cancel-pairing")).toHaveLength(3);
  });

  it("does not accept a connected stale QR as a successful expiry", async () => {
    const sidecar = new FakeSidecar();
    sidecar.cancelError = new Error("upstream invalidation unavailable");
    let now = new Date("2026-01-01T00:00:00Z");
    const controller = new PairingSessionController(new FakeAccounts(), sidecar, () => now);
    const started = await controller.begin("archive-1", "account-1");

    sidecar.connection = "connected";
    now = new Date("2026-01-01T00:05:00.001Z");
    await expect(controller.status("archive-1", "account-1", started.sessionId)).rejects.toThrow(
      "upstream invalidation unavailable",
    );
    expect(sidecar.calls).not.toContain("start-follow-sync");
  });

  it("does not expose a QR larger than the controller bound", async () => {
    const sidecar = new FakeSidecar();
    vi.spyOn(sidecar, "pair").mockResolvedValue({ qr: "x".repeat(16 * 1024 + 1) });
    await expect(
      new PairingSessionController(new FakeAccounts(), sidecar).begin("archive-1", "account-1"),
    ).rejects.toThrow("pairing QR exceeds limit");
  });

  it("invalidates an older session when the account is paired again", async () => {
    const accounts = new FakeAccounts();
    const sidecar = new FakeSidecar();
    const controller = new PairingSessionController(accounts, sidecar);
    const first = await controller.begin("archive-1", "account-1");
    const second = await controller.begin("archive-1", "account-1");
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(await controller.status("archive-1", "account-1", first.sessionId)).toBeNull();
    expect(sidecar.calls).toContain("cancel-pairing");
  });

  it("does not replace an older session when its upstream cancellation fails", async () => {
    const accounts = new FakeAccounts();
    const sidecar = new FakeSidecar();
    const controller = new PairingSessionController(accounts, sidecar);
    const first = await controller.begin("archive-1", "account-1");
    sidecar.cancelError = new Error("sidecar unavailable");

    await expect(controller.begin("archive-1", "account-1")).rejects.toThrow("sidecar unavailable");
    expect(await controller.status("archive-1", "account-1", first.sessionId)).toMatchObject({
      state: "awaiting_qr",
      qr: "synthetic-qr",
    });
    expect(sidecar.calls.filter((call) => call === "pair")).toHaveLength(1);
  });

  it("starts follow-sync before reporting a successful pairing", async () => {
    const sidecar = new FakeSidecar();
    const controller = new PairingSessionController(new FakeAccounts(), sidecar);
    const started = await controller.begin("archive-1", "account-1");
    sidecar.connection = "connected";

    const status = await controller.status("archive-1", "account-1", started.sessionId);

    expect(status).toMatchObject({ state: "connected" });
    expect(sidecar.calls).toEqual(["health", "pair", "health", "start-follow-sync"]);
    expect(status).not.toHaveProperty("qr");
  });

  it("serializes replacement against a connection status race", async () => {
    const sidecar = new FakeSidecar();
    const controller = new PairingSessionController(new FakeAccounts(), sidecar);
    const first = await controller.begin("archive-1", "account-1");
    let releaseHealth!: () => void;
    const healthReleased = new Promise<void>((resolve) => {
      releaseHealth = resolve;
    });
    vi.spyOn(sidecar, "health").mockImplementationOnce(async () => {
      await healthReleased;
      return {
        connection: "connected",
        checkedAt: new Date("2026-01-01T00:00:00Z"),
        reconnectCount: 0,
      };
    });
    const staleStatus = controller.status("archive-1", "account-1", first.sessionId);
    await Promise.resolve();
    const replacement = controller.begin("archive-1", "account-1", true);
    releaseHealth();
    await expect(staleStatus).resolves.toMatchObject({ state: "connected" });
    await expect(replacement).resolves.toMatchObject({ state: "awaiting_qr" });
    expect(sidecar.calls).toEqual([
      "health",
      "pair",
      "start-follow-sync",
      "health",
      "stop-follow-sync",
      "cancel-pairing",
      "pair",
    ]);
  });

  it("separates connection, durable receipt, normalization, and backup health", async () => {
    const sidecar = new FakeSidecar();
    sidecar.connection = "connected";
    const service = new AccountSettingsService(
      new FakeAccounts(),
      pipeline,
      sidecar,
      new PairingSessionController(new FakeAccounts(), sidecar),
    );
    const read = await service.list("archive-1");
    expect(read[0]).toMatchObject({
      liveEnabled: true,
      health: {
        connection: "connected",
        receipt: { state: "healthy", count: 2 },
        normalization: { state: "pending", pending: 1, failed: 0 },
        backupConfirmation: { state: "pending" },
      },
    });
  });

  it("requires pause confirmation and uses only fixed follow-sync controls", async () => {
    const accounts = new FakeAccounts();
    accounts.row = account({ pairedAt: new Date("2026-01-01T00:00:00Z") });
    const sidecar = new FakeSidecar();
    const service = new AccountSettingsService(
      accounts,
      pipeline,
      sidecar,
      new PairingSessionController(accounts, sidecar),
    );
    await expect(service.pause("archive-1", "account-1", false)).rejects.toThrow(
      "pause confirmation required",
    );
    await service.pause("archive-1", "account-1", true);
    expect(sidecar.calls).toContain("stop-follow-sync");
    expect(accounts.updates[0]).toMatchObject({ liveEnabled: false });
    await service.resume("archive-1", "account-1");
    expect(sidecar.calls).toContain("start-follow-sync");
  });

  it("requires confirmation for re-pairing and scopes sessions to the archive", async () => {
    const accounts = new FakeAccounts();
    const sidecar = new FakeSidecar();
    sidecar.connection = "connected";
    const service = new AccountSettingsService(
      accounts,
      pipeline,
      sidecar,
      new PairingSessionController(accounts, sidecar),
    );
    await expect(
      service.beginPairing("archive-1", "account-1", { confirm: false, rePair: true }),
    ).rejects.toThrow("pairing confirmation required");
    await expect(
      service.beginPairing("archive-1", "account-1", { confirm: false, rePair: false }),
    ).rejects.toThrow("re-pair confirmation required");
    const pairing = await service.beginPairing("archive-1", "account-1", {
      confirm: true,
      rePair: true,
    });
    expect(pairing.qr).toBe("synthetic-qr");
    expect(await service.pairingStatus("other-archive", "account-1", pairing.sessionId)).toBeNull();
  });

  it("does not enable capture while waiting for pairing", async () => {
    const accounts = new FakeAccounts();
    accounts.row = account({ liveEnabled: false });
    const sidecar = new FakeSidecar();
    const service = new AccountSettingsService(
      accounts,
      pipeline,
      sidecar,
      new PairingSessionController(accounts, sidecar),
    );

    const pairing = await service.beginPairing("archive-1", "account-1", {
      confirm: false,
      rePair: false,
    });
    expect(pairing.state).toBe("awaiting_qr");
    expect(accounts.row.liveEnabled).toBe(false);
    expect(accounts.updates).toHaveLength(0);

    sidecar.connection = "connected";
    await service.pairingStatus("archive-1", "account-1", pairing.sessionId);
    expect(accounts.row.liveEnabled).toBe(true);
    expect(sidecar.calls).toContain("start-follow-sync");
  });

  it("keeps capture disabled when follow-sync setup fails and retries safely", async () => {
    const accounts = new FakeAccounts();
    accounts.row = account({ liveEnabled: false });
    const sidecar = new FakeSidecar();
    vi.spyOn(sidecar, "startFollowSync")
      .mockRejectedValueOnce(new Error("sidecar is restarting"))
      .mockResolvedValueOnce();
    const service = new AccountSettingsService(
      accounts,
      pipeline,
      sidecar,
      new PairingSessionController(accounts, sidecar),
    );
    const pairing = await service.beginPairing("archive-1", "account-1", {
      confirm: false,
      rePair: false,
    });
    sidecar.connection = "connected";

    const pending = await service.pairingStatus("archive-1", "account-1", pairing.sessionId);
    expect(pending).toMatchObject({ state: "awaiting_qr", connection: "connected" });
    expect(pending).not.toHaveProperty("qr");
    expect(accounts.row.liveEnabled).toBe(false);

    const connected = await service.pairingStatus("archive-1", "account-1", pairing.sessionId);
    expect(connected).toMatchObject({ state: "connected" });
    expect(accounts.row.liveEnabled).toBe(true);
  });

  it("cannot resume an account that has never completed pairing", async () => {
    const accounts = new FakeAccounts();
    accounts.row = account({ liveEnabled: false, pairedAt: undefined });
    const sidecar = new FakeSidecar();
    const service = new AccountSettingsService(
      accounts,
      pipeline,
      sidecar,
      new PairingSessionController(accounts, sidecar),
    );

    await expect(service.resume("archive-1", "account-1")).rejects.toThrow("account is not paired");
    expect(sidecar.calls).not.toContain("start-follow-sync");
  });
});
