import { createHmac, timingSafeEqual } from "node:crypto";

export const WACLI_CONTRACT_VERSION = "wacli-webhook-contract.v1" as const;
export const WACLI_PROTECTED_SECRET_PLACEHOLDER = "<protected-webhook-secret>" as const;
export const MAX_WACLI_WEBHOOK_BYTES = 256 * 1024;
export const MAX_WACLI_TEXT_BYTES = 64 * 1024;
export const MAX_WACLI_MEDIA_BYTES = 100 * 1024 * 1024;

export const WACLI_UPSTREAM_PIN = {
  repository: "openclaw/wacli",
  license: "MIT",
  version: "0.18.2",
  tag: "v0.18.2",
  releaseCommit: "cd4370388f03e2234c5f6af14778c9649f230c81",
  artifact: "wacli_0.18.2_linux_amd64.tar.gz",
  artifactBytes: 9036823,
  artifactSha256: "d33e8cc4b01acbd4e1ba212e22ac9c6438221e0761112dd3e7a2cc30b3a5946f",
  releaseCommitSignature: { verified: true, reason: "valid" },
  detachedLinuxArtifactSignature: false,
  goToolchain: "go1.27.1",
  whatsmeow: "v0.0.0-20260909164725-b25a56d63729",
} as const;

export type WacliOperation = "pair" | "follow-sync" | "health";
export type WacliSecretSource = "none" | "protected-file";

export interface WacliInvocation {
  readonly operation: WacliOperation;
  readonly argv: readonly string[];
  readonly secretSource: WacliSecretSource;
}

const ACCOUNT_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_ENDPOINT = /^https?:\/\/[^/?#]+(?:\/[^?#]*)?$/;

export const WACLI_FORBIDDEN_COMMANDS = [
  "send",
  "send react",
  "messages edit",
  "messages delete",
  "messages revoke",
  "messages forward",
  "chats mark-read",
  "chats mark-unread",
  "presence",
  "groups rename",
  "groups participants",
  "groups join",
  "groups leave",
  "channels join",
  "channels leave",
  "history backfill",
  "media download",
  "media retry",
  "profile",
  "auth logout",
  "store cleanup",
  "store purge",
] as const;

export function buildWacliInvocation(
  operation: WacliOperation,
  accountKey: string,
  webhookEndpoint?: string,
): WacliInvocation {
  assertAccountKey(accountKey);
  switch (operation) {
    case "pair":
      return {
        operation,
        argv: ["wacli", "--account", accountKey, "--events", "auth", "--qr-format", "text"],
        secretSource: "none",
      };
    case "follow-sync":
      if (webhookEndpoint === undefined || !SAFE_ENDPOINT.test(webhookEndpoint)) {
        throw new Error("follow-sync requires a fixed http(s) webhook endpoint");
      }
      return {
        operation,
        argv: [
          "wacli",
          "--account",
          accountKey,
          "--events",
          "sync",
          "--follow",
          "--presence-mode",
          "quiet",
          "--webhook",
          webhookEndpoint,
          "--webhook-events",
          "message,receipt,chat_presence,delete_for_me",
          "--webhook-secret",
          WACLI_PROTECTED_SECRET_PLACEHOLDER,
        ],
        secretSource: "protected-file",
      };
    case "health":
      return {
        operation,
        argv: ["wacli", "--account", accountKey, "--read-only", "--json", "auth", "status"],
        secretSource: "none",
      };
  }
}

export function isAllowedWacliInvocation(invocation: WacliInvocation): boolean {
  if (!ACCOUNT_KEY.test(invocation.argv[2] ?? "") || invocation.argv[0] !== "wacli") return false;
  const accountKey = invocation.argv[2];
  if (invocation.operation === "follow-sync") {
    const endpoint = invocation.argv[9];
    if (invocation.secretSource !== "protected-file" || endpoint === undefined) return false;
    try {
      return equalArgs(
        invocation.argv,
        buildWacliInvocation("follow-sync", accountKey, endpoint).argv,
      );
    } catch {
      return false;
    }
  }
  if (invocation.secretSource !== "none") return false;
  try {
    return equalArgs(invocation.argv, buildWacliInvocation(invocation.operation, accountKey).argv);
  } catch {
    return false;
  }
}

export function isForbiddenWacliCommand(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, " ");
  return WACLI_FORBIDDEN_COMMANDS.some(
    (forbidden) => normalized === forbidden || normalized.startsWith(`${forbidden} `),
  );
}

