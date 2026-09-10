import { describe, expect, it } from "vitest";
import { buildWhatsAppSqliteFixture } from "./fixtures.js";
import { normalizeWhatsAppMessages } from "./messages.js";

describe("WhatsApp message normalization", () => {
  it.each(["android-current.v1", "android-legacy.v1"] as const)(
    "maps text, replies, unknown codes, and revisions for %s",
    (version) => {
      const records = normalizeWhatsAppMessages(buildWhatsAppSqliteFixture(version), {
        snapshotId: "snapshot-a",
      });
      const messages = records.filter((record) => record.kind === "message");
      const revisions = records.filter((record) => record.kind === "revision");
      expect(messages).toHaveLength(12);
      expect(messages.find((message) => message.body === "synthetic reply")?.replyToKey).toBe(
        messages.find((message) => message.body === "synthetic hello")?.stableKey,
      );
      expect(messages.find((message) => message.unsupportedTypeCode === 99)).toMatchObject({
        messageKind: "unsupported",
        bodyState: "missing",
        timestamp: "2023-11-14T22:13:22.000Z",
      });
      expect(revisions).toHaveLength(1);
      expect(revisions[0]).toMatchObject({
        messageKey: messages.find((message) => message.body === "synthetic reply")?.stableKey,
        revisionOrdinal: 1,
        body: "synthetic edited reply",
        firstSeenSnapshotId: "snapshot-a",
      });
    },
  );

  it("keeps malformed text traceable but inert and does not leak it", () => {
    const fixture = buildWhatsAppSqliteFixture("android-current.v1");
    const rows = fixture.rows.message as Readonly<Record<string, unknown>>[];
    rows[0] = { ...rows[0], text_data: "hostile\u0000payload" };
    const message = normalizeWhatsAppMessages({
      ...fixture,
      rows: { ...fixture.rows, message: rows },
    }).find(
      (record) => record.kind === "message" && record.timestamp === "2023-11-14T22:13:20.000Z",
    );
    expect(message).toMatchObject({ bodyState: "damaged" });
    expect(message).not.toHaveProperty("body");
    expect(JSON.stringify(message)).not.toContain("hostile");
  });

  it.each(["android-current.v1", "android-legacy.v1"] as const)(
    "maps rich message metadata and relationships for %s",
    (version) => {
      const messages = normalizeWhatsAppMessages(buildWhatsAppSqliteFixture(version)).filter(
        (record) => record.kind === "message",
      );
      expect(new Set(messages.map((message) => message.messageKind))).toEqual(
        new Set([
          "text",
          "image",
          "video",
          "audio",
          "document",
          "location",
          "contact",
          "sticker",
          "system",
          "reaction",
          "unsupported",
        ]),
      );
      expect(messages.find((message) => message.messageKind === "image")).toMatchObject({
        source: { value: `${version === "android-current.v1" ? "current" : "legacy"}-image` },
        metadata: {
          caption: "a photo",
          mimeType: "image/jpeg",
          filename: "photo.jpg",
          width: 640,
          height: 480,
        },
      });
      expect(messages.find((message) => message.messageKind === "location")).toMatchObject({
        metadata: { latitude: 52.09, longitude: 5.12 },
      });
      expect(messages.find((message) => message.messageKind === "contact")).toMatchObject({
        metadata: { contactName: "Example Beta", contactPhone: "+31000000000" },
      });
      expect(messages.find((message) => message.messageKind === "reaction")).toMatchObject({
        metadata: { reactionEmoji: "👍" },
      });
      const reaction = messages.find((message) => message.messageKind === "reaction");
      expect(reaction?.metadata?.reactsToKey).toBe(
        messages.find((message) => message.body === "synthetic hello")?.stableKey,
      );
      expect(messages.find((message) => message.messageKind === "system")).toMatchObject({
        metadata: { sourceEvent: "subject_changed" },
      });
    },
  );

  it("drops hostile rich metadata while retaining the message evidence", () => {
    const fixture = buildWhatsAppSqliteFixture("android-current.v1");
    const rows = fixture.rows.message as Readonly<Record<string, unknown>>[];
    rows[3] = {
      ...rows[3],
      media_name: "../../escape.html",
      media_mime_type: "text/html\u0000",
      latitude: 999,
    };
    const image = normalizeWhatsAppMessages({
      ...fixture,
      rows: { ...fixture.rows, message: rows },
    }).find((record) => record.kind === "message" && record.messageKind === "image");
    expect(image).toMatchObject({ messageKind: "image" });
    expect(image?.metadata).toMatchObject({ caption: "a photo", width: 640, height: 480 });
    expect(image?.metadata).not.toHaveProperty("filename");
    expect(image?.metadata).not.toHaveProperty("mimeType");
    expect(image?.metadata).not.toHaveProperty("latitude");
  });

  it("keeps missing reply targets and invalid timestamps safe", () => {
    const fixture = buildWhatsAppSqliteFixture("android-legacy.v1");
    const rows = fixture.rows.messages as Readonly<Record<string, unknown>>[];
    rows[1] = { ...rows[1], quoted_row_id: 999, timestamp: Number.NaN };
    const message = normalizeWhatsAppMessages({
      ...fixture,
      rows: { ...fixture.rows, messages: rows },
    }).find((record) => record.kind === "message" && record.body === "synthetic reply");
    expect(message).toMatchObject({ timestamp: null });
    expect(message).not.toHaveProperty("replyToKey");
  });
});
