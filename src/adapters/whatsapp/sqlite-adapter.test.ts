import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWhatsAppSqliteFixture } from "./fixtures.js";
import {
  PythonSqliteDatabaseReader,
  SqliteReaderError,
  WhatsAppSchemaError,
  WhatsAppSnapshotAdapter,
  type SqliteDatabaseReader,
} from "./sqlite-adapter.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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
    const records = await collect(result.records);
    expect(records.some((record) => (record as { kind?: string }).kind === "message")).toBe(true);
    expect(JSON.stringify(records)).not.toMatch(/chat_row_id|text_data|message_type/);
  });

  it("fails visibly and closed for an unknown schema", async () => {
    let streamed = false;
    const reader: SqliteDatabaseReader = {
      inspect: async () => ({ mystery: ["id"] }),
      streamRows: () => {
        streamed = true;
        return emptyRows();
      },
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
    expect(streamed).toBe(false);
  });

  it("streams selected rows in chunks without constructing a database dump", async () => {
    const command = await shellFixture(`
if printf '%s' "$2" | grep -q sqlite_master; then
  printf '%s\\n' '{"message":["_id","text_data"]}'
else
  printf '%s\\n' '{"_id":1,"text_data":"first"}'
  printf '%s\\n' '{"_id":2,"text_data":"second"}'
fi
`);
    const reader = new PythonSqliteDatabaseReader(command, { chunkSize: 1, maxRows: 10 });
    await expect(reader.inspect("/disposable/msgstore.db")).resolves.toEqual({
      message: ["_id", "text_data"],
    });
    const rows: unknown[] = [];
    for await (const row of reader.streamRows("/disposable/msgstore.db", "message", [
      "_id",
      "text_data",
    ]))
      rows.push(row);
    expect(rows).toEqual([
      { _id: 1, text_data: "first" },
      { _id: 2, text_data: "second" },
    ]);
  });

  it("emits normalized observations in bounded batches", async () => {
    const fixture = buildWhatsAppSqliteFixture("android-current.v1");
    const reader: SqliteDatabaseReader = {
      inspect: async () => fixture.schema,
      streamRows: async function* (_path, table) {
        for (const row of fixture.rows[table] ?? []) yield row;
      },
    };
    const result = await new WhatsAppSnapshotAdapter(reader, 2).adapt({
      decryptedPath: "/disposable/msgstore.db",
      snapshotId: "snapshot-1",
      accountScope: "account-1",
    });
    const batches: readonly unknown[][] = [];
    for await (const batch of result.records) (batches as unknown[][]).push([...batch]);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every((batch) => batch.length <= 2)).toBe(true);
    expect(batches.flat().some((record) => (record as { kind?: string }).kind === "message")).toBe(
      true,
    );
  });

  it("terminates an extraction child at its timeout", async () => {
    const command = await shellFixture("sleep 2");
    const reader = new PythonSqliteDatabaseReader(command, { timeoutMs: 20 });
    await expect(reader.inspect("/disposable/msgstore.db")).rejects.toMatchObject({
      kind: "timeout",
    } satisfies Partial<SqliteReaderError>);
  });

  it("classifies an oversized row as a terminal resource limit", async () => {
    const command = await shellFixture(
      `printf '%s\\n' '{"_id":1,"text_data":"this row is too large"}'`,
    );
    const reader = new PythonSqliteDatabaseReader(command, { maxRowBytes: 16 });
    await expect(
      collect(reader.streamRows("/disposable/msgstore.db", "message", ["_id", "text_data"])),
    ).rejects.toMatchObject({ kind: "resource-limit" });
  });

  it("preserves hostile source text as inert normalized data", async () => {
    const fixture = buildWhatsAppSqliteFixture("android-current.v1");
    const reader: SqliteDatabaseReader = {
      inspect: async () => fixture.schema,
      streamRows: async function* (_path, table) {
        if (table === "jid")
          yield { _id: 1, raw_string: "synthetic-person-a@c.us", display_name: "Example Alpha" };
        if (table === "chat") yield { _id: 10, jid_row_id: 1, subject: null, is_group: 0 };
        if (table === "message")
          yield {
            _id: 100,
            chat_row_id: 10,
            from_me: 0,
            timestamp: 1700000000000,
            message_type: 1,
            text_data: "<script>window.pwned=1</script>\u0000synthetic",
            key_id: "hostile-message",
          };
      },
    };
    const result = await new WhatsAppSnapshotAdapter(reader).adapt({
      decryptedPath: "/disposable/msgstore.db",
      snapshotId: "snapshot-1",
      accountScope: "account-1",
    });
    const records = await collect(result.records);
    const message = records.find((record) => record.kind === "message");
    expect(message).toMatchObject({ bodyState: "damaged" });
    expect(JSON.stringify(message)).not.toContain("<script>window.pwned=1</script>");
  });
});

async function collect(
  source: readonly unknown[] | AsyncIterable<readonly unknown[]>,
): Promise<unknown[]> {
  if (Array.isArray(source)) return [...source];
  const values: unknown[] = [];
  for await (const batch of source) values.push(...batch);
  return values;
}

async function* emptyRows(): AsyncGenerator<never> {}

async function shellFixture(body: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "echohoard-sqlite-reader-"));
  roots.push(root);
  const command = join(root, "reader.sh");
  await writeFile(command, `#!/bin/sh\n${body}`);
  await chmod(command, 0o755);
  return command;
}
