import { createHash } from "node:crypto";
import type {
  NormalizedDirection,
  NormalizedMessageKind,
  NormalizedMessageRecord,
  NormalizedMessageMetadata,
  NormalizedRecord,
  NormalizedRevisionRecord,
  WhatsAppAdapterVersion,
} from "./contract.js";
import {
  deriveMessageIdentity,
  MessageIdentityRegistry,
  type MessageIdentityInput,
} from "./message-identity.js";
import type { WhatsAppSqliteFixture } from "./fixtures.js";

type Row = Readonly<Record<string, unknown>>;

export interface MessageMappingOptions {
  /** Stable provenance supplied by the importer; fixtures default to this value. */
  readonly snapshotId?: string;
}

const source = (value: string) => ({ namespace: "whatsapp-android" as const, value });
const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const identityKey = (value: string): string => `whatsapp:identity:${digest(value)}`;
const conversationKey = (value: string): string => `whatsapp:conversation:${digest(value)}`;

/**
 * Normalize message rows without allowing source table vocabulary to escape
 * this adapter. The mapper is deliberately pure and never persists data.
 */
export function normalizeWhatsAppMessages(
  fixture: Pick<WhatsAppSqliteFixture, "version" | "rows">,
  options: MessageMappingOptions = {},
): readonly NormalizedRecord[] {
  const snapshotId = options.snapshotId ?? "fixture";
  const version = fixture.version;
  const messageTable = version === "android-current.v1" ? "message" : "messages";
  const editTable = version === "android-current.v1" ? "message_edit" : "message_edits";
  const messages = rows(fixture, messageTable);
  const edits = rows(fixture, editTable);
  const registry = new MessageIdentityRegistry();
  const byRow = new Map<number, NormalizedMessageRecord>();
  const jidByRow = new Map<number, string>();
  const chatByRow = new Map<number, string>();
  const result: NormalizedRecord[] = [];

  if (version === "android-current.v1") {
    for (const row of rows(fixture, "jid")) {
      const id = number(row._id);
      const raw = stringValue(row.raw_string);
      if (id !== undefined && raw) jidByRow.set(id, raw);
    }
    for (const row of rows(fixture, "chat")) {
      const id = number(row._id);
      const jid = jidByRow.get(number(row.jid_row_id) ?? -1);
      if (id !== undefined && jid) chatByRow.set(id, jid);
    }
  }

  for (const row of messages) {
    const conversation = conversationFor(version, row, chatByRow);
    const sender = senderFor(version, row, jidByRow);
    const direction = directionFor(version, row);
    const timestamp = timestampFor(row.timestamp);
    const nativeCode = number(row.message_type ?? row.media_wa_type);
    const messageKind = kindFor(nativeCode);
    const identityInput: MessageIdentityInput = {
      adapterVersion: version,
      conversationKey: conversation,
      ...(sender ? { senderIdentityKey: sender } : {}),
      timestamp,
      direction,
      messageKind,
      ...sourceIdFor(version, row),
    };
    const registration = registry.register(identityInput);
    const stableKey =
      registration.kind === "accepted"
        ? registration.identity.stableKey
        : `whatsapp:message:${version}:collision:${digest(JSON.stringify([row._id, timestamp, conversation]))}`;
    const body = bodyFor(row.text_data ?? row.data);
    const record: NormalizedMessageRecord = {
      kind: "message",
      stableKey,
      source: source(sourceIdFor(version, row).sourceMessageId ?? "unknown"),
      conversationKey: conversation,
      ...(sender ? { senderIdentityKey: sender } : {}),
      timestamp,
      direction,
      messageKind: registration.kind === "collision" ? "unsupported" : messageKind,
      ...(body.value !== undefined ? { body: body.value } : {}),
      bodyState: body.state,
      ...metadataFor(row),
      ...(number(row.quoted_message_id ?? row.quoted_row_id) !== undefined
        ? { replyToKey: "pending" }
        : {}),
      ...(messageKind === "unsupported" && nativeCode !== undefined
        ? { unsupportedTypeCode: nativeCode }
        : {}),
    };
    byRow.set(number(row._id) ?? -1, record);
    result.push(record);
  }

  // Reaction targets are resolved only after all source rows have identities.
  for (const row of messages) {
    const record = byRow.get(number(row._id) ?? -1);
    const target = byRow.get(number(row.reaction_target_id) ?? -1);
    if (!record || record.messageKind !== "reaction" || !target) continue;
    const index = result.indexOf(record);
    if (index < 0) continue;
    result[index] = {
      ...record,
      metadata: { ...record.metadata, reactsToKey: target.stableKey },
    };
  }

  // Resolve replies only after every stable key has been derived.
  for (const row of messages) {
    const record = byRow.get(number(row._id) ?? -1);
    const quoted = number(row.quoted_message_id ?? row.quoted_row_id);
    if (!record || quoted === undefined) continue;
    const target = byRow.get(quoted);
    const index = result.indexOf(record);
    result[index] = target ? { ...record, replyToKey: target.stableKey } : withoutReply(record);
  }

  for (const row of edits) {
    const message = byRow.get(number(row.message_id) ?? -1);
    const ordinal = number(row.edit_version);
    if (!message || ordinal === undefined || ordinal < 1) continue;
    const body = bodyFor(row.text_data ?? row.data);
    const revision: NormalizedRevisionRecord = {
      kind: "revision",
      stableKey: `whatsapp:revision:${digest(`${message.stableKey}\0${ordinal}`)}`,
      messageKey: message.stableKey,
      revisionOrdinal: ordinal,
      ...(body.value !== undefined ? { body: body.value } : {}),
      bodyState: body.state,
      firstSeenSnapshotId: snapshotId,
    };
    result.push(revision);
  }

  return result.sort((a, b) => recordKey(a).localeCompare(recordKey(b)));
}

