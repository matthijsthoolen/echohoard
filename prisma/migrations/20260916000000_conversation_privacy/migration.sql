ALTER TABLE "Conversation"
  ADD COLUMN "uiVisibility" TEXT NOT NULL DEFAULT 'normal',
  ADD COLUMN "mcpAccess" TEXT NOT NULL DEFAULT 'allowed',
  ADD COLUMN "sourceLockMetadata" JSONB;

ALTER TABLE "Conversation"
  ADD CONSTRAINT "Conversation_uiVisibility_check"
    CHECK ("uiVisibility" IN ('normal', 'hidden', 'locked')),
  ADD CONSTRAINT "Conversation_mcpAccess_check"
    CHECK ("mcpAccess" IN ('allowed', 'denied'));

CREATE TABLE "ConversationPrivacyAudit" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "archiveId" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "actorId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConversationPrivacyAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConversationPrivacyAudit_action_check"
    CHECK ("action" IN ('set-ui-visibility', 'set-mcp-access'))
);

CREATE UNIQUE INDEX "ConversationPrivacyAudit_archiveId_id_key"
  ON "ConversationPrivacyAudit"("archiveId", "id");
CREATE INDEX "ConversationPrivacyAudit_archiveId_conversationId_createdAt_idx"
  ON "ConversationPrivacyAudit"("archiveId", "conversationId", "createdAt");
ALTER TABLE "ConversationPrivacyAudit"
  ADD CONSTRAINT "ConversationPrivacyAudit_archiveId_fkey"
    FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ConversationPrivacyAudit_conversationId_archiveId_fkey"
    FOREIGN KEY ("conversationId", "archiveId") REFERENCES "Conversation"("id", "archiveId")
    ON DELETE CASCADE ON UPDATE CASCADE;
