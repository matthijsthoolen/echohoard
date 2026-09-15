import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  WACLI_CONTRACT_VERSION,
  WACLI_FORBIDDEN_COMMANDS,
  WACLI_PROTECTED_SECRET_PLACEHOLDER,
  WACLI_UPSTREAM_PIN,
  buildWacliInvocation,
  isAllowedWacliInvocation,
  isForbiddenWacliCommand,
  parseWacliLifecycleEvent,
  parseWacliWebhookEvent,
  verifyWacliWebhookSignature,
} from "./contract.js";

interface WacliFixture {
  readonly contractVersion: string;
  readonly accountKey: string;
  readonly lifecycle: readonly { readonly line: string; readonly expectedEvent: string }[];
  readonly webhooks: Readonly<Record<string, string>>;
}

const fixture = JSON.parse(
  readFileSync(new URL("../../../fixtures/wacli/wacli-contract.v1.json", import.meta.url), "utf8"),
) as WacliFixture;

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("wacli integration contract", () => {
  it("records the immutable, licensed, verified upstream tuple", () => {
    expect(WACLI_CONTRACT_VERSION).toBe(fixture.contractVersion);
    expect(WACLI_UPSTREAM_PIN).toMatchObject({
      repository: "openclaw/wacli",
      version: "0.18.2",
      tag: "v0.18.2",
      license: "MIT",
      releaseCommit: "cd4370388f03e2234c5f6af14778c9649f230c81",
      artifactSha256: "d33e8cc4b01acbd4e1ba212e22ac9c6438221e0761112dd3e7a2cc30b3a5946f",
      releaseCommitSignature: { verified: true, reason: "valid" },
      detachedLinuxArtifactSignature: false,
      whatsmeow: "v0.0.0-20260909164725-b25a56d63729",
    });
  });

  it("allows only fixed pairing, follow-sync, and read-only health invocations", () => {
    const invocations = [
      buildWacliInvocation("pair", fixture.accountKey),
      buildWacliInvocation("follow-sync", fixture.accountKey, "http://wacli-adapter.test/events"),
      buildWacliInvocation("health", fixture.accountKey),
    ];
    for (const invocation of invocations) {
      expect(isAllowedWacliInvocation(invocation)).toBe(true);
    }
    const follow = invocations[1];
    expect(follow.argv).toContain(WACLI_PROTECTED_SECRET_PLACEHOLDER);
    expect(follow.secretSource).toBe("protected-file");
    expect(follow.argv.join(" ")).not.toContain("fixture-secret");

    expect(
      isAllowedWacliInvocation({
        ...follow,
        argv: [...follow.argv, "--download-media"],
      }),
    ).toBe(false);
    expect(
      isAllowedWacliInvocation({
        ...follow,
        argv: follow.argv.map((arg) => (arg === "quiet" ? "normal" : arg)),
      }),
    ).toBe(false);
  });

  it("keeps every forbidden remote mutation outside the command surface", () => {
    for (const command of WACLI_FORBIDDEN_COMMANDS) {
      expect(isForbiddenWacliCommand(command)).toBe(true);
      expect(
        isAllowedWacliInvocation({
          operation: "health",
          argv: ["wacli", "--account", fixture.accountKey, ...command.split(" ")],
          secretSource: "none",
        }),
      ).toBe(false);
    }
    expect(isForbiddenWacliCommand("unknown-command --arbitrary-flag")).toBe(false);
  });

  it("parses lifecycle history, QR, reconnect, and connection health events", () => {
    for (const example of fixture.lifecycle) {
      const parsed = parseWacliLifecycleEvent(bytes(example.line), fixture.accountKey);
      expect(parsed.kind).toBe("lifecycle");
      expect(parsed.event).toBe(example.expectedEvent);
      expect(parsed.accountKey).toBe(fixture.accountKey);
    }
    const history = parseWacliLifecycleEvent(bytes(fixture.lifecycle[3].line), fixture.accountKey);
    expect(history.details).toEqual({ conversations: 2 });
    const qr = parseWacliLifecycleEvent(bytes(fixture.lifecycle[1].line), fixture.accountKey);
    expect(qr.details).toEqual({ code: "fixture-qr-payload" });
  });

  it("parses live, history-shaped, revoked, and media message events", () => {
    const live = parseWacliWebhookEvent(bytes(fixture.webhooks.live), fixture.accountKey);
    expect(live).toMatchObject({
      kind: "message",
      messageKey: "fixture-live-1",
      sourceDeleted: false,
    });

    const history = parseWacliWebhookEvent(
      bytes(fixture.webhooks.historyShaped),
      fixture.accountKey,
    );
    expect(history).toMatchObject({ kind: "message", messageKey: "fixture-history-1" });

    const revoked = parseWacliWebhookEvent(bytes(fixture.webhooks.revoke), fixture.accountKey);
    expect(revoked).toMatchObject({
      kind: "message",
      sourceDeleted: true,
      text: "synthetic retained content",
    });

    const media = parseWacliWebhookEvent(bytes(fixture.webhooks.media), fixture.accountKey);
    expect(media).toMatchObject({
      kind: "message",
      media: { type: "image", mimeType: "image/jpeg", filename: "fixture.jpg", fileLength: 42 },
    });
    expect(JSON.stringify(media)).not.toMatch(/DirectPath|MediaKey|FileSHA256|FileEncSHA256/);
  });

  it("parses account-routed receipt and chat-presence events", () => {
    const receipt = parseWacliWebhookEvent(bytes(fixture.webhooks.receipt), fixture.accountKey);
    expect(receipt).toMatchObject({
      kind: "receipt",
      accountKey: fixture.accountKey,
      type: "delivered",
    });
    const presence = parseWacliWebhookEvent(bytes(fixture.webhooks.presence), fixture.accountKey);
    expect(presence).toMatchObject({
      kind: "chat_presence",
      accountKey: fixture.accountKey,
      state: "composing",
    });
  });

  it("authenticates exact webhook bytes and rejects tampering or malformed signatures", () => {
    const payload = bytes(fixture.webhooks.live);
    const secret = "fixture-only-secret";
    const signature = `sha256=${Buffer.from(awaitableHmac(payload, secret)).toString("hex")}`;
    expect(verifyWacliWebhookSignature(payload, signature, secret)).toBe(true);
    expect(verifyWacliWebhookSignature(bytes(`${fixture.webhooks.live} `), signature, secret)).toBe(
      false,
    );
    expect(verifyWacliWebhookSignature(payload, signature.toUpperCase(), secret)).toBe(false);
    expect(verifyWacliWebhookSignature(payload, "sha256=not-a-signature", secret)).toBe(false);
  });

  it("fails closed on unknown schemas and bounds hostile fields", () => {
    expect(() => parseWacliWebhookEvent(bytes('{"EventType":"send"}'), fixture.accountKey)).toThrow(
      "unsupported wacli webhook event type",
    );
    expect(() =>
      parseWacliWebhookEvent(bytes('{"Chat":"x","ID":"x","FromMe":false}'), fixture.accountKey),
    ).toThrow("wacli field SenderJID");
    const oversized = JSON.stringify({
      ...JSON.parse(fixture.webhooks.live),
      Text: "x".repeat(64 * 1024 + 1),
    });
    expect(() => parseWacliWebhookEvent(bytes(oversized), fixture.accountKey)).toThrow(
      "exceeds limit",
    );
    expect(() =>
      parseWacliLifecycleEvent(bytes('{"event":"pair_code","ts":1}'), fixture.accountKey),
    ).toThrow("unsupported wacli lifecycle event");
  });

  it("does not couple neutral output to upstream field names", () => {
    const event = parseWacliWebhookEvent(bytes(fixture.webhooks.media), fixture.accountKey);
    expect(Object.keys(event).sort()).toEqual(
      [
        "accountKey",
        "chatKey",
        "edited",
        "fromMe",
        "kind",
        "media",
        "messageKey",
        "observedAt",
        "sourceDeleted",
        "sourceEventKey",
        "senderKey",
      ].sort(),
    );
    expect((event as { readonly chatKey: string }).chatKey).toBe("120363000000000001@g.us");
  });
});

function awaitableHmac(payload: Uint8Array, secret: string): Uint8Array {
  // This local vector is deliberately synthetic; production verification stays
  // inside the adapter and never receives a secret from a caller-controlled body.
  return createHmac("sha256", secret).update(payload).digest();
}
