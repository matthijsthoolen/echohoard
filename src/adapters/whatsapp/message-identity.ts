import { createHash } from "node:crypto";
import type {
  NormalizedMessageKind,
  NormalizedDirection,
  WhatsAppAdapterVersion,
} from "./contract.js";

/** Version of the canonical fallback input. Changing it intentionally changes keys. */
export const MESSAGE_FALLBACK_VERSION = "v1" as const;

export interface MessageIdentityInput {
  readonly adapterVersion: WhatsAppAdapterVersion;
  readonly conversationKey: string;
  readonly senderIdentityKey?: string;
  readonly timestamp: string | null;
  readonly direction: NormalizedDirection;
  readonly messageKind: NormalizedMessageKind;
  /** Source-provided message key, when available. */
  readonly sourceMessageId?: string;
  /** Source-provided stanza key, used when a message key is absent. */
  readonly stanzaId?: string;
}

export interface DerivedMessageIdentity {
  readonly stableKey: string;
  readonly usedFallback: boolean;
  readonly fallbackVersion?: typeof MESSAGE_FALLBACK_VERSION;
  /** Safe metadata for audit logs; it contains no source content or row ids. */
  readonly diagnostic: "source-id" | "stanza-id" | "fallback";
}

export interface MessageIdentityCollision {
  readonly stableKey: string;
  readonly diagnostic: "message-identity-collision";
}

export type MessageIdentityRegistration =
  | { readonly kind: "accepted"; readonly identity: DerivedMessageIdentity }
  | { readonly kind: "collision"; readonly collision: MessageIdentityCollision };

const clean = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/**
 * Derive a durable key from source identifiers or stable normalized fields.
 * SQLite row ids are deliberately not accepted by this contract.
 */
export function deriveMessageIdentity(input: MessageIdentityInput): DerivedMessageIdentity {
  const sourceMessageId = clean(input.sourceMessageId);
  if (sourceMessageId)
    return {
      stableKey: `whatsapp:message:${input.adapterVersion}:source:${digest(sourceMessageId)}`,
      usedFallback: false,
      diagnostic: "source-id",
    };
  const stanzaId = clean(input.stanzaId);
  if (stanzaId)
    return {
      stableKey: `whatsapp:message:${input.adapterVersion}:stanza:${digest(stanzaId)}`,
      usedFallback: false,
      diagnostic: "stanza-id",
    };

  const canonical = [
    MESSAGE_FALLBACK_VERSION,
    input.adapterVersion,
    input.conversationKey,
    input.senderIdentityKey ?? "",
    input.timestamp ?? "",
    input.direction,
    input.messageKind,
  ].join("\u001f");
  return {
    stableKey: `whatsapp:message:${input.adapterVersion}:fallback:${MESSAGE_FALLBACK_VERSION}:${digest(canonical)}`,
    usedFallback: true,
    fallbackVersion: MESSAGE_FALLBACK_VERSION,
    diagnostic: "fallback",
  };
}

/**
 * Register identities in source order while rejecting a key reused for a
 * different canonical record. Callers can quarantine collisions without
 * silently merging evidence.
 */
export class MessageIdentityRegistry {
  private readonly records = new Map<string, string>();

  register(input: MessageIdentityInput): MessageIdentityRegistration {
    const identity = deriveMessageIdentity(input);
    const canonical = canonicalInput(input);
    const previous = this.records.get(identity.stableKey);
    if (previous !== undefined && previous !== canonical)
      return {
        kind: "collision",
        collision: { stableKey: identity.stableKey, diagnostic: "message-identity-collision" },
      };
    this.records.set(identity.stableKey, canonical);
    return { kind: "accepted", identity };
  }
}

function canonicalInput(input: MessageIdentityInput): string {
  return JSON.stringify([
    input.adapterVersion,
    clean(input.sourceMessageId) ?? null,
    clean(input.stanzaId) ?? null,
    input.conversationKey,
    input.senderIdentityKey ?? null,
    input.timestamp,
    input.direction,
    input.messageKind,
  ]);
}
