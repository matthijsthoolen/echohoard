/**
 * The WhatsApp boundary is deliberately the only place that knows the
 * decrypted Android database vocabulary.  Everything exported from this file
 * is either a schema-selection result or a source-neutral normalized record.
 * Application services must consume the latter and never inspect a database
 * table, column, row id, JID, LID, or native type code themselves.
 */

export const WHATSAPP_ADAPTER_CONTRACT_VERSION = "whatsapp-android-contract.v1" as const;

export type WhatsAppAdapterVersion = "android-current.v1" | "android-legacy.v1";

export type NormalizedMessageKind =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "location"
  | "contact"
  | "sticker"
  | "system"
  | "unsupported";

export type NormalizedConversationKind = "direct" | "group" | "broadcast" | "unknown";
export type NormalizedDirection = "sent" | "received" | "system" | "unknown";

/** A stable identifier observed in the source, never a database row id. */
export interface NormalizedSourceReference {
  readonly namespace: "whatsapp-android";
  readonly value: string;
}

/** An identifier or name observed for a person; exact linking is a later policy. */
export interface NormalizedIdentityRecord {
  readonly kind: "identity";
  readonly stableKey: string;
  readonly source: NormalizedSourceReference;
  readonly personKey?: string;
  readonly displayName?: string;
}

export interface NormalizedPersonRecord {
  readonly kind: "person";
  readonly stableKey: string;
  readonly displayName?: string;
  readonly identities: readonly NormalizedSourceReference[];
}

export interface NormalizedConversationRecord {
  readonly kind: "conversation";
  readonly stableKey: string;
  readonly source: NormalizedSourceReference;
  readonly conversationKind: NormalizedConversationKind;
  readonly title?: string;
}

export interface NormalizedParticipantRecord {
  readonly kind: "participant";
  readonly conversationKey: string;
  readonly identityKey: string;
  readonly role: "member" | "owner" | "unknown";
}

export interface NormalizedRevisionRecord {
  readonly kind: "revision";
  readonly stableKey: string;
  readonly messageKey: string;
  readonly revisionOrdinal: number;
  readonly body?: string;
  readonly bodyState: "present" | "missing" | "damaged";
  readonly firstSeenSnapshotId: string;
}

export interface NormalizedMessageRecord {
  readonly kind: "message";
  readonly stableKey: string;
  readonly source: NormalizedSourceReference;
  readonly conversationKey: string;
  readonly senderIdentityKey?: string;
  readonly timestamp: string | null;
  readonly direction: NormalizedDirection;
  readonly messageKind: NormalizedMessageKind;
  readonly body?: string;
  readonly bodyState: "present" | "missing" | "damaged";
  readonly replyToKey?: string;
  /** Retain an unmapped native message code as inert evidence. */
  readonly unsupportedTypeCode?: number;
}

export type NormalizedRecord =
  | NormalizedPersonRecord
  | NormalizedIdentityRecord
  | NormalizedConversationRecord
  | NormalizedParticipantRecord
  | NormalizedMessageRecord
  | NormalizedRevisionRecord;

export interface WhatsAppAdapter {
  readonly version: WhatsAppAdapterVersion;
  readonly contractVersion: typeof WHATSAPP_ADAPTER_CONTRACT_VERSION;
}

export type UnsupportedSchemaReason = "unknown" | "ambiguous";

export interface SupportedSchemaSelection {
  readonly kind: "supported";
  readonly adapter: WhatsAppAdapter;
  readonly fingerprint: WhatsAppAdapterVersion;
}

export interface UnsupportedSchemaSelection {
  readonly kind: "unsupported";
  readonly reason: UnsupportedSchemaReason;
  /** A stable diagnostic, with no table names, columns, paths, or source data. */
  readonly diagnostic: "unsupported-whatsapp-schema" | "ambiguous-whatsapp-schema";
}

export type SchemaSelection = SupportedSchemaSelection | UnsupportedSchemaSelection;

/**
 * Adapter-local schema observation used by selection and synthetic tests.
 * This intentionally never leaves `src/adapters/whatsapp`; it models the
 * read-only metadata collected from a decrypted source without opening it or
 * returning source rows.
 */
export type SqliteSchemaShape = Readonly<Record<string, readonly string[]>>;

const CURRENT_REQUIRED: Readonly<Record<string, readonly string[]>> = {
  message: ["_id", "chat_row_id", "from_me", "timestamp", "message_type", "text_data"],
  chat: ["_id", "jid_row_id"],
  jid: ["_id", "raw_string"],
};

const LEGACY_REQUIRED: Readonly<Record<string, readonly string[]>> = {
  messages: ["_id", "key_remote_jid", "key_from_me", "timestamp", "media_wa_type", "data"],
};

const hasShape = (
  schema: SqliteSchemaShape,
  required: Readonly<Record<string, readonly string[]>>,
): boolean =>
  Object.entries(required).every(([table, columns]) => {
    const actual = schema[table];
    return actual !== undefined && columns.every((column) => actual.includes(column));
  });

/**
 * Selects exactly one known structural family.  A table name alone is not a
 * fingerprint: required columns must also be present.  If both families
 * match, selection fails closed because choosing one could silently discard
 * history.  Future variants must add a new version and focused tests here.
 */
export function selectWhatsAppAndroidAdapter(schema: SqliteSchemaShape): SchemaSelection {
  const current = hasShape(schema, CURRENT_REQUIRED);
  const legacy = hasShape(schema, LEGACY_REQUIRED);
  if (current && legacy)
    return { kind: "unsupported", reason: "ambiguous", diagnostic: "ambiguous-whatsapp-schema" };
  if (!current && !legacy)
    return { kind: "unsupported", reason: "unknown", diagnostic: "unsupported-whatsapp-schema" };
  const version: WhatsAppAdapterVersion = current ? "android-current.v1" : "android-legacy.v1";
  return {
    kind: "supported",
    fingerprint: version,
    adapter: { version, contractVersion: WHATSAPP_ADAPTER_CONTRACT_VERSION },
  };
}