/** Compatibility name for callers describing this operation as text history. */
export const normalizeWhatsAppTextHistory = normalizeWhatsAppMessages;

function rows(fixture: Pick<WhatsAppSqliteFixture, "rows">, table: string): readonly Row[] {
  return (fixture.rows[table] ?? []) as readonly Row[];
}
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
function conversationFor(
  version: WhatsAppAdapterVersion,
  row: Row,
  chatByRow: ReadonlyMap<number, string>,
): string {
  const remote = stringValue(row.key_remote_jid);
  if (remote) return conversationKey(remote);
  const currentRemote = chatByRow.get(number(row.chat_row_id) ?? -1);
  if (currentRemote) return conversationKey(currentRemote);
  // Current rows carry a numeric JID reference. Keep the key deterministic
  // when the referenced JID is damaged or absent, without exposing row ids.
  return conversationKey(`chat:${String(row.chat_row_id ?? "unknown")}`);
}
function senderFor(
  version: WhatsAppAdapterVersion,
  row: Row,
  jidByRow: ReadonlyMap<number, string>,
): string | undefined {
  const raw =
    stringValue(row.participant_hash) ??
    stringValue(row.sender_jid) ??
    jidByRow.get(number(row.sender_jid_row_id) ?? -1);
  return raw ? identityKey(raw) : undefined;
}
function directionFor(version: WhatsAppAdapterVersion, row: Row): NormalizedDirection {
  const value = row.from_me ?? row.key_from_me;
  return value === 1 || value === true
    ? "sent"
    : value === 0 || value === false
      ? "received"
      : "unknown";
}
function timestampFor(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function kindFor(code: number | undefined): NormalizedMessageKind {
  if (code === 0 || code === 1) return "text";
  if (code === 2) return "image";
  if (code === 3) return "audio";
  if (code === 4) return "video";
  if (code === 5) return "contact";
  if (code === 6) return "location";
  if (code === 7) return "document";
  if (code === 8) return "sticker";
  if (code === 9) return "reaction";
  if (code === 10) return "system";
  return "unsupported";
}
function boundedText(value: unknown, max = 512): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}
function boundedNumber(value: unknown, min?: number, max?: number): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    (min === undefined || value >= min) &&
    (max === undefined || value <= max)
    ? value
    : undefined;
}
function metadataFor(row: Row): Pick<NormalizedMessageRecord, "metadata"> {
  const mimeType = boundedText(row.media_mime_type, 128);
  const filename = boundedText(row.media_name, 255);
  const metadata: NormalizedMessageMetadata = {
    ...(boundedText(row.media_caption) ? { caption: boundedText(row.media_caption) } : {}),
    ...(mimeType && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/iu.test(mimeType)
      ? { mimeType: mimeType.toLowerCase() }
      : {}),
    ...(filename && !/[\\/\0]/u.test(filename) ? { filename } : {}),
    ...(boundedNumber(row.media_width, 1, 100_000)
      ? { width: boundedNumber(row.media_width, 1, 100_000) }
      : {}),
    ...(boundedNumber(row.media_height, 1, 100_000)
      ? { height: boundedNumber(row.media_height, 1, 100_000) }
      : {}),
    ...(boundedNumber(row.media_duration_ms, 0, 86_400_000) !== undefined
      ? { durationMs: boundedNumber(row.media_duration_ms, 0, 86_400_000) }
      : {}),
    ...(boundedNumber(row.latitude, -90, 90) !== undefined
      ? { latitude: boundedNumber(row.latitude, -90, 90) }
      : {}),
    ...(boundedNumber(row.longitude, -180, 180) !== undefined
      ? { longitude: boundedNumber(row.longitude, -180, 180) }
      : {}),
    ...(boundedText(row.contact_name, 255)
      ? { contactName: boundedText(row.contact_name, 255) }
      : {}),
    ...(boundedText(row.contact_phone, 64)
      ? { contactPhone: boundedText(row.contact_phone, 64) }
      : {}),
    ...(row.sticker_animated === 1 || row.sticker_animated === true
      ? { stickerAnimated: true }
      : {}),
    ...(boundedText(row.reaction_text, 32)
      ? { reactionEmoji: boundedText(row.reaction_text, 32) }
      : {}),
    ...(boundedText(row.event_type, 128) ? { sourceEvent: boundedText(row.event_type, 128) } : {}),
  };
  return Object.keys(metadata).length > 0 ? { metadata } : {};
}
function bodyFor(value: unknown): { value?: string; state: "present" | "missing" | "damaged" } {
  if (value === null || value === undefined || value === "") return { state: "missing" };
  if (typeof value !== "string") return { state: "damaged" };
  if (value.includes("\0") || /[\uFFFD]/u.test(value)) return { state: "damaged" };
  return { value, state: "present" };
}
function sourceIdFor(
  version: WhatsAppAdapterVersion,
  row: Row,
): Pick<MessageIdentityInput, "sourceMessageId"> {
  const id =
    version === "android-legacy.v1"
      ? stringValue(row.key_id)
      : stringValue(row.key_id ?? row.message_id);
  return id ? { sourceMessageId: id } : {};
}
function withoutReply(record: NormalizedMessageRecord): NormalizedMessageRecord {
  const { replyToKey: _replyToKey, ...rest } = record;
  return rest;
}
function recordKey(record: NormalizedRecord): string {
  return record.kind === "participant"
    ? `${record.conversationKey}:${record.identityKey}`
    : record.stableKey;
}
