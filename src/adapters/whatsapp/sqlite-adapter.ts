import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { SnapshotAdapterPort } from "../../application/intake.js";
import type { ImportRecord, ImportRecordSource } from "../../application/text-import.js";
import {
  WHATSAPP_ADAPTER_CONTRACT_VERSION,
  selectWhatsAppAndroidAdapter,
  type SqliteSchemaShape,
  type WhatsAppAdapterVersion,
  type NormalizedRecord,
} from "./contract.js";
import { normalizeWhatsAppIdentitiesAndConversations } from "./normalize.js";
import {
  DEFAULT_MESSAGE_ROW_SPOOL_BYTES,
  normalizeWhatsAppMessages,
  streamNormalizedWhatsAppMessages,
} from "./messages.js";

type SqlValue = boolean | number | string | null;
type SqlRow = Readonly<Record<string, SqlValue>>;
type SqlRows = Readonly<Record<string, readonly SqlRow[]>>;

export interface SqliteDatabaseDump {
  readonly schema: SqliteSchemaShape;
  readonly rows: SqlRows;
}

/** The legacy read method is retained for fixture/test doubles. Production
 * readers must use inspect plus streamRows so raw source rows never form one
 * in-memory dump. */
export interface SqliteDatabaseReader {
  inspect?(path: string): Promise<SqliteSchemaShape>;
  streamRows?(path: string, table: string, columns: readonly string[]): AsyncIterable<SqlRow>;
  read?(path: string): Promise<SqliteDatabaseDump>;
}

export type SqliteReaderFailureKind = "timeout" | "resource-limit" | "io" | "corrupt-source";

export class SqliteReaderError extends Error {
  public constructor(
    public readonly kind: SqliteReaderFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "SqliteReaderError";
  }
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

export interface SqliteReaderOptions {
  readonly timeoutMs?: number;
  /** Optional whole-stream cap. Row and row-count caps remain active by default. */
  readonly maxOutputBytes?: number;
  readonly maxRowBytes?: number;
  readonly maxRows?: number;
  readonly schemaMaxBytes?: number;
  readonly terminationGraceMs?: number;
  readonly chunkSize?: number;
}

export interface WhatsAppSnapshotAdapterOptions {
  readonly batchSize?: number;
  readonly maxSpoolBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_ROW_BYTES = 1 * 1024 * 1024;
const DEFAULT_MAX_ROWS = 10_000_000;
const DEFAULT_SCHEMA_MAX_BYTES = 1 * 1024 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 250;
const DEFAULT_CHUNK_SIZE = 500;

/**
 * Streams selected, known WhatsApp columns from a disposable SQLite file.
 * Schema inspection is a separate bounded process. A row process is started
 * only after the adapter has selected a known fingerprint, and it fetches in
 * bounded batches with backpressure from Node's async iterator.
 */
export class PythonSqliteDatabaseReader implements SqliteDatabaseReader {
  private readonly options: Required<SqliteReaderOptions>;

  public constructor(
    private readonly executable = "python3",
    options: SqliteReaderOptions | number = {},
  ) {
    const legacyOutput = typeof options === "number" ? options : undefined;
    const configured = typeof options === "number" ? {} : options;
    this.options = {
      timeoutMs: configured.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: configured.maxOutputBytes ?? legacyOutput ?? 0,
      maxRowBytes: configured.maxRowBytes ?? DEFAULT_MAX_ROW_BYTES,
      maxRows: configured.maxRows ?? DEFAULT_MAX_ROWS,
      schemaMaxBytes: configured.schemaMaxBytes ?? DEFAULT_SCHEMA_MAX_BYTES,
      terminationGraceMs: configured.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
      chunkSize: configured.chunkSize ?? DEFAULT_CHUNK_SIZE,
    };
  }

  public async inspect(path: string): Promise<SqliteSchemaShape> {
    const output = await collectProcessOutput(
      this.executable,
      ["-c", PYTHON_SCHEMA_READER, path],
      this.options,
      this.options.schemaMaxBytes,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      throw new SqliteReaderError("corrupt-source", "SQLite inspection returned invalid data");
    }
    if (!isSchema(parsed))
      throw new SqliteReaderError("corrupt-source", "SQLite inspection returned invalid data");
    return parsed;
  }

