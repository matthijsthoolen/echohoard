import { spawn } from "node:child_process";
import { once } from "node:events";
import type { SnapshotAdapterPort } from "../../application/intake.js";
import type { ImportRecord } from "../../application/text-import.js";
import {
  WHATSAPP_ADAPTER_CONTRACT_VERSION,
  selectWhatsAppAndroidAdapter,
  type SqliteSchemaShape,
  type WhatsAppAdapterVersion,
  type NormalizedRecord,
} from "./contract.js";
import { normalizeWhatsAppIdentitiesAndConversations } from "./normalize.js";
import { normalizeWhatsAppMessages } from "./messages.js";

type SqlValue = boolean | number | string | null;
type SqlRows = Readonly<Record<string, readonly Readonly<Record<string, SqlValue>>[]>>;

export interface SqliteDatabaseDump {
  readonly schema: SqliteSchemaShape;
  readonly rows: SqlRows;
}

export interface SqliteDatabaseReader {
  read(path: string): Promise<SqliteDatabaseDump>;
}

export class WhatsAppSchemaError extends Error {
  public readonly kind = "unsupported-format" as const;

  public constructor(
    public readonly diagnostic: "unsupported-whatsapp-schema" | "ambiguous-whatsapp-schema",
  ) {
    super(diagnostic);
    this.name = "WhatsAppSchemaError";
  }
}

/** Reads only a disposable decrypted database. Python's standard SQLite module
 * is used because the production image already carries Python for
 * wa-crypt-tools and the Node application has no SQLite write dependency. */
export class PythonSqliteDatabaseReader implements SqliteDatabaseReader {
  public constructor(
    private readonly executable = "python3",
    private readonly maxOutputBytes = 512 * 1024 * 1024,
  ) {}

  public async read(path: string): Promise<SqliteDatabaseDump> {
    const output = await runReader(this.executable, path, this.maxOutputBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      throw Object.assign(new Error("SQLite inspection returned invalid data"), {
        kind: "corrupt-source",
      });
    }
    if (!isDatabaseDump(parsed))
      throw Object.assign(new Error("SQLite inspection returned invalid data"), {
        kind: "corrupt-source",
      });
    return parsed;
  }
}

export class WhatsAppSnapshotAdapter implements SnapshotAdapterPort {
  public constructor(
    private readonly reader: SqliteDatabaseReader = new PythonSqliteDatabaseReader(),
  ) {}

  public async adapt(input: {
    readonly decryptedPath: string;
    readonly snapshotId: string;
    readonly accountScope: string;
  }): Promise<{ readonly adapterVersion: string; readonly records: readonly ImportRecord[] }> {
    const database = await this.reader.read(input.decryptedPath);
    const selection = selectWhatsAppAndroidAdapter(database.schema);
    if (selection.kind === "unsupported") throw new WhatsAppSchemaError(selection.diagnostic);
    const fixture = {
      version: selection.fingerprint,
      rows: database.rows,
    } satisfies Pick<{ version: WhatsAppAdapterVersion; rows: SqlRows }, "version" | "rows">;
    const records = [
      ...normalizeWhatsAppIdentitiesAndConversations(fixture, { accountScope: input.accountScope }),
      ...normalizeWhatsAppMessages(fixture, {
        snapshotId: input.snapshotId,
        accountScope: input.accountScope,
      }),
    ];
    if (records.length === 0)
      throw Object.assign(new Error("WhatsApp database contained no supported observations"), {
        kind: "corrupt-source",
      });
    return {
      adapterVersion: `${WHATSAPP_ADAPTER_CONTRACT_VERSION}:${selection.fingerprint}`,
      records: records.map(toImportRecord),
    };
  }
}

function toImportRecord(record: NormalizedRecord): ImportRecord {
  switch (record.kind) {
    case "message":
      if (record.metadata) return { ...record, metadata: { ...record.metadata } };
      {
        const { metadata: _metadata, ...withoutMetadata } = record;
        return withoutMetadata;
      }
    case "person":
    case "identity":
    case "conversation":
    case "participant":
    case "revision":
      return record;
  }
}

const PYTHON_READER = String.raw`
import json
import sqlite3
import sys

path = sys.argv[1]
connection = sqlite3.connect("file:" + path + "?mode=ro", uri=True)
try:
    tables = connection.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()
    schema = {}
    rows = {}
    for (table,) in tables:
        quoted = '"' + table.replace('"', '""') + '"'
        columns = [row[1] for row in connection.execute("PRAGMA table_info(" + quoted + ")")]
        schema[table] = columns
        rows[table] = [dict(zip(columns, row)) for row in connection.execute("SELECT * FROM " + quoted)]
    print(json.dumps({"schema": schema, "rows": rows}, ensure_ascii=False, separators=(",", ":"), default=lambda value: value.decode("utf-8", "replace") if isinstance(value, bytes) else None))
finally:
    connection.close()
`;

async function runReader(
  executable: string,
  path: string,
  maxOutputBytes: number,
): Promise<string> {
  const child = spawn(executable, ["-c", PYTHON_READER, path], {
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  let output = "";
  let exceeded = false;
  child.stdout.on("data", (chunk: string) => {
    if (output.length + chunk.length > maxOutputBytes) {
      exceeded = true;
      child.kill("SIGKILL");
      return;
    }
    output += chunk;
  });
  const [code] = (await once(child, "close")) as [number | null];
  if (exceeded)
    throw Object.assign(new Error("SQLite inspection exceeded its limit"), { kind: "io" });
  if (code !== 0)
    throw Object.assign(new Error("SQLite database could not be read-only inspected"), {
      kind: "corrupt-source",
    });
  return output;
}

function isDatabaseDump(value: unknown): value is SqliteDatabaseDump {
  if (!isRecord(value) || !isRecord(value.schema) || !isRecord(value.rows)) return false;
  for (const [table, columns] of Object.entries(value.schema)) {
    if (!Array.isArray(columns) || !columns.every((column) => typeof column === "string"))
      return false;
    const tableRows = value.rows[table];
    if (!Array.isArray(tableRows) || !tableRows.every(isSqlRow)) return false;
  }
  return true;
}

function isSqlRow(value: unknown): value is Readonly<Record<string, SqlValue>> {
  return isRecord(value) && Object.values(value).every(isSqlValue);
}

function isSqlValue(value: unknown): value is SqlValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
