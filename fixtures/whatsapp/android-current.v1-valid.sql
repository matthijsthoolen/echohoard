CREATE TABLE "chat" (
    "_id",
    "jid_row_id",
    "subject",
    "is_group"
);
INSERT INTO "chat" ("_id", "jid_row_id", "subject", "is_group") VALUES (10, 1, NULL, 0);
INSERT INTO "chat" ("_id", "jid_row_id", "subject", "is_group") VALUES (20, 2, 'Example Group', 1);

CREATE TABLE "chat_participant" (
    "chat_row_id",
    "jid_row_id",
    "role"
);
INSERT INTO "chat_participant" ("chat_row_id", "jid_row_id", "role") VALUES (20, 1, 'owner');
INSERT INTO "chat_participant" ("chat_row_id", "jid_row_id", "role") VALUES (20, 2, 'member');

CREATE TABLE "jid" (
    "_id",
    "raw_string",
    "display_name"
);
INSERT INTO "jid" ("_id", "raw_string", "display_name") VALUES (1, 'synthetic-person-a@c.us', 'Example Alpha');
INSERT INTO "jid" ("_id", "raw_string", "display_name") VALUES (2, 'synthetic-group@g.us', 'Example Group');

CREATE TABLE "message" (
    "_id",
    "chat_row_id",
    "from_me",
    "timestamp",
    "message_type",
    "text_data",
    "sender_jid_row_id",
    "quoted_message_id",
    "edit_version"
);
INSERT INTO "message" ("_id", "chat_row_id", "from_me", "timestamp", "message_type", "text_data", "sender_jid_row_id", "quoted_message_id", "edit_version") VALUES (100, 10, 0, 1700000000000, 1, 'synthetic hello', 1, NULL, 0);
INSERT INTO "message" ("_id", "chat_row_id", "from_me", "timestamp", "message_type", "text_data", "sender_jid_row_id", "quoted_message_id", "edit_version") VALUES (101, 20, 1, 1700000001000, 1, 'synthetic reply', NULL, 100, 1);
INSERT INTO "message" ("_id", "chat_row_id", "from_me", "timestamp", "message_type", "text_data", "sender_jid_row_id", "quoted_message_id", "edit_version") VALUES (102, 20, 0, 1700000002000, 99, NULL, 2, NULL, 0);

CREATE TABLE "message_edit" (
    "message_id",
    "edit_version",
    "text_data",
    "timestamp"
);
INSERT INTO "message_edit" ("message_id", "edit_version", "text_data", "timestamp") VALUES (101, 1, 'synthetic edited reply', 1700000003000);