export interface WacliMessageEvent {
  readonly kind: "message";
  readonly accountKey: string;
  readonly sourceEventKey: string;
  readonly chatKey: string;
  readonly messageKey: string;
  readonly senderKey: string;
  readonly observedAt: string;
  readonly fromMe: boolean;
  readonly text?: string;
  readonly edited: boolean;
  readonly sourceDeleted: boolean;
  readonly sourceDeletionKind?: "revoke" | "delete";
  readonly replyToKey?: string;
  readonly media?: WacliMediaMetadata;
}

export interface WacliMediaMetadata {
  readonly type:
    | "image"
    | "video"
    | "audio"
    | "document"
    | "sticker"
    | "location"
    | "live_location"
    | "gif";
  readonly mimeType?: string;
  readonly filename?: string;
  readonly fileLength?: number;
}

export interface WacliReceiptEvent {
  readonly kind: "receipt";
  readonly accountKey: string;
  readonly sourceEventKey: string;
  readonly chatKey: string;
  readonly senderKey: string;
  readonly messageKeys: readonly string[];
  readonly observedAt: string;
  readonly type: "delivered" | "read" | "played";
  readonly fromMe: boolean;
}

export interface WacliChatPresenceEvent {
  readonly kind: "chat_presence";
  readonly accountKey: string;
  readonly sourceEventKey: string;
  readonly chatKey: string;
  readonly senderKey: string;
  readonly state: "composing" | "paused";
  readonly media: "" | "audio";
}

export type WacliWebhookEvent = WacliMessageEvent | WacliReceiptEvent | WacliChatPresenceEvent;

