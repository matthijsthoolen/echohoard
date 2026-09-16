import { randomUUID } from "node:crypto";
import type {
  AccountSettingsPersistencePort,
  LiveAccountHealthPersistencePort,
  PersistenceRecord,
} from "./persistence.js";

export const MAX_ACCOUNT_SETTINGS = 100;
export const PAIRING_SESSION_TTL_MS = 5 * 60 * 1_000;
export const MAX_PAIRING_QR_BYTES = 16 * 1024;

export type SidecarConnectionState = "connected" | "disconnected" | "unpaired" | "unknown";
export type AccountConnectionState = SidecarConnectionState | "paused";
export type PipelineState = "healthy" | "pending" | "failed" | "none";
export type BackupConfirmationState = "confirmed" | "pending" | "none";

export interface FixedSidecarHealth {
  readonly connection: SidecarConnectionState;
  readonly checkedAt: Date;
  readonly reconnectCount: number;
}

export interface FixedSidecarOperations {
  /** Starts the fixed `pair` role and returns only an ephemeral QR payload. */
  pair(accountKey: string): Promise<{ readonly qr: string }>;
  /** Starts/stops the fixed `follow-sync` role; there is no generic command API. */
  startFollowSync(accountKey: string): Promise<void>;
  stopFollowSync(accountKey: string): Promise<void>;
  health(accountKey: string): Promise<FixedSidecarHealth>;
}

export interface PairingSessionRead {
  readonly sessionId: string;
  readonly accountId: string;
  readonly state: "awaiting_qr" | "connected" | "expired";
  readonly qrExpiresAt: string;
  readonly qr?: string;
  readonly connection: AccountConnectionState;
}

type PairingSession = {
  readonly sessionId: string;
  readonly archiveId: string;
  readonly accountId: string;
  readonly accountKey: string;
  qr?: string;
  readonly qrExpiresAt: Date;
  state: "awaiting_qr" | "connected" | "expired";
  followSyncStart?: Promise<void>;
};

/** Process-local pairing state. QR material deliberately never reaches a
 * persistence port, shared cache, logger, or durable response. */
export class PairingSessionController {
  private readonly sessions = new Map<string, PairingSession>();

  public constructor(
    private readonly accounts: AccountSettingsPersistencePort,
    private readonly sidecar: FixedSidecarOperations,
    private readonly now: () => Date = () => new Date(),
    private readonly maxSessions = 8,
  ) {}

  public async begin(
    archiveId: string,
    accountId: string,
    rePair = false,
  ): Promise<PairingSessionRead> {
    this.prune();
    const account = await this.account(archiveId, accountId);
    if (!account) throw new Error("account not found");
    const current = await this.safeHealth(account.accountKey);
    if ((current.connection === "connected" || account.pairedAt) && !rePair)
      throw new Error("re-pair confirmation required");
    for (const [sessionId, existing] of this.sessions) {
      if (existing.archiveId === archiveId && existing.accountId === accountId)
        this.sessions.delete(sessionId);
    }
    const activeSessions = [...this.sessions.values()].filter(
      (session) => session.state === "awaiting_qr",
    ).length;
    if (activeSessions >= this.maxSessions) throw new Error("pairing capacity reached");
    const result = await this.sidecar.pair(account.accountKey);
    if (new TextEncoder().encode(result.qr).byteLength > MAX_PAIRING_QR_BYTES)
      throw new Error("pairing QR exceeds limit");
    const qrExpiresAt = new Date(this.now().getTime() + PAIRING_SESSION_TTL_MS);
    const session: PairingSession = {
      sessionId: randomUUID(),
      archiveId,
      accountId,
      accountKey: account.accountKey,
      qr: result.qr,
      qrExpiresAt,
      state: "awaiting_qr",
    };
    this.sessions.set(session.sessionId, session);
    return this.read(session, current.connection, "awaiting_qr");
  }

  public async status(
    archiveId: string,
    accountId: string,
    sessionId: string,
  ): Promise<PairingSessionRead | null> {
    this.prune();
    const session = this.sessions.get(sessionId);
    if (!session || session.archiveId !== archiveId || session.accountId !== accountId) return null;
    if (session.state === "expired") return this.read(session, "disconnected", "expired");
    if (session.state === "connected") {
      const health = await this.safeHealth(session.accountKey);
      return this.read(session, health.connection, "connected");
    }
    if (this.now().getTime() >= session.qrExpiresAt.getTime()) {
      this.expire(session);
      return this.read(session, "disconnected", "expired");
    }
    const health = await this.safeHealth(session.accountKey);
    if (this.now().getTime() >= session.qrExpiresAt.getTime()) {
      this.expire(session);
      return this.read(session, health.connection, "expired");
    }
    if (health.connection === "connected") {
      try {
        session.followSyncStart ??= this.sidecar.startFollowSync(session.accountKey);
        await session.followSyncStart;
      } catch {
        // Pairing succeeded, but capture must stay disabled until the fixed
        // follow-sync operation is ready. A later status poll may retry it.
        delete session.followSyncStart;
        delete session.qr;
        return this.read(session, health.connection, "awaiting_qr");
      }
      delete session.followSyncStart;
      session.state = "connected";
      delete session.qr;
      return this.read(session, health.connection, "connected");
    }
    return this.read(session, health.connection, "awaiting_qr");
  }

