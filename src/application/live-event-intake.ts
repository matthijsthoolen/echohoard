import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { LiveEventInboxPort } from "./persistence.js";

export const LIVE_EVENT_MAX_BYTES = 256 * 1024;
export const LIVE_EVENT_MAX_CLOCK_SKEW_SECONDS = 300;
export const LIVE_EVENT_SIGNATURE_HEADER = "sha256";

export type LiveEventRejection =
  | "invalid_signature"
  | "invalid_timestamp"
  | "stale_timestamp"
  | "unknown_account"
  | "invalid_payload"
  | "payload_too_large"
  | "backpressure";

export interface LiveEventAccount {
  readonly archiveId: string;
  readonly ownedAccountId: string;
  readonly secret: string;
}

export interface LiveEventAccountResolver {
  resolve(accountKey: string): Promise<LiveEventAccount | null>;
}

export interface LiveEventMetrics {
  rejected(reason: LiveEventRejection): void;
  accepted(kind: "accepted" | "duplicate"): void;
}

/** A deliberately low-cardinality metric sink: no account keys, receipts, or payloads. */
export class CountingLiveEventMetrics implements LiveEventMetrics {
  private readonly values = new Map<string, number>();

  public rejected(reason: LiveEventRejection): void {
    this.increment(`rejected.${reason}`);
  }

  public accepted(kind: "accepted" | "duplicate"): void {
    this.increment(`accepted.${kind}`);
  }

  public snapshot(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.values);
  }

  private increment(name: string): void {
    this.values.set(name, (this.values.get(name) ?? 0) + 1);
  }
}

export interface ValidatedLiveEvent {
  readonly kind: string;
  readonly sourceEventKey: string;
  readonly observedAt?: string;
  readonly payload: Record<string, unknown>;
}

export interface LiveEventPayloadValidator {
  validate(payload: Uint8Array, accountKey: string): ValidatedLiveEvent;
}

export interface LiveEventIntakeRequest {
  readonly accountKey: string;
  readonly signature: string | null;
  readonly timestamp: string | null;
  readonly body: Uint8Array;
  readonly receivedAt?: Date;
}

export type LiveEventIntakeResult =
  | { readonly status: "accepted" | "duplicate"; readonly receiptId: string }
  | { readonly status: "rejected"; readonly reason: LiveEventRejection };

export class LiveEventIntakeService {
  public constructor(
    private readonly accounts: LiveEventAccountResolver,
    private readonly inbox: LiveEventInboxPort,
    private readonly metrics: LiveEventMetrics,
    private readonly validator: LiveEventPayloadValidator,
    private readonly maxPending = 10_000,
    private readonly maxClockSkewSeconds = LIVE_EVENT_MAX_CLOCK_SKEW_SECONDS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async accept(request: LiveEventIntakeRequest): Promise<LiveEventIntakeResult> {
    if (request.body.byteLength > LIVE_EVENT_MAX_BYTES) return this.reject("payload_too_large");
    const timestamp = parseTimestamp(request.timestamp);
    if (timestamp === null) return this.reject("invalid_timestamp");
    const now = this.now();
    if (Math.abs(Math.floor(now.getTime() / 1000) - timestamp) > this.maxClockSkewSeconds)
      return this.reject("stale_timestamp");
    const account = await this.accounts.resolve(request.accountKey);
    if (!account) return this.reject("unknown_account");
    if (
      !request.signature ||
      !verifySignature(
        request.body,
        request.signature,
        timestamp,
        request.accountKey,
        account.secret,
      )
    )
      return this.reject("invalid_signature");

    let event: ValidatedLiveEvent;
    try {
      event = this.validator.validate(request.body, request.accountKey);
    } catch {
      return this.reject("invalid_payload");
    }
    const receiptId = stableReceiptId(request.accountKey, event.sourceEventKey);
    const receivedAt = request.receivedAt ?? now;
    const result = await this.inbox.enqueue({
      archiveId: account.archiveId,
      ownedAccountId: account.ownedAccountId,
      receiptId,
      sourceEventKey: event.sourceEventKey,
      eventKind: event.kind,
      payload: event.payload,
      observedAt: event.observedAt === undefined ? receivedAt : new Date(event.observedAt),
      receivedAt,
      maxPending: this.maxPending,
    });
    if (result.kind === "backpressure") return this.reject("backpressure");
    this.metrics.accepted(result.kind);
    return { status: result.kind, receiptId };
  }

  private reject(reason: LiveEventRejection): LiveEventIntakeResult {
    this.metrics.rejected(reason);
    return { status: "rejected", reason };
  }
}

export function stableReceiptId(accountKey: string, sourceEventKey: string): string {
  return createHash("sha256")
    .update("echohoard-live-receipt:v1\0")
    .update(accountKey)
    .update("\0")
    .update(sourceEventKey)
    .digest("hex");
}

/**
 * Sign the transport metadata together with the exact body. The account key is
 * deliberately outside the JSON payload, so it must still be part of the
 * authenticated input to prevent cross-account reassignment.
 */
export function signLiveEvent(
  body: Uint8Array,
  timestamp: number,
  secret: string,
  accountKey: string,
): string {
  return `${LIVE_EVENT_SIGNATURE_HEADER}=${createHmac("sha256", secret)
    .update(String(timestamp))
    .update(".")
    .update(accountKey)
    .update(".")
    .update(body)
    .digest("hex")}`;
}

function verifySignature(
  body: Uint8Array,
  header: string,
  timestamp: number,
  accountKey: string,
  secret: string,
): boolean {
  if (!/^sha256=[0-9a-f]{64}$/.test(header) || secret.length === 0) return false;
  const expected = Buffer.from(
    signLiveEvent(body, timestamp, secret, accountKey).slice("sha256=".length),
    "hex",
  );
  const supplied = Buffer.from(header.slice("sha256=".length), "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function parseTimestamp(value: string | null): number | null {
  if (!value || !/^\d{1,12}$/.test(value)) return null;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) ? timestamp : null;
}