export function verifyWacliWebhookSignature(
  payload: Uint8Array,
  header: string,
  secret: string,
): boolean {
  if (secret.length === 0 || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const received = Buffer.from(header.slice("sha256=".length), "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function parseWacliWebhookEvent(payload: Uint8Array, accountKey: string): WacliWebhookEvent {
  assertAccountKey(accountKey);
  if (payload.byteLength > MAX_WACLI_WEBHOOK_BYTES)
    throw new Error("wacli webhook body exceeds limit");
  const value = parseJson(payload);
  const eventType = optionalString(value, "EventType");
  if (eventType === undefined) return parseMessage(value, accountKey);
  if (eventType === "receipt") return parseReceipt(value, accountKey);
  if (eventType === "chat_presence") return parsePresence(value, accountKey);
  if (
    eventType === "delete_for_me" ||
    eventType === "deleted_for_me" ||
    eventType === "message_delete_for_me"
  )
    return parseDeleteForMe(value, accountKey);
  throw new Error("unsupported wacli webhook event type");
}

export type WacliLifecycleName =
  | "auth_starting"
  | "qr_code"
  | "connected"
  | "disconnected"
  | "stream_replaced"
  | "logged_out"
  | "offline_sync_preview"
  | "offline_sync_completed"
  | "history_sync"
  | "progress"
  | "stale";

export interface WacliLifecycleEvent {
  readonly kind: "lifecycle";
  readonly accountKey: string;
  readonly event: WacliLifecycleName;
  readonly timestampMs: number;
  readonly details: Readonly<Record<string, string | number>>;
}

const LIFECYCLE_NAMES: ReadonlySet<string> = new Set<WacliLifecycleName>([
  "auth_starting",
  "qr_code",
  "connected",
  "disconnected",
  "stream_replaced",
  "logged_out",
  "offline_sync_preview",
  "offline_sync_completed",
  "history_sync",
  "progress",
  "stale",
]);

const LIFECYCLE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  qr_code: ["code"],
  logged_out: ["reason", "reason_code"],
  offline_sync_preview: ["total", "messages", "receipts", "notifications", "app_data_changes"],
  offline_sync_completed: ["count"],
  history_sync: ["conversations"],
  progress: ["messages_synced"],
  stale: ["threshold", "idle_duration", "error_count", "source"],
};

export function parseWacliLifecycleEvent(
  line: Uint8Array,
  accountKey: string,
): WacliLifecycleEvent {
  assertAccountKey(accountKey);
  const value = parseJson(line);
  const event = requiredString(value, "event");
  if (!LIFECYCLE_NAMES.has(event)) throw new Error("unsupported wacli lifecycle event");
  const timestampMs = requiredNumber(value, "ts");
  if (!Number.isInteger(timestampMs) || timestampMs < 0)
    throw new Error("invalid wacli lifecycle timestamp");
  const rawData = optionalRecord(value, "data");
  const details: Record<string, string | number> = {};
  for (const field of LIFECYCLE_FIELDS[event] ?? []) {
    const fieldValue = rawData?.[field];
    if (
      typeof fieldValue === "string" ||
      (typeof fieldValue === "number" && Number.isFinite(fieldValue))
    ) {
      if (typeof fieldValue === "string" && fieldValue.length > MAX_WACLI_TEXT_BYTES) {
        throw new Error("wacli lifecycle field exceeds limit");
      }
      details[field] = fieldValue;
    }
  }
  return {
    kind: "lifecycle",
    accountKey,
    event: event as WacliLifecycleName,
    timestampMs,
    details,
  };
}

function parseMessage(value: Record<string, unknown>, accountKey: string): WacliMessageEvent {
  const chatKey = requiredString(value, "Chat");
  const messageKey = requiredString(value, "ID");
  const senderKey = requiredString(value, "SenderJID");
  const observedAt = timestamp(value, "Timestamp");
  const fromMe = requiredBoolean(value, "FromMe");
  const text = boundedOptionalText(value, "Text");
  const media = parseMedia(value.Media);
  const revoked = optionalBoolean(value, "Revoked") ?? false;
  const deletedForMe = optionalBoolean(value, "DeletedForMe") ?? false;
  return {
    kind: "message",
    accountKey,
    sourceEventKey: `wacli:message:${accountKey}:${chatKey}:${messageKey}${revoked ? ":revoke" : deletedForMe ? ":delete" : ""}`,
    chatKey,
    messageKey,
    senderKey,
    observedAt,
    fromMe,
    ...(text === undefined ? {} : { text }),
    edited: optionalBoolean(value, "Edited") ?? false,
    sourceDeleted: revoked || deletedForMe,
    ...(revoked || deletedForMe
      ? { sourceDeletionKind: revoked ? ("revoke" as const) : ("delete" as const) }
      : {}),
    ...(optionalString(value, "ReplyToID") === undefined
      ? {}
      : { replyToKey: optionalString(value, "ReplyToID") }),
    ...(media === undefined ? {} : { media }),
  };
}

function parseDeleteForMe(value: Record<string, unknown>, accountKey: string): WacliMessageEvent {
  const chatKey = optionalString(value, "ChatJID") ?? requiredString(value, "Chat");
  const messageKey =
    optionalString(value, "MessageID") ??
    optionalString(value, "MessageId") ??
    requiredString(value, "ID");
  const senderKey =
    optionalString(value, "SenderJID") ?? optionalString(value, "Sender") ?? chatKey;
  const observedAt = timestamp(value, "Timestamp");
  const fromMe = optionalBoolean(value, "IsFromMe") ?? optionalBoolean(value, "FromMe") ?? false;
  return {
    kind: "message",
    accountKey,
    sourceEventKey: `wacli:message:${accountKey}:${chatKey}:${messageKey}:delete`,
    chatKey,
    messageKey,
    senderKey,
    observedAt,
    fromMe,
    edited: false,
    sourceDeleted: true,
    sourceDeletionKind: "delete",
  };
}

function parseReceipt(value: Record<string, unknown>, accountKey: string): WacliReceiptEvent {
  const chatKey = requiredString(value, "Chat");
  const senderKey = requiredString(value, "Sender");
  const rawIds = value.MessageIDs;
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > 100) {
    throw new Error("receipt message IDs are invalid");
  }
  const messageKeys = rawIds.map((id) => {
    if (typeof id !== "string" || id.length === 0 || id.length > 256)
      throw new Error("receipt message ID is invalid");
    return id;
  });
  const type = requiredString(value, "Type");
  if (type !== "delivered" && type !== "read" && type !== "played")
    throw new Error("unsupported receipt type");
  return {
    kind: "receipt",
    accountKey,
    sourceEventKey: `wacli:receipt:${accountKey}:${chatKey}:${type}:${messageKeys.join(",")}`,
    chatKey,
    senderKey,
    messageKeys,
    observedAt: timestamp(value, "Timestamp"),
    type,
    fromMe: requiredBoolean(value, "IsFromMe"),
  };
}

function parsePresence(value: Record<string, unknown>, accountKey: string): WacliChatPresenceEvent {
  const state = requiredString(value, "State");
  if (state !== "composing" && state !== "paused")
    throw new Error("unsupported chat presence state");
  const media = requiredString(value, "Media");
  if (media !== "" && media !== "audio") throw new Error("unsupported chat presence media");
  const chatKey = requiredString(value, "Chat");
  const senderKey = requiredString(value, "Sender");
  return {
    kind: "chat_presence",
    accountKey,
    sourceEventKey: `wacli:presence:${accountKey}:${chatKey}:${senderKey}:${state}`,
    chatKey,
    senderKey,
    state,
    media,
  };
}

