import { describe, expect, it } from "vitest";
import {
  allWhatsAppSqliteFixtures,
  buildWhatsAppSqliteFixture,
  selectFixtureAdapter,
} from "./fixtures.js";

describe("synthetic WhatsApp SQLite fixtures", () => {
  it.each([
    ["android-current.v1", "valid"],
    ["android-current.v1", "damaged"],
    ["android-legacy.v1", "valid"],
    ["android-legacy.v1", "damaged"],
  ] as const)("selects the intended adapter for %s %s", (version, variant) => {
    const fixture = buildWhatsAppSqliteFixture(version, variant);
    expect(selectFixtureAdapter(fixture)).toMatchObject({
      kind: "supported",
      fingerprint: version,
    });
    expect(fixture.sql).toContain("CREATE TABLE");
    expect(fixture.sql).toContain("synthetic");
    expect(fixture.sql).not.toMatch(/whatsapp|matthijs|laura|personal/i);
  });

  it("regenerates identical SQL and structural rows", () => {
    for (const fixture of allWhatsAppSqliteFixtures()) {
      const again = buildWhatsAppSqliteFixture(fixture.version, fixture.variant);
      expect(again.sql).toBe(fixture.sql);
      expect(again.rows).toEqual(fixture.rows);
    }
  });

  it("contains relationships and hostile record variants in each family", () => {
    for (const fixture of allWhatsAppSqliteFixtures()) {
      const serialized = JSON.stringify(fixture.rows);
      expect(serialized).toMatch(/quoted|quoted_message_id|quoted_row_id/);
      expect(serialized).toMatch(/edit_version/);
      expect(serialized).toMatch(/99/);
      expect(serialized).toMatch(/group/);
      expect(serialized).toMatch(/synthetic-malformed|synthetic hello/);
    }
  });
});
