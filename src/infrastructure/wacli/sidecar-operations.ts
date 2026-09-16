import type { FixedSidecarHealth, FixedSidecarOperations } from "../../application/account-pairing";
import { MAX_PAIRING_QR_BYTES } from "../../application/account-pairing";

const MAX_CONTROL_RESPONSE_BYTES = 32 * 1024;
const ACCOUNT_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONNECTION_STATES = new Set<FixedSidecarHealth["connection"]>([
  "connected",
  "disconnected",
  "unpaired",
  "unknown",
]);

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Application-facing client for the private, fixed-operation sidecar bridge.
 * The bridge has one endpoint per allowlisted operation; this client has no
 * command, argv, store, or arbitrary URL method by design.
 */
export class HttpFixedSidecarOperations implements FixedSidecarOperations {
  private readonly baseUrl: URL;

  public constructor(
    baseUrl: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly timeoutMilliseconds = 10_000,
  ) {
    const parsed = new URL(baseUrl);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.search ||
      parsed.hash
    )
      throw new Error("wacli control URL must be a plain http(s) URL");
    if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
    this.baseUrl = parsed;
  }

  public async pair(accountKey: string): Promise<{ readonly qr: string }> {
    const result = await this.request("POST", accountKey, "pair");
    const qr = requiredString(result, "qr");
    if (new TextEncoder().encode(qr).byteLength > MAX_PAIRING_QR_BYTES)
      throw new Error("pairing QR exceeds limit");
    return { qr };
  }

  public async cancelPairing(accountKey: string): Promise<void> {
    const result = await this.request("POST", accountKey, "pair/cancel");
    if (result.cancelled !== true) throw new Error("wacli pairing cancellation was not confirmed");
  }

  public async startFollowSync(accountKey: string): Promise<void> {
    await this.request("POST", accountKey, "follow-sync/start");
  }

  public async stopFollowSync(accountKey: string): Promise<void> {
    await this.request("POST", accountKey, "follow-sync/stop");
  }

  public async health(accountKey: string): Promise<FixedSidecarHealth> {
    const result = await this.request("GET", accountKey, "health");
    const connection = requiredString(result, "connection");
    if (!CONNECTION_STATES.has(connection as FixedSidecarHealth["connection"]))
      throw new Error("invalid wacli connection state");
    const checkedAt = requiredString(result, "checkedAt");
    const checkedDate = new Date(checkedAt);
    if (Number.isNaN(checkedDate.valueOf())) throw new Error("invalid wacli health timestamp");
    const reconnectCount = result.reconnectCount;
    if (
      typeof reconnectCount !== "number" ||
      !Number.isSafeInteger(reconnectCount) ||
      reconnectCount < 0
    )
      throw new Error("invalid wacli reconnect count");
    return {
      connection: connection as FixedSidecarHealth["connection"],
      checkedAt: checkedDate,
      reconnectCount,
    };
  }

  private async request(
    method: "GET" | "POST",
    accountKey: string,
    operation: "pair" | "pair/cancel" | "follow-sync/start" | "follow-sync/stop" | "health",
  ): Promise<Record<string, unknown>> {
    if (!ACCOUNT_PATH.test(accountKey)) throw new Error("wacli account key is invalid");
    const url = new URL(`accounts/${encodeURIComponent(accountKey)}/${operation}`, this.baseUrl);
    const response = await this.fetcher(url, {
      method,
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMilliseconds),
    });
    if (!response.ok) throw new Error("wacli sidecar operation failed");
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_CONTROL_RESPONSE_BYTES))
      throw new Error("wacli sidecar response exceeds limit");
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_CONTROL_RESPONSE_BYTES)
      throw new Error("wacli sidecar response exceeds limit");
    if (text.length === 0) return {};
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new Error("wacli sidecar response is not valid JSON");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("wacli sidecar response must be an object");
    return value as Record<string, unknown>;
  }
}

function requiredString(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string" || result.length === 0) throw new Error(`invalid wacli ${field}`);
  return result;
}
