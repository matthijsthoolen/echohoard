-- EH-13-03: retain account-specific chat identity while keeping existing
-- Conversation identifiers as the initial unified presentation groups.
CREATE TABLE "SourceConversation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "archiveId" UUID NOT NULL,
  "ownedAccountId" UUID NOT NULL,
  "unifiedConversationId" UUID NOT NULL,
  "sourceNamespace" TEXT NOT NULL,
  "sourceConversationKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SourceConversation_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ConversationParticipant" ADD COLUMN "sourceConversationId" UUID;
ALTER TABLE "Message" ADD COLUMN "sourceConversationId" UUID;

-- V1 conversations have one archive-local legacy account from EH-13-02.
-- Their primary keys are reused as the source conversation keys so no stable
-- normalized identifier is rewritten during the migration.
INSERT INTO "SourceConversation" (
  "archiveId", "ownedAccountId", "unifiedConversationId", "sourceNamespace",
  "sourceConversationKey", "updatedAt"
)
SELECT conversation."archiveId", account."id", conversation."id", 'legacy-conversation',
       conversation."stableKey", CURRENT_TIMESTAMP
FROM "Conversation" AS conversation
JOIN "OwnedAccount" AS account
  ON account."archiveId" = conversation."archiveId"
 AND account."accountKey" = 'legacy-default';

UPDATE "ConversationParticipant" AS participant
SET "sourceConversationId" = source."id"
FROM "SourceConversation" AS source
WHERE source."archiveId" = participant."archiveId"
  AND source."unifiedConversationId" = participant."conversationId";

UPDATE "Message" AS message
SET "sourceConversationId" = source."id"
FROM "SourceConversation" AS source
WHERE source."archiveId" = message."archiveId"
  AND source."unifiedConversationId" = message."conversationId";

CREATE UNIQUE INDEX "SourceConversation_archiveId_id_key"
  ON "SourceConversation"("archiveId", "id");
CREATE UNIQUE INDEX "SourceConversation_archiveId_ownedAccountId_sourceNamespace_sourceConversationKey_key"
  ON "SourceConversation"("archiveId", "ownedAccountId", "sourceNamespace", "sourceConversationKey");
CREATE UNIQUE INDEX "SourceConversation_archiveId_id_unifiedConversationId_key"
  ON "SourceConversation"("archiveId", "id", "unifiedConversationId");
CREATE UNIQUE INDEX "SourceConversation_id_unifiedConversationId_archiveId_key"
  ON "SourceConversation"("id", "unifiedConversationId", "archiveId");
CREATE INDEX "SourceConversation_archiveId_ownedAccountId_idx"
  ON "SourceConversation"("archiveId", "ownedAccountId");
CREATE UNIQUE INDEX "ConversationParticipant_archiveId_sourceConversationId_personId_key"
  ON "ConversationParticipant"("archiveId", "sourceConversationId", "personId");
CREATE UNIQUE INDEX "Message_archiveId_sourceConversationId_id_key"
  ON "Message"("archiveId", "sourceConversationId", "id");

ALTER TABLE "SourceConversation"
  ADD CONSTRAINT "SourceConversation_archiveId_fkey"
  FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SourceConversation"
  ADD CONSTRAINT "SourceConversation_ownedAccountId_archiveId_fkey"
  FOREIGN KEY ("ownedAccountId", "archiveId") REFERENCES "OwnedAccount"("id", "archiveId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SourceConversation"
  ADD CONSTRAINT "SourceConversation_unifiedConversationId_archiveId_fkey"
  FOREIGN KEY ("unifiedConversationId", "archiveId") REFERENCES "Conversation"("id", "archiveId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ConversationParticipant"
  ADD CONSTRAINT "ConversationParticipant_sourceConversationId_conversationId_archiveId_fkey"
  FOREIGN KEY ("sourceConversationId", "conversationId", "archiveId")
  REFERENCES "SourceConversation"("id", "unifiedConversationId", "archiveId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message"
  ADD CONSTRAINT "Message_sourceConversationId_conversationId_archiveId_fkey"
  FOREIGN KEY ("sourceConversationId", "conversationId", "archiveId")
  REFERENCES "SourceConversation"("id", "unifiedConversationId", "archiveId") ON DELETE RESTRICT ON UPDATE CASCADE;
