import { describe, expect, it } from "vitest";
import { buildWhatsAppSqliteFixture } from "./fixtures.js";
import {
  WhatsAppSchemaError,
  WhatsAppSnapshotAdapter,
  type SqliteDatabaseReader,
} from "./sqlite-adapter.js";

describe("production WhatsApp SQLite adapter", () => {
  it("fingerprints, adapts, and emits source-neutral records", async () => {
    const fixture = buildWhatsAppSqliteFixture("android-current.v1");
    const reader: SqliteDatabaseReader = {
      read: async () => ({ schema: fixture.schema, rows: fixture.rows }),
    };
    const result = await new WhatsAppSnapshotAdapter(reader).adapt({
      decryptedPath: "/work/msgstore.db",
      snapshotId: "snapshot-1",
      accountScope: "account-1",
    });

    expect(result.adapterVersion).toBe("whatsapp-android-contract.v1:android-current.v1");
    expect(result.records.some((record) => record.kind === "message")).toBe(true);
    expect(JSON.stringify(result.records)).not.toMatch(/chat_row_id|text_data|message_type/);
  });

  it("fails visibly and closed for an unknown schema", async () => {
    const reader: SqliteDatabaseReader = {
      read: async () => ({ schema: { mystery: ["id"] }, rows: { mystery: [{ id: 1 }] } }),
    };
    await expect(
      new WhatsAppSnapshotAdapter(reader).adapt({
        decryptedPath: "/work/msgstore.db",
        snapshotId: "snapshot-1",
        accountScope: "account-1",
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        kind: "unsupported-format",
        diagnostic: "unsupported-whatsapp-schema",
      } satisfies Partial<WhatsAppSchemaError>),
    );
  });
});