  public streamRows(
    path: string,
    table: string,
    columns: readonly string[],
  ): AsyncIterable<SqlRow> {
    if (columns.length === 0)
      throw new SqliteReaderError("io", "SQLite extraction requested no known columns");
    return streamProcessRows(
      this.executable,
      [
        "-c",
        PYTHON_ROW_READER,
        path,
        table,
        JSON.stringify(columns),
        String(this.options.chunkSize),
      ],
      columns,
      this.options,
    );
  }
}

export class WhatsAppSnapshotAdapter implements SnapshotAdapterPort {
  private readonly batchSize: number;
  private readonly maxSpoolBytes: number;

  public constructor(
    private readonly reader: SqliteDatabaseReader = new PythonSqliteDatabaseReader(),
    batchSizeOrOptions: number | WhatsAppSnapshotAdapterOptions = DEFAULT_CHUNK_SIZE,
  ) {
    const options =
      typeof batchSizeOrOptions === "number"
        ? { batchSize: batchSizeOrOptions }
        : batchSizeOrOptions;
    this.batchSize = options.batchSize ?? DEFAULT_CHUNK_SIZE;
    this.maxSpoolBytes = options.maxSpoolBytes ?? DEFAULT_MESSAGE_ROW_SPOOL_BYTES;
  }