  private read(
    session: PairingSession,
    connection: AccountConnectionState,
    state: PairingSessionRead["state"],
  ): PairingSessionRead {
    return {
      sessionId: session.sessionId,
      accountId: session.accountId,
      state,
      qrExpiresAt: session.qrExpiresAt.toISOString(),
      ...(state === "awaiting_qr" && session.qr !== undefined ? { qr: session.qr } : {}),
      connection,
    };
  }

  private async account(archiveId: string, accountId: string): Promise<AccountRecord | null> {
    const row = await this.accounts.findById(archiveId, accountId);
    return row ? accountRecord(row) : null;
  }

  private async safeHealth(accountKey: string): Promise<FixedSidecarHealth> {
    try {
      return await this.sidecar.health(accountKey);
    } catch {
      return { connection: "unknown", checkedAt: this.now(), reconnectCount: 0 };
    }
  }

  private prune(): void {
    const now = this.now().getTime();
    for (const [id, session] of this.sessions) {
      if (session.state === "awaiting_qr" && session.qrExpiresAt.getTime() <= now)
        this.expire(session);
      if (session.qrExpiresAt.getTime() < now - PAIRING_SESSION_TTL_MS) this.sessions.delete(id);
    }
  }

  private expire(session: PairingSession): void {
    session.state = "expired";
    delete session.qr;
  }
}

export interface AccountSettingsRead {
  readonly id: string;
  readonly label: string;
  readonly accountKey: string;
  readonly liveEnabled: boolean;
  readonly pairedAt?: string;
  readonly health: {
    readonly connection: AccountConnectionState;
    readonly reconnectCount: number;
    readonly checkedAt: string;
    readonly receipt: {
      readonly state: PipelineState;
      readonly count: number;
      readonly lastEventAt?: string;
    };
    readonly normalization: {
      readonly state: PipelineState;
      readonly pending: number;
      readonly failed: number;
      readonly lastEventAt?: string;
    };
    readonly backupConfirmation: {
      readonly state: BackupConfirmationState;
      readonly lastConfirmedAt?: string;
    };
  };
}

export interface AccountSettingsServicePort {
  list(archiveId: string): Promise<readonly AccountSettingsRead[]>;
  read(archiveId: string, accountId: string): Promise<AccountSettingsRead | null>;
  beginPairing(
    archiveId: string,
    accountId: string,
    input: { readonly confirm: boolean; readonly rePair: boolean },
  ): Promise<PairingSessionRead>;
  pairingStatus(
    archiveId: string,
    accountId: string,
    sessionId: string,
  ): Promise<PairingSessionRead | null>;
  pause(archiveId: string, accountId: string, confirm: boolean): Promise<AccountSettingsRead>;
  resume(archiveId: string, accountId: string): Promise<AccountSettingsRead>;
}

