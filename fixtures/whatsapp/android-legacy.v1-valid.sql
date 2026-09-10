CREATE TABLE "chats" (
    "_id",
    "key_remote_jid",
    "subject",
    "is_group"
);
INSERT INTO "chats" ("_id", "key_remote_jid", "subject", "is_group") VALUES (10, 'synthetic-person-a@c.us', NULL, 0);
INSERT INTO "chats" ("_id", "key_remote_jid", "subject", "is_group") VALUES (20, 'synthetic-group@g.us', 'Example Group', 1);

CREATE TABLE "message_edits" (
    "message_id",
    "edit_version",
    "data",
    "timestamp"
);
INSERT INTO "message_edits" ("message_id", "edit_version", "data", "timestamp") VALUES (101, 1, 'synthetic edited reply', 1700000003000);

CREATE TABLE "messages" (
    "_id",
    "key_remote_jid",
    "key_from_me",
    "timestamp",
    "media_wa_type",
    "data",
    "key_id",
    "participant_hash",
    "quoted_row_id",
    "edit_version"
);
INSERT INTO "messages" ("_id", "key_remote_jid", "key_from_me", "timestamp", "media_wa_type", "data", "key_id", "participant_hash", "quoted_row_id", "edit_version") VALUES (100, 'synthetic-person-a@c.us', 0, 1700000000000, 1, 'synthetic hello', 'legacy-message-a', NULL, NULL, 0);
INSERT INTO "messages" ("_id", "key_remote_jid", "key_from_me", "timestamp", "media_wa_type", "data", "key_id", "participant_hash", "quoted_row_id", "edit_version") VALUES (101, 'synthetic-group@g.us', 1, 1700000001000, 1, 'synthetic reply', 'legacy-message-b', 'synthetic-person-a@c.us', 100, 1);
INSERT INTO "messages" ("_id", "key_remote_jid", "key_from_me", "timestamp", "media_wa_type", "data", "key_id", "participant_hash", "quoted_row_id", "edit_version") VALUES (102, 'synthetic-group@g.us', 0, 1700000002000, 99, NULL, 'legacy-message-unknown', 'synthetic-person-b@c.us', NULL, 0);

CREATE TABLE "participants" (
    "chat_id",
    "identity",
    "role"
);
INSERT INTO "participants" ("chat_id", "identity", "role") VALUES (20, 'synthetic-person-a@c.us', 'owner');
INSERT INTO "participants" ("chat_id", "identity", "role") VALUES (20, 'synthetic-person-b@c.us', 'member');
