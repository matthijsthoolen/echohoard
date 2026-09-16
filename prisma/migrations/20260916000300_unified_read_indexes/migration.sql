-- EHV2-02-04: support archive-scoped unified and source-account read filters.
CREATE INDEX "SourceConversation_archiveId_unifiedConversationId_idx"
  ON "SourceConversation"("archiveId", "unifiedConversationId");
CREATE INDEX "SourceConversation_archiveId_ownedAccountId_unifiedConversationId_idx"
  ON "SourceConversation"("archiveId", "ownedAccountId", "unifiedConversationId");
