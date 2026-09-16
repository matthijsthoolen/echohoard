import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseWacliWebhookEvent } from "./contract.js";
import { normalizeWacliEvent } from "./normalize.js";

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

  it("preserves accepted non-message events as explicit unsupported observations", () => {
    const record = normalizeWacliEvent(
      parse({
        EventType: "receipt",
        Chat: "120@g.us",
        Sender: "1555@s.whatsapp.net",
        MessageIDs: ["message-1"],
        Timestamp: "2026-09-16T12:00:00Z",
        Type: "delivered",
        IsFromMe: false,
      }),
    )[0];
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
