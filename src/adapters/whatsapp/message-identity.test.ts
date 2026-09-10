import { describe, expect, it } from "vitest";
import {
  deriveMessageIdentity,
  MessageIdentityRegistry,
  MESSAGE_FALLBACK_VERSION,
  type MessageIdentityInput,
} from "./message-identity.js";

const base: MessageIdentityInput = {
  adapterVersion: "android-current.v1",
  conversationKey: "whatsapp:conversation:chat-a",
  senderIdentityKey: "whatsapp:identity:sender-a",
  timestamp: "2023-11-14T22:13:20.000Z",
  direction: "received",
  messageKind: "text",
};

describe("WhatsApp message identities", () => {
  it("prefers source IDs and ignores row ordering", () => {
    const a = deriveMessageIdentity({ ...base, sourceMessageId: "source-a" });
    const b = deriveMessageIdentity({ ...base, sourceMessageId: "source-a", timestamp: null });
    expect(a).toEqual({ ...a, stableKey: b.stableKey });
    expect(a.usedFallback).toBe(false);
    expect(a.diagnostic).toBe("source-id");
    expect(a.stableKey).not.toMatch(/row|_id/);
  });

  it("uses stanza IDs when source message IDs are absent", () => {
    const identity = deriveMessageIdentity({ ...base, stanzaId: "stanza-a" });
    expect(identity.diagnostic).toBe("stanza-id");
    expect(identity.usedFallback).toBe(false);
  });

  it("produces deterministic versioned fallback keys", () => {
    const first = deriveMessageIdentity(base);
    const second = deriveMessageIdentity({ ...base });
    expect(first).toEqual(second);
    expect(first.usedFallback).toBe(true);
    expect(first.fallbackVersion).toBe(MESSAGE_FALLBACK_VERSION);
    expect(first.stableKey).toContain(`fallback:${MESSAGE_FALLBACK_VERSION}:`);
  });

  it("rejects a fallback collision instead of silently merging", () => {
    const registry = new MessageIdentityRegistry();
    expect(registry.register(base).kind).toBe("accepted");
    const collision = registry.register({ ...base, sourceMessageId: "source-a" });
    expect(collision.kind).toBe("accepted");
    const conflicting = registry.register({
      ...base,
      sourceMessageId: "source-a",
      conversationKey: "whatsapp:conversation:other",
    });
    expect(conflicting).toEqual({
      kind: "collision",
      collision: {
        stableKey: deriveMessageIdentity({ ...base, sourceMessageId: "source-a" }).stableKey,
        diagnostic: "message-identity-collision",
      },
    });
  });

  it("does not let blank identifiers override the fallback", () => {
    const identity = deriveMessageIdentity({ ...base, sourceMessageId: "  ", stanzaId: "" });
    expect(identity.usedFallback).toBe(true);
  });
});