  public async adapt(input: {
    readonly decryptedPath: string;
    readonly workPath?: string;
    readonly snapshotId: string;
    readonly accountScope: string;
  }): Promise<{ readonly adapterVersion: string; readonly records: ImportRecordSource }> {
    if (this.reader.inspect && this.reader.streamRows) {
      const schema = await this.reader.inspect(input.decryptedPath);
      const selection = selectWhatsAppAndroidAdapter(schema);
      if (selection.kind === "unsupported") throw new WhatsAppSchemaError(selection.diagnostic);
      const columns = columnsFor(schema, selection.fingerprint);
      const metadata = await readMetadata(this.reader, input.decryptedPath, columns);
      const source = {
        streamRows: (table: string, selected: readonly string[]) =>
          this.reader.streamRows!(input.decryptedPath, table, selected),
      };
      const metadataRecords = normalizeWhatsAppIdentitiesAndConversations(
        { version: selection.fingerprint, rows: metadata },
        { accountScope: input.accountScope },
      );
      const orderedMetadataRecords = [...metadataRecords].sort(
        (left, right) => importRecordOrder(left) - importRecordOrder(right),
      );
      if (!input.workPath)
        throw new Error("streaming WhatsApp adaptation requires lease-owned work storage");
      const recordsPath = join(input.workPath, "whatsapp-records.jsonl");
      const rowSpoolPath = join(input.workPath, "whatsapp-message-rows.jsonl");
      await materializeRecords(
        recordsPath,
        orderedMetadataRecords,
        streamNormalizedWhatsAppMessages(
          source,
          selection.fingerprint,
          { rows: metadata },
          columns,
          {
            snapshotId: input.snapshotId,
            accountScope: input.accountScope,
            batchSize: this.batchSize,
            rowSpoolPath,
            maxSpoolBytes: this.maxSpoolBytes,
          },
        ),
        this.maxSpoolBytes,
      );
      return {
        adapterVersion: `${WHATSAPP_ADAPTER_CONTRACT_VERSION}:${selection.fingerprint}`,
        records: fileRecordSource(recordsPath, this.batchSize),
      };
    }

    if (!this.reader.read)
      throw new Error("SQLite reader does not provide inspection or streaming");
    const database = await this.reader.read(input.decryptedPath);
    const selection = selectWhatsAppAndroidAdapter(database.schema);
    if (selection.kind === "unsupported") throw new WhatsAppSchemaError(selection.diagnostic);
    const fixture = { version: selection.fingerprint, rows: database.rows } satisfies Pick<
      { version: WhatsAppAdapterVersion; rows: SqlRows },
      "version" | "rows"
    >;
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

async function materializeRecords(
  path: string,
  metadata: readonly NormalizedRecord[],
  messages: AsyncIterable<readonly NormalizedRecord[]>,
  maxBytes: number,
): Promise<void> {
  const file = await open(path, "wx");
  let count = 0;
  let bytes = 0;
  let pending = "";
  const append = async (record: NormalizedRecord): Promise<void> => {
    const line = `${JSON.stringify(toImportRecord(record))}\n`;
    const nextBytes = bytes + Buffer.byteLength(line, "utf8");
    if (nextBytes > maxBytes)
      throw Object.assign(new Error("normalized WhatsApp record spool exceeded its limit"), {
        kind: "resource-limit",
      });
    bytes = nextBytes;
    pending += line;
    if (Buffer.byteLength(pending, "utf8") >= 64 * 1024) {
      await file.write(Buffer.from(pending, "utf8"));
      pending = "";
    }
  };
  try {
    for (const record of metadata) {
      await append(record);
      count += 1;
    }
    for await (const batch of messages)
      for (const record of batch) {
        await append(record);
        count += 1;
      }
    if (pending) await file.write(Buffer.from(pending, "utf8"));
  } finally {
    await file.close();
  }
  if (count === 0) {
    await rm(path, { force: true });
    throw Object.assign(new Error("WhatsApp database contained no supported observations"), {
      kind: "corrupt-source",
    });
  }
}

function fileRecordSource(path: string, batchSize: number): AsyncIterable<readonly ImportRecord[]> {
  const size = Math.max(1, Math.min(1_000, Math.trunc(batchSize)));
  return {
    [Symbol.asyncIterator]: async function* () {
      const input = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
      let batch: ImportRecord[] = [];
      try {
        for await (const line of input) {
          batch.push(parseImportRecord(line));
          if (batch.length >= size) {
            yield batch;
            batch = [];
          }
        }
        if (batch.length > 0) yield batch;
      } finally {
        input.close();
      }
    },
  };
}

function parseImportRecord(line: string): ImportRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("normalized WhatsApp record spool is corrupt");
  }
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    (value.kind !== "participant" && typeof value.stableKey !== "string")
  )
    throw new Error("normalized WhatsApp record spool is corrupt");
  return value as unknown as ImportRecord;
}

function importRecordOrder(record: NormalizedRecord): number {
  switch (record.kind) {
    case "person":
      return 0;
    case "identity":
      return 1;
    case "conversation":
      return 2;
    case "participant":
      return 3;
    case "message":
      return 4;
    case "revision":
      return 5;
  }
}

async function readMetadata(
  reader: SqliteDatabaseReader,
  path: string,
  columns: ReadonlyMap<string, readonly string[]>,
): Promise<SqlRows> {
  const rows: Record<string, readonly SqlRow[]> = {};
  for (const [table, selected] of columns) {
    if (
      table === "message" ||
      table === "messages" ||
      table === "message_edit" ||
      table === "message_edits"
    )
      continue;
    const tableRows: SqlRow[] = [];
    for await (const row of reader.streamRows!(path, table, selected)) tableRows.push(row);
    rows[table] = tableRows;
  }
  return rows;
}

async function* streamRecords(
  metadata: readonly NormalizedRecord[],
  messages: AsyncIterable<readonly NormalizedRecord[]>,
  batchSize: number,
): AsyncGenerator<readonly ImportRecord[]> {
  const size = Math.max(1, Math.min(1_000, Math.trunc(batchSize)));
  for (let offset = 0; offset < metadata.length; offset += size)
    yield metadata.slice(offset, offset + size).map(toImportRecord);
  for await (const batch of messages) yield batch.map(toImportRecord);
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

const CURRENT_COLUMNS = [
  ["chat", ["_id", "jid_row_id", "subject", "is_group"]],
  ["chat_participant", ["chat_row_id", "jid_row_id", "role"]],
  ["jid", ["_id", "raw_string", "display_name"]],
  [
    "message",
    [
      "_id",
      "chat_row_id",
      "from_me",
      "timestamp",
      "message_type",
      "text_data",
      "key_id",
      "media_caption",
      "media_mime_type",
      "media_name",
      "media_width",
      "media_height",
      "media_duration_ms",
      "latitude",
      "longitude",
      "contact_name",
      "contact_phone",
      "sticker_animated",
      "reaction_text",
      "reaction_target_id",
      "event_type",
      "sender_jid_row_id",
      "quoted_message_id",
      "edit_version",
    ],
  ],
  ["message_edit", ["message_id", "edit_version", "text_data", "timestamp"]],
] as const;
const LEGACY_COLUMNS = [
  ["chats", ["_id", "key_remote_jid", "subject", "is_group"]],
  [
    "messages",
    [
      "_id",
      "key_remote_jid",
      "key_from_me",
      "timestamp",
      "media_wa_type",
      "data",
      "media_caption",
      "media_mime_type",
      "media_name",
      "media_width",
      "media_height",
      "media_duration_ms",
      "latitude",
      "longitude",
      "contact_name",
      "contact_phone",
      "sticker_animated",
      "reaction_text",
      "reaction_target_id",
      "event_type",
      "key_id",
      "participant_hash",
      "quoted_row_id",
      "edit_version",
    ],
  ],
  ["message_edits", ["message_id", "edit_version", "data", "timestamp"]],
  ["participants", ["chat_id", "identity", "role"]],
] as const;

function columnsFor(
  schema: SqliteSchemaShape,
  version: WhatsAppAdapterVersion,
): ReadonlyMap<string, readonly string[]> {
  const known = version === "android-current.v1" ? CURRENT_COLUMNS : LEGACY_COLUMNS;
  return new Map(
    known
      .filter(([table]) => schema[table] !== undefined)
      .map(([table, columns]): [string, readonly string[]] => [
        table,
        columns.filter((column) => schema[table]!.includes(column)),
      ])
      .filter(([, columns]) => columns.length > 0),
  );
}

const PYTHON_SCHEMA_READER = String.raw`
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
    for (table,) in tables:
        quoted = '"' + table.replace('"', '""') + '"'
        schema[table] = [row[1] for row in connection.execute("PRAGMA table_info(" + quoted + ")")]
    print(json.dumps(schema, ensure_ascii=False, separators=(",", ":")))
finally:
    connection.close()
`;

const PYTHON_ROW_READER = String.raw`
import json
import sqlite3
import sys

path, table, columns_json, chunk_size = sys.argv[1:]
columns = json.loads(columns_json)
quote = lambda value: '"' + value.replace('"', '""') + '"'
connection = sqlite3.connect("file:" + path + "?mode=ro", uri=True)
try:
    query = "SELECT " + ",".join(quote(column) for column in columns) + " FROM " + quote(table)
    cursor = connection.execute(query)
    while True:
        rows = cursor.fetchmany(int(chunk_size))
        if not rows:
            break
        for row in rows:
            print(json.dumps(dict(zip(columns, row)), ensure_ascii=False, separators=(",", ":"), default=lambda value: value.decode("utf-8", "replace") if isinstance(value, bytes) else None))
finally:
    connection.close()
`;

async function collectProcessOutput(
  executable: string,
  args: readonly string[],
  options: Required<SqliteReaderOptions>,
  maxBytes: number,
): Promise<string> {
  const child = spawn(executable, args, {
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  const close = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
  let output = "";
  let bytes = 0;
  let timedOut = false;
  let termination: Promise<void> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    termination ??= terminate(child, close, options.terminationGraceMs);
  }, options.timeoutMs);
  try {
    child.stdout!.setEncoding("utf8");
    for await (const chunk of child.stdout as AsyncIterable<string>) {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > maxBytes)
        throw new SqliteReaderError("resource-limit", "SQLite inspection exceeded its limit");
      output += chunk;
    }
    const [code] = await close;
    if (timedOut) throw new SqliteReaderError("timeout", "SQLite inspection timed out");
    if (code !== 0)
      throw new SqliteReaderError("corrupt-source", "SQLite database could not be inspected");
    return output;
  } catch (error) {
    if (error instanceof SqliteReaderError) throw error;
    throw new SqliteReaderError("io", "SQLite inspection process failed");
  } finally {
    clearTimeout(timer);
    await (termination ??= terminate(child, close, options.terminationGraceMs));
  }
}

async function* streamProcessRows(
  executable: string,
  args: readonly string[],
  columns: readonly string[],
  options: Required<SqliteReaderOptions>,
): AsyncGenerator<SqlRow> {
  const child = spawn(executable, args, {
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  const close = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
  let buffer = "";
  let outputBytes = 0;
  let rows = 0;
  let timedOut = false;
  let reason: SqliteReaderError | undefined;
  let termination: Promise<void> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    termination ??= terminate(child, close, options.terminationGraceMs);
  }, options.timeoutMs);
  const parse = (line: string): SqlRow => {
    if (Buffer.byteLength(line, "utf8") > options.maxRowBytes)
      throw new SqliteReaderError("resource-limit", "SQLite row exceeds its configured limit");
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new SqliteReaderError("corrupt-source", "SQLite extraction returned invalid row data");
    }
    if (!isSqlRow(value, columns))
      throw new SqliteReaderError("corrupt-source", "SQLite extraction returned invalid row data");
    return value;
  };
  try {
    child.stdout!.setEncoding("utf8");
    for await (const chunk of child.stdout as AsyncIterable<string>) {
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (options.maxOutputBytes > 0 && outputBytes > options.maxOutputBytes) {
        reason = new SqliteReaderError(
          "resource-limit",
          "SQLite extraction exceeded its configured limit",
        );
        throw reason;
      }
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          rows += 1;
          if (rows > options.maxRows) {
            reason = new SqliteReaderError(
              "resource-limit",
              "SQLite table exceeds its configured row limit",
            );
            throw reason;
          }
          yield parse(line);
        }
        newline = buffer.indexOf("\n");
      }
      if (Buffer.byteLength(buffer, "utf8") > options.maxRowBytes)
        throw new SqliteReaderError("resource-limit", "SQLite row exceeds its configured limit");
    }
    if (buffer.length > 0) {
      rows += 1;
      if (rows > options.maxRows)
        throw new SqliteReaderError(
          "resource-limit",
          "SQLite table exceeds its configured row limit",
        );
      yield parse(buffer);
    }
    const [code] = await close;
    if (timedOut) throw new SqliteReaderError("timeout", "SQLite extraction timed out");
    if (code !== 0) throw new SqliteReaderError("corrupt-source", "SQLite table could not be read");
  } catch (error) {
    if (error instanceof SqliteReaderError) throw error;
    throw reason ?? new SqliteReaderError("io", "SQLite extraction process failed");
  } finally {
    clearTimeout(timer);
    await (termination ??= terminate(child, close, options.terminationGraceMs));
  }
}

async function terminate(
  child: ChildProcess,
  close: Promise<[number | null, NodeJS.Signals | null]>,
  graceMs: number,
): Promise<void> {
  if (child.exitCode !== null) return;
  signalProcessGroup(child, "SIGTERM");
  const completed = await Promise.race([close.then(() => true), delay(graceMs).then(() => false)]);
  if (!completed && child.exitCode === null) signalProcessGroup(child, "SIGKILL");
  await close;
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have exited between the check and the group signal.
    }
  }
  child.kill(signal);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isSchema(value: unknown): value is SqliteSchemaShape {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([table, columns]) =>
        table.length > 0 &&
        Array.isArray(columns) &&
        columns.every((column) => typeof column === "string"),
    )
  );
}

function isSqlRow(value: unknown, columns: readonly string[]): value is SqlRow {
  return (
    isRecord(value) &&
    columns.every((column) => Object.prototype.hasOwnProperty.call(value, column)) &&
    Object.keys(value).every((key) => columns.includes(key)) &&
    Object.values(value).every(isSqlValue)
  );
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
