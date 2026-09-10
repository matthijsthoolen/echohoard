import { describe, expect, it } from "vitest";
import { buildWhatsAppSqliteFixture } from "./fixtures.js";
import { normalizeWhatsAppIdentitiesAndConversations } from "./normalize.js";

describe("WhatsApp identity and conversation normalization", () => {
  it.each(["android-current.v1", "android-legacy.v1"] as const)(
    "maps %s deterministically",
    (version) => {
      const fixture = buildWhatsAppSqliteFixture(version);
      const records = normalizeWhatsAppIdentitiesAndConversations(fixture);
      expect(records).toEqual(
        normalizeWhatsAppIdentitiesAndConversations(buildWhatsAppSqliteFixture(version)),
      );
      expect(records.filter((record) => record.kind === "conversation")).toHaveLength(2);
      expect(records.filter((record) => record.kind === "participant")).toHaveLength(2);
      expect(JSON.stringify(records)).not.toMatch(/row_id|key_remote_jid|is_group|chat_id/);
    },
  );

  it("does not merge similar names and preserves exact JID observations", () => {
    const fixture = buildWhatsAppSqliteFixture("android-current.v1");
    const rows = fixture.rows.jid as Readonly<Record<string, unknown>>[];
    rows.push({ _id: 3, raw_string: "synthetic-person-c@c.us", display_name: "Example Alpha" });
    const records = normalizeWhatsAppIdentitiesAndConversations({
      ...fixture,
      rows: { ...fixture.rows, jid: rows },
    });
    const identities = records.filter((record) => record.kind === "identity");
    expect(identities.filter((record) => record.displayName === "Example Alpha")).toHaveLength(2);
    expect(new Set(identities.map((record) => record.stableKey)).size).toBe(3);
  });

  it("retains malformed or missing identity observations without throwing", () => {
    const fixture = buildWhatsAppSqliteFixture("android-legacy.v1");
    const participants = fixture.rows.participants as Readonly<Record<string, unknown>>[];
    participants.push({ chat_id: 20, identity: null, role: "unexpected" });
    const records = normalizeWhatsAppIdentitiesAndConversations({
      ...fixture,
      rows: { ...fixture.rows, participants },
    });
    expect(
      records.some((record) => record.kind === "identity" && record.source.value === "unknown"),
    ).toBe(true);
    expect(
      records.some((record) => record.kind === "participant" && record.role === "unknown"),
    ).toBe(true);
  });
});
