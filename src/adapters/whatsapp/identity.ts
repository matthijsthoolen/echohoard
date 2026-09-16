import { createHash } from "node:crypto";

const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** The source-neutral identity vocabulary shared by backup and live adapters. */
export const WHATSAPP_SOURCE_NAMESPACE = "whatsapp-android" as const;

export function whatsappIdentityKey(accountScope: string, value: string): string {
  return `whatsapp:identity:${digest(`${accountScope}\0${value}`)}`;
}

export function whatsappPersonKey(accountScope: string, value: string): string {
  return `whatsapp:person:${digest(`${accountScope}\0${value}`)}`;
}

export function whatsappConversationKey(accountScope: string, value: string): string {
  return `whatsapp:conversation:${digest(`${accountScope}\0${value}`)}`;
}

export function whatsappMessageKey(
  accountScope: string,
  chatKey: string,
  messageId: string,
): string {
  return `whatsapp:message:source:${digest(`${accountScope}\0${chatKey}\0${messageId}`)}`;
}

export function whatsappRevisionKey(messageKey: string, ordinal: number): string {
  return `whatsapp:revision:${digest(`${messageKey}\0${ordinal}`)}`;
}
