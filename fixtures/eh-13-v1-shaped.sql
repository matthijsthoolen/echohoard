-- Synthetic pre-EH-13 V1 rows used only by the migration acceptance proof.
INSERT INTO "User" ("id", "updatedAt")
VALUES ('00000000-0000-4000-8000-000000000001', CURRENT_TIMESTAMP);
INSERT INTO "Archive" ("id", "userId", "name", "updatedAt")
VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'synthetic-v1-archive', CURRENT_TIMESTAMP);
INSERT INTO "Source" ("id", "archiveId", "kind", "stableKey", "sha256", "updatedAt")
VALUES ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', 'backup', 'synthetic-source', repeat('a', 64), CURRENT_TIMESTAMP);
INSERT INTO "Snapshot" ("id", "archiveId", "sourceId", "sha256")
VALUES ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', repeat('a', 64));
INSERT INTO "ImportJob" ("id", "archiveId", "sourceId", "snapshotId", "status", "updatedAt")
VALUES ('00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004', 'complete', CURRENT_TIMESTAMP);
INSERT INTO "Person" ("id", "archiveId", "displayName", "updatedAt")
VALUES ('00000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000002', 'Synthetic Person', CURRENT_TIMESTAMP);
INSERT INTO "Conversation" ("id", "archiveId", "kind", "stableKey", "title", "updatedAt")
VALUES ('00000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000002', 'direct', 'synthetic-conversation', 'Synthetic Conversation', CURRENT_TIMESTAMP);
INSERT INTO "Message" ("id", "archiveId", "conversationId", "stableKey", "messageType", "body", "updatedAt")
VALUES ('00000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000007', 'synthetic-message', 'text', 'synthetic body', CURRENT_TIMESTAMP);
