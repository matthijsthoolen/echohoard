-- EHV2-02-01: audited, optimistic, reversible presentation grouping.
ALTER TABLE "Conversation"
  ADD COLUMN "ownerTitle" TEXT,
  ADD COLUMN "ownerAvatar" TEXT,
  ADD COLUMN "groupingVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "groupingLocked" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ConversationParticipant"
  DROP CONSTRAINT IF EXISTS "ConversationParticipant_sourceConversationId_conversationId_archiveId_fkey";
ALTER TABLE "Message"
  DROP CONSTRAINT IF EXISTS "Message_sourceConversationId_conversationId_archiveId_fkey";

ALTER TABLE "ConversationParticipant"
  ADD CONSTRAINT "ConversationParticipant_sourceConversationId_archiveId_fkey"
  FOREIGN KEY ("sourceConversationId", "archiveId")
  REFERENCES "SourceConversation"("id", "archiveId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message"
  ADD CONSTRAINT "Message_sourceConversationId_archiveId_fkey"
  FOREIGN KEY ("sourceConversationId", "archiveId")
  REFERENCES "SourceConversation"("id", "archiveId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ConversationMergeAudit" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "archiveId" UUID NOT NULL,
  "targetConversationId" UUID NOT NULL,
  "action" TEXT NOT NULL,
  "sourceConversationIds" JSONB NOT NULL,
  "previousGroups" JSONB NOT NULL,
  "resultingVersion" INTEGER NOT NULL,
  "expectedVersion" INTEGER NOT NULL,
  "actor" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConversationMergeAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConversationMergeAudit_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ConversationMergeAudit_targetConversationId_archiveId_fkey" FOREIGN KEY ("targetConversationId", "archiveId") REFERENCES "Conversation"("id", "archiveId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ConversationMergeAudit_archiveId_id_key" ON "ConversationMergeAudit"("archiveId", "id");
CREATE UNIQUE INDEX "ConversationMergeAudit_archiveId_idempotencyKey_key" ON "ConversationMergeAudit"("archiveId", "idempotencyKey");
CREATE INDEX "ConversationMergeAudit_archiveId_targetConversationId_createdAt_idx" ON "ConversationMergeAudit"("archiveId", "targetConversationId", "createdAt");