export class AccountSettingsService implements AccountSettingsServicePort {
  public constructor(
    private readonly accounts: AccountSettingsPersistencePort,
    private readonly pipeline: LiveAccountHealthPersistencePort,
    private readonly sidecar: FixedSidecarOperations,
    private readonly pairing: PairingSessionController,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async list(archiveId: string): Promise<readonly AccountSettingsRead[]> {
    const rows = (await this.accounts.list(archiveId)).slice(0, MAX_ACCOUNT_SETTINGS);
    return Promise.all(rows.map((row) => this.toRead(archiveId, row)));
  }

  public async read(archiveId: string, accountId: string): Promise<AccountSettingsRead | null> {
    const row = await this.accounts.findById(archiveId, accountId);
    return row ? this.toRead(archiveId, row) : null;
  }

  public async beginPairing(
    archiveId: string,
    accountId: string,
    input: { readonly confirm: boolean; readonly rePair: boolean },
  ): Promise<PairingSessionRead> {
    const account = await this.accounts.findById(archiveId, accountId);
    if (!account) throw new Error("account not found");
    if (input.rePair && !input.confirm) throw new Error("pairing confirmation required");
    if (input.rePair) {
      await this.sidecar.stopFollowSync(accountRecord(account).accountKey);
      await this.accounts.update(archiveId, accountId, {
        liveEnabled: false,
        pausedAt: this.now(),
      });
    }
    const result = await this.pairing.begin(archiveId, accountId, input.rePair);
    return result;
  }

  public pairingStatus(
    archiveId: string,
    accountId: string,
    sessionId: string,
  ): Promise<PairingSessionRead | null> {
    return this.pairing.status(archiveId, accountId, sessionId).then(async (result) => {
      if (result?.state === "connected")
        await this.accounts.update(archiveId, accountId, {
          liveEnabled: true,
          pairedAt: this.now(),
          pausedAt: null,
        });
      return result;
    });
  }

  public async pause(
    archiveId: string,
    accountId: string,
    confirm: boolean,
  ): Promise<AccountSettingsRead> {
    if (!confirm) throw new Error("pause confirmation required");
    const account = await this.requireAccount(archiveId, accountId);
    await this.sidecar.stopFollowSync(account.accountKey);
    const updated = await this.accounts.update(archiveId, accountId, {
      liveEnabled: false,
      pausedAt: this.now(),
    });
    return this.toRead(archiveId, updated);
  }

  public async resume(archiveId: string, accountId: string): Promise<AccountSettingsRead> {
    const account = await this.requireAccount(archiveId, accountId);
    if (!account.pairedAt) throw new Error("account is not paired");
    await this.sidecar.startFollowSync(account.accountKey);
    const updated = await this.accounts.update(archiveId, accountId, {
      liveEnabled: true,
      pausedAt: null,
    });
    return this.toRead(archiveId, updated);
  }

  private async requireAccount(archiveId: string, accountId: string): Promise<AccountRecord> {
    const row = await this.accounts.findById(archiveId, accountId);
    if (!row) throw new Error("account not found");
    return accountRecord(row);
  }

  private async toRead(archiveId: string, row: PersistenceRecord): Promise<AccountSettingsRead> {
    const account = accountRecord(row);
    const [sidecar, pipeline] = await Promise.all([
      this.sidecar.health(account.accountKey).catch(
        (): FixedSidecarHealth => ({
          connection: "unknown",
          checkedAt: this.now(),
          reconnectCount: 0,
        }),
      ),
      this.pipeline.get(archiveId, account.id),
    ]);
    const receiptState: PipelineState = pipeline.receivedCount === 0 ? "none" : "healthy";
    const normalizationState: PipelineState =
      pipeline.failedCount > 0 ? "failed" : pipeline.pendingCount > 0 ? "pending" : "healthy";
    const backupState: BackupConfirmationState = pipeline.lastBackupConfirmedAt
      ? "confirmed"
      : pipeline.receivedCount > 0
        ? "pending"
        : "none";
    return {
      id: account.id,
      label: account.displayLabel ?? account.accountKey,
      accountKey: account.accountKey,
      liveEnabled: account.liveEnabled,
      ...(account.pairedAt ? { pairedAt: account.pairedAt.toISOString() } : {}),
      health: {
        connection: account.liveEnabled ? sidecar.connection : "paused",
        reconnectCount: sidecar.reconnectCount,
        checkedAt: sidecar.checkedAt.toISOString(),
        receipt: {
          state: receiptState,
          count: safeCount(pipeline.receivedCount),
          ...(pipeline.lastReceivedAt
            ? { lastEventAt: pipeline.lastReceivedAt.toISOString() }
            : {}),
        },
        normalization: {
          state: normalizationState,
          pending: safeCount(pipeline.pendingCount),
          failed: safeCount(pipeline.failedCount),
          ...(pipeline.lastNormalizedAt
            ? { lastEventAt: pipeline.lastNormalizedAt.toISOString() }
            : {}),
        },
        backupConfirmation: {
          state: backupState,
          ...(pipeline.lastBackupConfirmedAt
            ? { lastConfirmedAt: pipeline.lastBackupConfirmedAt.toISOString() }
            : {}),
        },
      },
    };
  }
}

type AccountRecord = {
  readonly id: string;
  readonly accountKey: string;
  readonly displayLabel?: string;
  readonly liveEnabled: boolean;
  readonly pairedAt?: Date;
};

function accountRecord(row: PersistenceRecord): AccountRecord {
  if (
    typeof row.id !== "string" ||
    typeof row.accountKey !== "string" ||
    typeof row.liveEnabled !== "boolean"
  )
    throw new Error("Invalid owned account record");
  return {
    id: row.id,
    accountKey: row.accountKey,
    ...(typeof row.displayLabel === "string" ? { displayLabel: row.displayLabel } : {}),
    liveEnabled: row.liveEnabled,
    ...(row.pairedAt instanceof Date ? { pairedAt: row.pairedAt } : {}),
  };
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
