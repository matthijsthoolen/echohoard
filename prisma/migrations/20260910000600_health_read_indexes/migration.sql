CREATE INDEX "Snapshot_archiveId_lifecycle_completedAt_idx"
  ON "Snapshot"("archiveId", "lifecycle", "completedAt");

CREATE INDEX "Snapshot_archiveId_capturedAt_idx"
  ON "Snapshot"("archiveId", "capturedAt");

CREATE INDEX "ImportJob_archiveId_createdAt_idx"
  ON "ImportJob"("archiveId", "createdAt");

CREATE INDEX "Message_archiveId_sentAt_idx"
  ON "Message"("archiveId", "sentAt");
