import { createHash } from "node:crypto";

const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** The source-neutral identity vocabulary shared by backup and live adapters. */
export const WHATSAPP_SOURCE_NAMESPACE = "whatsapp-android" as const;

export function whatsappIdentityKey(value: string): string {
  return `whatsapp:identity:${digest(value)}`;
}

export function whatsappPersonKey(value: string): string {
  return `whatsapp:person:${digest(value)}`;
}

export function whatsappConversationKey(value: string): string {
  return `whatsapp:conversation:${digest(value)}`;
}

export function whatsappMessageKey(messageId: string): string {
  return `whatsapp:message:source:${digest(messageId)}`;
}

export function whatsappRevisionKey(messageKey: string, ordinal: number): string {
  return `whatsapp:revision:${digest(`${messageKey}\0${ordinal}`)}`;
}
