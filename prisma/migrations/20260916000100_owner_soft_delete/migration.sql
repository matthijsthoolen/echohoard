-- EHV2-04-01: reversible owner policy state and identifier-only audit receipts.
ALTER TABLE "Conversation" ADD COLUMN "ownerDeletionVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Message" ADD COLUMN "ownerDeletionVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Attachment" ADD COLUMN "ownerDeletionVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "OwnerDeletionAudit" (
  "id" UUID NOT NULL,
  "archiveId" UUID NOT NULL,
  "entityKind" TEXT NOT NULL,
  "entityId" UUID NOT NULL,
  "action" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "expectedVersion" INTEGER,
  "resultingVersion" INTEGER NOT NULL,
  "cascadeCount" INTEGER NOT NULL DEFAULT 0,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OwnerDeletionAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OwnerDeletionAudit_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OwnerDeletionAudit_archiveId_id_key" ON "OwnerDeletionAudit"("archiveId", "id");
CREATE UNIQUE INDEX "OwnerDeletionAudit_archiveId_idempotencyKey_key" ON "OwnerDeletionAudit"("archiveId", "idempotencyKey");
CREATE INDEX "OwnerDeletionAudit_archiveId_entityKind_entityId_occurredAt_idx" ON "OwnerDeletionAudit"("archiveId", "entityKind", "entityId", "occurredAt");
