import { createHash } from "node:crypto";
import type {
  NormalizedConversationRecord,
  NormalizedIdentityRecord,
  NormalizedParticipantRecord,
  NormalizedPersonRecord,
  NormalizedRecord,
  WhatsAppAdapterVersion,
} from "./contract.js";
import type { WhatsAppSqliteFixture } from "./fixtures.js";

type Row = Readonly<Record<string, boolean | number | string | null>>;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const identityKey = (value: string): string =>
  `whatsapp:identity:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const personKey = (value: string): string => `whatsapp:person:${identityKey(value).slice(-64)}`;
const conversationKey = (value: string): string =>
  `whatsapp:conversation:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const source = (value: string) => ({ namespace: "whatsapp-android" as const, value });

/**
 * Read-only normalization of the two supported synthetic/source shapes.
 * SQLite row identifiers are used only while resolving references and never
 * appear in the returned records. Exact source identifiers are the only link
 * between observations; names are deliberately not used for identity.
 */
export function normalizeWhatsAppIdentitiesAndConversations(
  fixture: Pick<WhatsAppSqliteFixture, "version" | "rows">,
): readonly NormalizedRecord[] {
  const identities = new Map<string, NormalizedIdentityRecord>();
  const people = new Map<string, NormalizedPersonRecord>();
  const conversations = new Map<string, NormalizedConversationRecord>();
  const participants = new Map<string, NormalizedParticipantRecord>();
  const jidByRow = new Map<number, string>();
  const conversationByRow = new Map<number, string>();

  const observeIdentity = (raw: unknown, displayName?: unknown): string => {
    const value = typeof raw === "string" && raw.length > 0 ? raw : "unknown";
    const key = identityKey(value);
    const existing = identities.get(key);
    if (!existing) {
      const person = isPersonIdentifier(value) ? personKey(value) : undefined;
      identities.set(key, {
        kind: "identity",
        stableKey: key,
        source: source(value),
        ...(person ? { personKey: person } : {}),
        ...(text(displayName) ? { displayName: text(displayName) } : {}),
      });
      if (person && !people.has(person))
        people.set(person, {
          kind: "person",
          stableKey: person,
          ...(text(displayName) ? { displayName: text(displayName) } : {}),
          identities: [source(value)],
        });
    }
    return key;
  };

  if (fixture.version === "android-current.v1") {
    for (const row of rows(fixture, "jid")) {
      const id = number(row._id);
      const raw = text(row.raw_string);
      if (id !== undefined) jidByRow.set(id, observeIdentity(raw, row.display_name));
    }
    for (const row of rows(fixture, "chat")) {
      const id = number(row._id);
      const jid =
        number(row.jid_row_id) === undefined ? undefined : jidByRow.get(number(row.jid_row_id)!);
      const identity = jid ? identities.get(jid) : undefined;
      if (id === undefined || !identity) continue;
      const key = conversationKey(identity.source.value);
      conversationByRow.set(id, key);
      if (!conversations.has(key))
        conversations.set(key, {
          kind: "conversation",
          stableKey: key,
          source: identity.source,
          conversationKind: row.is_group === 1 ? "group" : kindFor(identity.source.value),
          ...(text(row.subject) ? { title: text(row.subject) } : {}),
        });
    }
    for (const row of rows(fixture, "chat_participant")) {
      const conversation = conversationByRow.get(number(row.chat_row_id) ?? -1);
      const identity = jidByRow.get(number(row.jid_row_id) ?? -1);
      if (conversation && identity) addParticipant(participants, conversation, identity, row.role);
    }
  } else {
    for (const row of rows(fixture, "participants")) observeIdentity(row.identity);
    for (const row of rows(fixture, "chats")) {
      const jid = text(row.key_remote_jid);
      if (!jid) continue;
      const identity = identities.get(observeIdentity(jid));
      if (!identity) continue;
      const key = conversationKey(jid);
      conversations.set(key, {
        kind: "conversation",
        stableKey: key,
        source: identity.source,
        conversationKind: row.is_group === 1 ? "group" : kindFor(jid),
        ...(text(row.subject) ? { title: text(row.subject) } : {}),
      });
      const id = number(row._id);
      if (id !== undefined) conversationByRow.set(id, key);
    }
    for (const row of rows(fixture, "participants")) {
      const conversation = conversationByRow.get(number(row.chat_id) ?? -1);
      const identity = text(row.identity)
        ? observeIdentity(row.identity)
        : observeIdentity(undefined);
      if (conversation) addParticipant(participants, conversation, identity, row.role);
    }
  }

  return [
    ...people.values(),
    ...identities.values(),
    ...conversations.values(),
    ...participants.values(),
  ].sort((a, b) => recordSortKey(a).localeCompare(recordSortKey(b)));
}

function recordSortKey(record: NormalizedRecord): string {
  if (record.kind === "participant")
    return `${record.kind}:${record.conversationKey}:${record.identityKey}`;
  return `${record.kind}:${record.stableKey}`;
}

function rows(fixture: Pick<WhatsAppSqliteFixture, "rows">, table: string): readonly Row[] {
  return (fixture.rows[table] ?? []) as readonly Row[];
}
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}
function isPersonIdentifier(value: string): boolean {
  return value !== "unknown" && !value.endsWith("@g.us") && !value.endsWith("@broadcast");
}
function kindFor(value: string): NormalizedConversationRecord["conversationKind"] {
  if (value.endsWith("@broadcast")) return "broadcast";
  if (value.includes("@")) return "direct";
  return "unknown";
}
function addParticipant(
  target: Map<string, NormalizedParticipantRecord>,
  conversationKey: string,
  identityKeyValue: string,
  role: unknown,
): void {
  const normalizedRole: NormalizedParticipantRecord["role"] =
    role === "owner" || role === "member" ? role : "unknown";
  const key = `${conversationKey}:${identityKeyValue}`;
  if (!target.has(key))
    target.set(key, {
      kind: "participant",
      conversationKey,
      identityKey: identityKeyValue,
      role: normalizedRole,
    });
}

export const adapterVersionFor = (
  fixture: Pick<WhatsAppSqliteFixture, "version">,
): WhatsAppAdapterVersion => fixture.version;
