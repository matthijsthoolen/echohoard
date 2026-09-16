import { createHash } from "node:crypto";
import type {
  ImportConversationRecord,
  ImportMessageRecord,
  ImportParticipantRecord,
  ImportRecord,
  ImportRevisionRecord,
  ImportAttachmentRecord,
} from "../../application/text-import.js";
import type { WacliMessageEvent, WacliWebhookEvent } from "./contract.js";

const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const source = (value: string) => ({ namespace: "whatsapp-wacli", value });

/** Converts the versioned wacli envelope to the adapter-neutral import contract.
 * Upstream names and event shapes stop at this boundary. */
export function normalizeWacliEvent(event: WacliWebhookEvent): readonly ImportRecord[] {
  if (event.kind !== "message") return [unsupportedEvent(event)];
  return normalizeMessage(event);
}

function normalizeMessage(event: WacliMessageEvent): readonly ImportRecord[] {
  const conversationKey = `wacli:conversation:${digest(event.chatKey)}`;
  const identityKey = `wacli:identity:${digest(event.senderKey)}`;
  const personKey = `wacli:person:${digest(event.senderKey)}`;
  const messageKey = `wacli:message:${digest(`${event.chatKey}\0${event.messageKey}`)}`;
  const records: ImportRecord[] = [
    { kind: "person", stableKey: personKey },
    { kind: "identity", stableKey: identityKey, source: source(event.senderKey), personKey },
    {
      kind: "conversation",
      stableKey: conversationKey,
      source: source(event.chatKey),
      conversationKind: event.chatKey.endsWith("@g.us") ? "group" : "direct",
    } satisfies ImportConversationRecord,
    {
      kind: "participant",
      conversationKey,
      identityKey,
      role: "unknown",
    } satisfies ImportParticipantRecord,
    {
      kind: "message",
      stableKey: messageKey,
      source: source(event.messageKey),
      conversationKey,
      senderIdentityKey: identityKey,
      timestamp: event.observedAt,
      direction: event.fromMe ? "sent" : "received",
      messageKind: event.media?.type ?? (event.text === undefined ? "unsupported" : "text"),
      ...(event.text === undefined ? {} : { body: event.text }),
      bodyState: event.text === undefined ? "unavailable" : "present",
      ...(event.replyToKey
        ? { replyToKey: `wacli:message:${digest(`${event.chatKey}\0${event.replyToKey}`)}` }
        : {}),
      ...(event.media ? { metadata: { media: event.media } } : {}),
    } satisfies ImportMessageRecord,
  ];
  if (event.edited)
    records.push({
      kind: "revision",
      stableKey: `${messageKey}:edited`,
      messageKey,
      revisionOrdinal: 1,
      ...(event.text === undefined ? {} : { body: event.text }),
      bodyState: event.text === undefined ? "unavailable" : "present",
      firstSeenSnapshotId: "live",
    } satisfies ImportRevisionRecord);
  if (event.media)
    records.push({
      kind: "attachment",
      stableKey: `${messageKey}:media`,
      messageKey,
      sha256: digest(`wacli-media:${event.sourceEventKey}`),
      availability: "missing",
      ...(event.media.filename ? { originalName: event.media.filename } : {}),
      ...(event.media.mimeType ? { mimeType: event.media.mimeType } : {}),
      ...(event.media.fileLength === undefined ? {} : { byteSize: event.media.fileLength }),
      sourceMetadata: { mediaType: event.media.type },
    } satisfies ImportAttachmentRecord);
  return records;
}

function unsupportedEvent(
  event: Exclude<WacliWebhookEvent, WacliMessageEvent>,
): ImportMessageRecord {
  const key = `wacli:unsupported:${digest(event.sourceEventKey)}`;
  return {
    kind: "message",
    stableKey: key,
    source: source(event.sourceEventKey),
    conversationKey: `wacli:conversation:${digest(event.chatKey)}`,
    timestamp: event.kind === "receipt" ? event.observedAt : null,
    direction: "unknown",
    messageKind: "unsupported",
    bodyState: "unsupported",
    metadata: { unsupportedEventKind: event.kind },
  };
}
