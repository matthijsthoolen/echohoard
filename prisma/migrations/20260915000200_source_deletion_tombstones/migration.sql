-- EH-13-07: source deletion is append-preserving event evidence. Owner
-- deletion is an independent, future policy operation and is not populated by
-- imports.
ALTER TABLE "Message"
  ADD COLUMN "sourceDeleted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "contentUnavailable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sourceDeletedAt" TIMESTAMP(3),
  ADD COLUMN "sourceDeletionObservationKey" TEXT,
  ADD COLUMN "sourceDeletionMetadata" JSONB,
  ADD COLUMN "ownerDeleted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "ownerDeletedAt" TIMESTAMP(3),
  ADD COLUMN "ownerDeletedBy" TEXT,
  ADD COLUMN "ownerDeletionReason" TEXT;
CREATE INDEX "Message_archiveId_sourceDeleted_idx" ON "Message"("archiveId", "sourceDeleted");

ALTER TABLE "Conversation" ADD COLUMN "ownerDeleted" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "ownerDeletedAt" TIMESTAMP(3), ADD COLUMN "ownerDeletedBy" TEXT, ADD COLUMN "ownerDeletionReason" TEXT;
ALTER TABLE "MessageRevision" ADD COLUMN "ownerDeleted" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "ownerDeletedAt" TIMESTAMP(3), ADD COLUMN "ownerDeletedBy" TEXT, ADD COLUMN "ownerDeletionReason" TEXT;
ALTER TABLE "Reaction" ADD COLUMN "ownerDeleted" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "ownerDeletedAt" TIMESTAMP(3), ADD COLUMN "ownerDeletedBy" TEXT, ADD COLUMN "ownerDeletionReason" TEXT;
ALTER TABLE "Attachment" ADD COLUMN "ownerDeleted" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "ownerDeletedAt" TIMESTAMP(3), ADD COLUMN "ownerDeletedBy" TEXT, ADD COLUMN "ownerDeletionReason" TEXT;
ALTER TABLE "MessageAttachment" ADD COLUMN "ownerDeleted" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "ownerDeletedAt" TIMESTAMP(3), ADD COLUMN "ownerDeletedBy" TEXT, ADD COLUMN "ownerDeletionReason" TEXT;
