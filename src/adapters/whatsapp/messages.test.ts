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
      expect(messages).toHaveLength(3);
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