function parseMedia(value: unknown): WacliMediaMetadata | undefined {
  if (value === null || value === undefined) return undefined;
  const media = asRecord(value);
  const type = requiredString(media, "Type");
  if (
    !(
      [
        "image",
        "video",
        "audio",
        "document",
        "sticker",
        "location",
        "live_location",
        "gif",
      ] as const
    ).includes(type as WacliMediaMetadata["type"])
  ) {
    throw new Error("unsupported wacli media type");
  }
  const fileLength = optionalNumber(media, "FileLength");
  if (
    fileLength !== undefined &&
    (!Number.isInteger(fileLength) || fileLength < 0 || fileLength > MAX_WACLI_MEDIA_BYTES)
  ) {
    throw new Error("wacli media length exceeds limit");
  }
  return {
    type: type as WacliMediaMetadata["type"],
    ...(optionalBoundedString(media, "MimeType", 256) === undefined
      ? {}
      : { mimeType: optionalBoundedString(media, "MimeType", 256) }),
    ...(optionalBoundedString(media, "Filename", 512) === undefined
      ? {}
      : { filename: optionalBoundedString(media, "Filename", 512) }),
    ...(fileLength === undefined ? {} : { fileLength }),
  };
}

function parseJson(payload: Uint8Array): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(payload)) as unknown;
  } catch {
    throw new Error("wacli payload is not valid JSON");
  }
  return asRecord(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("wacli payload must be an object");
  return value as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string" || result.length === 0 || result.length > 4096)
    throw new Error(`wacli field ${field} is invalid`);
  return result;
}

function optionalString(value: Record<string, unknown>, field: string): string | undefined {
  const result = value[field];
  if (result === undefined || result === null) return undefined;
  if (typeof result !== "string" || result.length > 4096)
    throw new Error(`wacli field ${field} is invalid`);
  return result;
}

function optionalBoundedString(
  value: Record<string, unknown>,
  field: string,
  maxBytes: number,
): string | undefined {
  const result = optionalString(value, field);
  if (result !== undefined && new TextEncoder().encode(result).byteLength > maxBytes)
    throw new Error(`wacli field ${field} exceeds limit`);
  return result;
}

function boundedOptionalText(value: Record<string, unknown>, field: string): string | undefined {
  const result = value[field];
  if (result === undefined || result === null) return undefined;
  if (typeof result !== "string") throw new Error(`wacli field ${field} is invalid`);
  if (new TextEncoder().encode(result).byteLength > MAX_WACLI_TEXT_BYTES) {
    throw new Error(`wacli field ${field} exceeds limit`);
  }
  return result;
}

function requiredBoolean(value: Record<string, unknown>, field: string): boolean {
  const result = value[field];
  if (typeof result !== "boolean") throw new Error(`wacli field ${field} is invalid`);
  return result;
}

function optionalBoolean(value: Record<string, unknown>, field: string): boolean | undefined {
  const result = value[field];
  if (result === undefined || result === null) return undefined;
  if (typeof result !== "boolean") throw new Error(`wacli field ${field} is invalid`);
  return result;
}

function requiredNumber(value: Record<string, unknown>, field: string): number {
  const result = value[field];
  if (typeof result !== "number" || !Number.isFinite(result))
    throw new Error(`wacli field ${field} is invalid`);
  return result;
}

function optionalNumber(value: Record<string, unknown>, field: string): number | undefined {
  const result = value[field];
  if (result === undefined || result === null) return undefined;
  return requiredNumber(value, field);
}

function optionalRecord(
  value: Record<string, unknown>,
  field: string,
): Record<string, unknown> | undefined {
  const result = value[field];
  if (result === undefined || result === null) return undefined;
  return asRecord(result);
}

function timestamp(value: Record<string, unknown>, field: string): string {
  const raw = requiredString(value, field);
  if (!raw.endsWith("Z")) throw new Error(`wacli field ${field} is invalid`);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.valueOf())) throw new Error(`wacli field ${field} is invalid`);
  return parsed.toISOString();
}

function assertAccountKey(accountKey: string): void {
  if (!ACCOUNT_KEY.test(accountKey)) throw new Error("wacli account key is invalid");
}

function equalArgs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
