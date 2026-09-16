import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseWacliWebhookEvent } from "./contract.js";
import { normalizeWacliEvent } from "./normalize.js";
import { normalizeWhatsAppMessages } from "../whatsapp/messages.js";
import { buildWhatsAppSqliteFixture } from "../whatsapp/fixtures.js";

const parse = (value: Record<string, unknown>) =>
  parseWacliWebhookEvent(new TextEncoder().encode(JSON.stringify(value)), "fixture-account");
const fixture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/wacli/wacli-normalization.v1.json", import.meta.url),
    "utf8",
  ),
) as { contractVersion: string; events: Record<string, Record<string, unknown>> };

describe("wacli observation normalization", () => {
  it("keeps a versioned synthetic fixture bound to the neutral contract", () => {
    expect(fixture.contractVersion).toBe("wacli-observation-normalization.v1");
    expect(normalizeWacliEvent(parse(fixture.events.history))).toHaveLength(5);
  });

  it("maps a message and media into account-neutral observation records", () => {
    const records = normalizeWacliEvent(
      parse({
        Chat: "120@g.us",
        ID: "message-1",
        SenderJID: "1555@s.whatsapp.net",
        Timestamp: "2026-09-16T12:00:00Z",
        FromMe: false,
        Text: "synthetic text",
        ReplyToID: "message-0",
        Edited: true,
        Media: { Type: "image", MimeType: "image/jpeg", Filename: "synthetic.jpg", FileLength: 4 },
      }),
    );
    expect(records.map((record) => record.kind)).toEqual([
      "person",
      "identity",
      "conversation",
      "participant",
      "message",
      "revision",
      "attachment",
    ]);
    const message = records.find((record) => record.kind === "message");
    expect(message).toMatchObject({ messageKind: "image", body: "synthetic text" });
    expect(JSON.stringify(records)).not.toContain("SenderJID");
  });

  it("uses the backup identity vocabulary for the same WhatsApp message", () => {
    const live = normalizeWacliEvent(
      parse({
        Chat: "120@g.us",
        ID: "shared-message-id",
        SenderJID: "1555@s.whatsapp.net",
        Timestamp: "2026-09-16T12:00:00Z",
        FromMe: false,
        Text: "same evidence",
      }),
    );
    const history = normalizeWhatsAppMessages(
      {
        ...buildWhatsAppSqliteFixture("android-legacy.v1"),
        rows: {
          messages: [
            {
              _id: 1,
              key_remote_jid: "120@g.us",
              key_from_me: false,
              timestamp: Date.parse("2026-09-16T12:00:00Z"),
              media_wa_type: 0,
              data: "same evidence",
              key_id: "shared-message-id",
            },
          ],
        },
      },
      { accountScope: "fixture-account" },
    ).find((record) => record.kind === "message");
    const liveMessage = live.find((record) => record.kind === "message");
    expect(liveMessage?.stableKey).toBe(history?.stableKey);
    expect(liveMessage?.source.namespace).toBe("whatsapp-android");
  });

  it("preserves accepted non-message events as explicit unsupported observations", () => {
    const records = normalizeWacliEvent(
      parse({
        EventType: "receipt",
        Chat: "120@g.us",
        Sender: "1555@s.whatsapp.net",
        MessageIDs: ["message-1"],
        Timestamp: "2026-09-16T12:00:00Z",
        Type: "delivered",
        IsFromMe: false,
      }),
    );
    const record = records.find((candidate) => candidate.kind === "message");
    expect(record).toMatchObject({
      kind: "message",
      messageKind: "unsupported",
      bodyState: "unsupported",
    });
    expect(record && record.kind === "message" ? record.metadata : undefined).toEqual({
      unsupportedEventKind: "receipt",
    });
  });
});
