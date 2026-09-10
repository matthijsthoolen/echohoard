import {
  selectWhatsAppAndroidAdapter,
  type SqliteSchemaShape,
  type WhatsAppAdapterVersion,
} from "./contract.js";

export type FixtureVariant = "valid" | "damaged";
type SqlValue = boolean | number | string | null;

export interface WhatsAppSqliteFixture {
  readonly name: `${WhatsAppAdapterVersion}:${FixtureVariant}`;
  readonly version: WhatsAppAdapterVersion;
  readonly variant: FixtureVariant;
  readonly schema: SqliteSchemaShape;
  readonly rows: Readonly<Record<string, readonly Readonly<Record<string, SqlValue>>[]>>;
  readonly sql: string;
}

const CURRENT_SCHEMA: SqliteSchemaShape = {
  chat: ["_id", "jid_row_id", "subject", "is_group"],
  chat_participant: ["chat_row_id", "jid_row_id", "role"],
  jid: ["_id", "raw_string", "display_name"],
  message: [
    "_id",
    "chat_row_id",
    "from_me",
    "timestamp",
    "message_type",
    "text_data",
    "sender_jid_row_id",
    "quoted_message_id",
    "edit_version",
  ],
  message_edit: ["message_id", "edit_version", "text_data", "timestamp"],
};

const LEGACY_SCHEMA: SqliteSchemaShape = {
  chats: ["_id", "key_remote_jid", "subject", "is_group"],
  messages: [
    "_id",
    "key_remote_jid",
    "key_from_me",
    "timestamp",
    "media_wa_type",
    "data",
    "key_id",
    "participant_hash",
    "quoted_row_id",
    "edit_version",
  ],
  message_edits: ["message_id", "edit_version", "data", "timestamp"],
  participants: ["chat_id", "identity", "role"],
};

const CURRENT_ROWS = {
  jid: [
    { _id: 1, raw_string: "synthetic-person-a@c.us", display_name: "Example Alpha" },
    { _id: 2, raw_string: "synthetic-group@g.us", display_name: "Example Group" },
  ],
  chat: [
    { _id: 10, jid_row_id: 1, subject: null, is_group: 0 },
    { _id: 20, jid_row_id: 2, subject: "Example Group", is_group: 1 },
  ],
  chat_participant: [
    { chat_row_id: 20, jid_row_id: 1, role: "owner" },
    { chat_row_id: 20, jid_row_id: 2, role: "member" },
  ],
  message: [
    {
      _id: 100,
      chat_row_id: 10,
      from_me: 0,
      timestamp: 1700000000000,
      message_type: 1,
      text_data: "synthetic hello",
      sender_jid_row_id: 1,
      quoted_message_id: null,
      edit_version: 0,
    },
    {
      _id: 101,
      chat_row_id: 20,
      from_me: 1,
      timestamp: 1700000001000,
      message_type: 1,
      text_data: "synthetic reply",
      sender_jid_row_id: null,
      quoted_message_id: 100,
      edit_version: 1,
    },
    {
      _id: 102,
      chat_row_id: 20,
      from_me: 0,
      timestamp: 1700000002000,
      message_type: 99,
      text_data: null,
      sender_jid_row_id: 2,
      quoted_message_id: null,
      edit_version: 0,
    },
  ],
  message_edit: [
    {
      message_id: 101,
      edit_version: 1,
      text_data: "synthetic edited reply",
      timestamp: 1700000003000,
    },
  ],
} as const;

const LEGACY_ROWS = {
  chats: [
    { _id: 10, key_remote_jid: "synthetic-person-a@c.us", subject: null, is_group: 0 },
    { _id: 20, key_remote_jid: "synthetic-group@g.us", subject: "Example Group", is_group: 1 },
  ],
  participants: [
    { chat_id: 20, identity: "synthetic-person-a@c.us", role: "owner" },
    { chat_id: 20, identity: "synthetic-person-b@c.us", role: "member" },
  ],
  messages: [
    {
      _id: 100,
      key_remote_jid: "synthetic-person-a@c.us",
      key_from_me: 0,
      timestamp: 1700000000000,
      media_wa_type: 1,
      data: "synthetic hello",
      key_id: "legacy-message-a",
      participant_hash: null,
      quoted_row_id: null,
      edit_version: 0,
    },
    {
      _id: 101,
      key_remote_jid: "synthetic-group@g.us",
      key_from_me: 1,
      timestamp: 1700000001000,
      media_wa_type: 1,
      data: "synthetic reply",
      key_id: "legacy-message-b",
      participant_hash: "synthetic-person-a@c.us",
      quoted_row_id: 100,
      edit_version: 1,
    },
    {
      _id: 102,
      key_remote_jid: "synthetic-group@g.us",
      key_from_me: 0,
      timestamp: 1700000002000,
      media_wa_type: 99,
      data: null,
      key_id: "legacy-message-unknown",
      participant_hash: "synthetic-person-b@c.us",
      quoted_row_id: null,
      edit_version: 0,
    },
  ],
  message_edits: [
    { message_id: 101, edit_version: 1, data: "synthetic edited reply", timestamp: 1700000003000 },
  ],
} as const;

const quote = (value: SqlValue): string => {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${value.replaceAll("'", "''")}'`;
};

const createSql = (schema: SqliteSchemaShape, rows: WhatsAppSqliteFixture["rows"]): string => {
  const statements = Object.keys(schema)
    .sort()
    .map((table) => {
      const columns = schema[table];
      const definitions = columns.map((column) => `    "${column}"`).join(",\n");
      const create = `CREATE TABLE "${table}" (\n${definitions}\n);`;
      const tableRows = rows[table] ?? [];
      const inserts = tableRows.map((row) => {
        const values = columns.map((column) => quote(row[column] ?? null)).join(", ");
        return `INSERT INTO "${table}" ("${columns.join('", "')}") VALUES (${values});`;
      });
      return [create, ...inserts].join("\n");
    });
  return `${statements.join("\n\n")}\n`;
};

export function buildWhatsAppSqliteFixture(
  version: WhatsAppAdapterVersion,
  variant: FixtureVariant = "valid",
): WhatsAppSqliteFixture {
  const schema = version === "android-current.v1" ? CURRENT_SCHEMA : LEGACY_SCHEMA;
  const sourceRows = version === "android-current.v1" ? CURRENT_ROWS : LEGACY_ROWS;
  const rows = structuredClone(sourceRows) as WhatsAppSqliteFixture["rows"];
  if (variant === "damaged") {
    const messageTable = version === "android-current.v1" ? "message" : "messages";
    const messageRows = rows[messageTable] as Readonly<Record<string, SqlValue>>[];
    const bodyColumn = version === "android-current.v1" ? "text_data" : "data";
    messageRows[0] = { ...messageRows[0], [bodyColumn]: "synthetic-malformed-\\u0000-text" };
  }
  return {
    name: `${version}:${variant}`,
    version,
    variant,
    schema,
    rows,
    sql: createSql(schema, rows),
  };
}

export const allWhatsAppSqliteFixtures = (): readonly WhatsAppSqliteFixture[] =>
  (["android-current.v1", "android-legacy.v1"] as const).flatMap((version) =>
    (["valid", "damaged"] as const).map((variant) => buildWhatsAppSqliteFixture(version, variant)),
  );

export function selectFixtureAdapter(fixture: WhatsAppSqliteFixture) {
  return selectWhatsAppAndroidAdapter(fixture.schema);
}
