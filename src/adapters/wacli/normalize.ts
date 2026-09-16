import type {
  ImportConversationRecord,
  ImportMessageRecord,
  ImportParticipantRecord,
  ImportRecord,
  ImportRevisionRecord,
  ImportAttachmentRecord,
} from "../../application/text-import";
import type { WacliMessageEvent, WacliWebhookEvent } from "./contract";
import {
  whatsappConversationKey,
  whatsappIdentityKey,
  whatsappMessageKey,
  whatsappRevisionKey,
  whatsappPersonKey,
  WHATSAPP_SOURCE_NAMESPACE,
} from "../whatsapp/identity";

const source = (value: string) => ({ namespace: WHATSAPP_SOURCE_NAMESPACE, value });

/** Converts the versioned wacli envelope to the adapter-neutral import contract.
 * Upstream names and event shapes stop at this boundary. */
export function normalizeWacliEvent(
  event: WacliWebhookEvent,
  accountScope = event.accountKey,
): readonly ImportRecord[] {
  if (event.kind !== "message") return unsupportedEvent(event, accountScope);
  return normalizeMessage(event, accountScope);
}

function normalizeMessage(event: WacliMessageEvent, accountScope: string): readonly ImportRecord[] {
  const conversationKey = whatsappConversationKey(accountScope, event.chatKey);
  const identityKey = whatsappIdentityKey(accountScope, event.senderKey);
  const personKey = whatsappPersonKey(accountScope, event.senderKey);
  const messageKey = whatsappMessageKey(accountScope, event.chatKey, event.messageKey);
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
        ? { replyToKey: whatsappMessageKey(event.accountKey, event.chatKey, event.replyToKey) }
        : {}),
      ...(event.media ? { metadata: { media: event.media } } : {}),
    } satisfies ImportMessageRecord,
  ];
  if (event.edited)
    records.push({
      kind: "revision",
      // Backup adapters derive the revision identity from the canonical
      // message key and ordinal. Keep live edits on that same contract so
      // either source can confirm the other without creating a second row.
      stableKey: whatsappRevisionKey(messageKey, 1),
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
      sha256: whatsappMessageKey(accountScope, event.chatKey, `${event.messageKey}\0media`).slice(
        -64,
      ),
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
  accountScope = event.accountKey,
): readonly ImportRecord[] {
  const conversationKey = whatsappConversationKey(accountScope, event.chatKey);
  const identityKey = whatsappIdentityKey(accountScope, event.senderKey);
  const personKey = whatsappPersonKey(accountScope, event.senderKey);
  const key = whatsappMessageKey(
    accountScope,
    event.chatKey,
    `unsupported\0${event.sourceEventKey}`,
  );
  return [
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
      stableKey: key,
      source: source(event.sourceEventKey),
      conversationKey,
      timestamp: event.kind === "receipt" ? event.observedAt : null,
      direction: "unknown",
      messageKind: "unsupported",
      bodyState: "unsupported",
      metadata: { unsupportedEventKind: event.kind },
    } satisfies ImportMessageRecord,
  ];
}
