-- EHV2-01-03: signed live events are durable receipts, not normalized messages.
CREATE TABLE "LiveEventInbox" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "archiveId" UUID NOT NULL,
  "ownedAccountId" UUID NOT NULL,
  "receiptId" VARCHAR(64) NOT NULL,
  "sourceEventKey" VARCHAR(512) NOT NULL,
  "eventKind" VARCHAR(64) NOT NULL,
  "payload" JSONB NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LiveEventInbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LiveEventInbox_archive_fkey" FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "LiveEventInbox_account_fkey" FOREIGN KEY ("ownedAccountId", "archiveId") REFERENCES "OwnedAccount"("id", "archiveId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "LiveEventInbox_archiveId_id_key" ON "LiveEventInbox"("archiveId", "id");
CREATE UNIQUE INDEX "LiveEventInbox_archiveId_ownedAccountId_receiptId_key" ON "LiveEventInbox"("archiveId", "ownedAccountId", "receiptId");
CREATE INDEX "LiveEventInbox_pending_idx" ON "LiveEventInbox"("archiveId", "ownedAccountId", "status", "createdAt");
