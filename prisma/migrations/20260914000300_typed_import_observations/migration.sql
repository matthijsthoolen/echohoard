-- EH-13-04: immutable, typed import evidence with archive/account-scoped keys.
-- Live-shaped imports may not have a snapshot; source and import job are always
-- required. Every target is a typed relation so dangling entity IDs are rejected.

CREATE UNIQUE INDEX "ImportJob_id_archiveId_ownedAccountId_key"
  ON "ImportJob"("id", "archiveId", "ownedAccountId");
CREATE UNIQUE INDEX "SourceConversation_id_archiveId_ownedAccountId_key"
  ON "SourceConversation"("id", "archiveId", "ownedAccountId");
CREATE UNIQUE INDEX "Message_id_archiveId_sourceConversationId_key"
  ON "Message"("id", "archiveId", "sourceConversationId");

CREATE TABLE "ConversationObservation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "archiveId" UUID NOT NULL,
  "ownedAccountId" UUID NOT NULL,
  "sourceId" UUID NOT NULL,
  "snapshotId" UUID,
  "importJobId" UUID NOT NULL,
  "sourceConversationId" UUID NOT NULL,
  "sourceNamespace" TEXT NOT NULL,
  "sourceConversationKey" TEXT NOT NULL,
  "sourceEntityKey" TEXT NOT NULL,
  "logicalEntityKey" TEXT NOT NULL,
  "observationKey" TEXT NOT NULL,
  "observationKind" TEXT NOT NULL,
  "eligibility" TEXT NOT NULL DEFAULT 'eligible',
  "valueDigest" VARCHAR(64) NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConversationObservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConversationObservation_eligibility_check" CHECK ("eligibility" IN ('eligible', 'excluded')),
  CONSTRAINT "ConversationObservation_digest_check" CHECK ("valueDigest" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "MessageObservation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "archiveId" UUID NOT NULL,
  "ownedAccountId" UUID NOT NULL,
  "sourceId" UUID NOT NULL,
  "snapshotId" UUID,
  "importJobId" UUID NOT NULL,
  "sourceConversationId" UUID NOT NULL,
  "messageId" UUID NOT NULL,
  "sourceNamespace" TEXT NOT NULL,
  "sourceConversationKey" TEXT NOT NULL,
  "sourceEntityKey" TEXT NOT NULL,
  "logicalEntityKey" TEXT NOT NULL,
  "observationKey" TEXT NOT NULL,
  "observationKind" TEXT NOT NULL,
  "eligibility" TEXT NOT NULL DEFAULT 'eligible',
  "valueDigest" VARCHAR(64) NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageObservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MessageObservation_eligibility_check" CHECK ("eligibility" IN ('eligible', 'excluded')),
  CONSTRAINT "MessageObservation_digest_check" CHECK ("valueDigest" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "RevisionObservation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "archiveId" UUID NOT NULL,
  "ownedAccountId" UUID NOT NULL,
  "sourceId" UUID NOT NULL,
  "snapshotId" UUID,
  "importJobId" UUID NOT NULL,
  "sourceConversationId" UUID NOT NULL,
  "revisionId" UUID NOT NULL,
  "sourceNamespace" TEXT NOT NULL,
  "sourceConversationKey" TEXT NOT NULL,
  "sourceEntityKey" TEXT NOT NULL,
  "logicalEntityKey" TEXT NOT NULL,
  "observationKey" TEXT NOT NULL,
  "observationKind" TEXT NOT NULL,
  "eligibility" TEXT NOT NULL DEFAULT 'eligible',
  "valueDigest" VARCHAR(64) NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RevisionObservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RevisionObservation_eligibility_check" CHECK ("eligibility" IN ('eligible', 'excluded')),
  CONSTRAINT "RevisionObservation_digest_check" CHECK ("valueDigest" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "ReactionObservation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "archiveId" UUID NOT NULL,
  "ownedAccountId" UUID NOT NULL,
  "sourceId" UUID NOT NULL,
  "snapshotId" UUID,
  "importJobId" UUID NOT NULL,
  "sourceConversationId" UUID NOT NULL,
  "reactionId" UUID NOT NULL,
  "sourceNamespace" TEXT NOT NULL,
  "sourceConversationKey" TEXT NOT NULL,
  "sourceEntityKey" TEXT NOT NULL,
  "logicalEntityKey" TEXT NOT NULL,
  "observationKey" TEXT NOT NULL,
  "observationKind" TEXT NOT NULL,
  "eligibility" TEXT NOT NULL DEFAULT 'eligible',
  "valueDigest" VARCHAR(64) NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReactionObservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReactionObservation_eligibility_check" CHECK ("eligibility" IN ('eligible', 'excluded')),
  CONSTRAINT "ReactionObservation_digest_check" CHECK ("valueDigest" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "AttachmentReferenceObservation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "archiveId" UUID NOT NULL,
  "ownedAccountId" UUID NOT NULL,
  "sourceId" UUID NOT NULL,
  "snapshotId" UUID,
  "importJobId" UUID NOT NULL,
  "sourceConversationId" UUID NOT NULL,
  "messageAttachmentId" UUID NOT NULL,
  "sourceNamespace" TEXT NOT NULL,
  "sourceConversationKey" TEXT NOT NULL,
  "sourceEntityKey" TEXT NOT NULL,
  "logicalEntityKey" TEXT NOT NULL,
  "observationKey" TEXT NOT NULL,
  "observationKind" TEXT NOT NULL,
  "eligibility" TEXT NOT NULL DEFAULT 'eligible',
  "valueDigest" VARCHAR(64) NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AttachmentReferenceObservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AttachmentReferenceObservation_eligibility_check" CHECK ("eligibility" IN ('eligible', 'excluded')),
  CONSTRAINT "AttachmentReferenceObservation_digest_check" CHECK ("valueDigest" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "ConversationObservation_archiveId_id_key" ON "ConversationObservation"("archiveId", "id");
CREATE UNIQUE INDEX "ConversationObservation_identity_key" ON "ConversationObservation"("archiveId", "importJobId", "observationKind", "sourceConversationId", "sourceEntityKey", "observationKey");
CREATE INDEX "ConversationObservation_entity_idx" ON "ConversationObservation"("archiveId", "sourceConversationId", "observedAt");
CREATE INDEX "ConversationObservation_logical_idx" ON "ConversationObservation"("archiveId", "logicalEntityKey");
CREATE UNIQUE INDEX "MessageObservation_archiveId_id_key" ON "MessageObservation"("archiveId", "id");
CREATE UNIQUE INDEX "MessageObservation_identity_key" ON "MessageObservation"("archiveId", "importJobId", "observationKind", "sourceConversationId", "sourceEntityKey", "observationKey");
CREATE INDEX "MessageObservation_entity_idx" ON "MessageObservation"("archiveId", "messageId", "observedAt");
CREATE INDEX "MessageObservation_logical_idx" ON "MessageObservation"("archiveId", "logicalEntityKey");
CREATE UNIQUE INDEX "RevisionObservation_archiveId_id_key" ON "RevisionObservation"("archiveId", "id");
CREATE UNIQUE INDEX "RevisionObservation_identity_key" ON "RevisionObservation"("archiveId", "importJobId", "observationKind", "sourceConversationId", "sourceEntityKey", "observationKey");
CREATE INDEX "RevisionObservation_entity_idx" ON "RevisionObservation"("archiveId", "revisionId", "observedAt");
CREATE INDEX "RevisionObservation_logical_idx" ON "RevisionObservation"("archiveId", "logicalEntityKey");
CREATE UNIQUE INDEX "ReactionObservation_archiveId_id_key" ON "ReactionObservation"("archiveId", "id");
CREATE UNIQUE INDEX "ReactionObservation_identity_key" ON "ReactionObservation"("archiveId", "importJobId", "observationKind", "sourceConversationId", "sourceEntityKey", "observationKey");
CREATE INDEX "ReactionObservation_entity_idx" ON "ReactionObservation"("archiveId", "reactionId", "observedAt");
CREATE INDEX "ReactionObservation_logical_idx" ON "ReactionObservation"("archiveId", "logicalEntityKey");
CREATE UNIQUE INDEX "AttachmentReferenceObservation_archiveId_id_key" ON "AttachmentReferenceObservation"("archiveId", "id");
CREATE UNIQUE INDEX "AttachmentReferenceObservation_identity_key" ON "AttachmentReferenceObservation"("archiveId", "importJobId", "observationKind", "sourceConversationId", "sourceEntityKey", "observationKey");
CREATE INDEX "AttachmentReferenceObservation_entity_idx" ON "AttachmentReferenceObservation"("archiveId", "messageAttachmentId", "observedAt");
CREATE INDEX "AttachmentReferenceObservation_logical_idx" ON "AttachmentReferenceObservation"("archiveId", "logicalEntityKey");

ALTER TABLE "ConversationObservation" ADD CONSTRAINT "ConversationObservation_archive_fkey" FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationObservation" ADD CONSTRAINT "ConversationObservation_account_fkey" FOREIGN KEY ("ownedAccountId", "archiveId") REFERENCES "OwnedAccount"("id", "archiveId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ConversationObservation" ADD CONSTRAINT "ConversationObservation_source_fkey" FOREIGN KEY ("sourceId", "archiveId", "ownedAccountId") REFERENCES "Source"("id", "archiveId", "ownedAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ConversationObservation" ADD CONSTRAINT "ConversationObservation_snapshot_fkey" FOREIGN KEY ("snapshotId", "archiveId", "ownedAccountId") REFERENCES "Snapshot"("id", "archiveId", "ownedAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ConversationObservation" ADD CONSTRAINT "ConversationObservation_job_fkey" FOREIGN KEY ("importJobId", "archiveId", "ownedAccountId") REFERENCES "ImportJob"("id", "archiveId", "ownedAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ConversationObservation" ADD CONSTRAINT "ConversationObservation_conversation_fkey" FOREIGN KEY ("sourceConversationId", "archiveId", "ownedAccountId") REFERENCES "SourceConversation"("id", "archiveId", "ownedAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MessageObservation" ADD CONSTRAINT "MessageObservation_archive_fkey" FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageObservation" ADD CONSTRAINT "MessageObservation_account_fkey" FOREIGN KEY ("ownedAccountId", "archiveId") REFERENCES "OwnedAccount"("id", "archiveId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MessageObservation" ADD CONSTRAINT "MessageObservation_source_fkey" FOREIGN KEY ("sourceId", "archiveId", "ownedAccountId") REFERENCES "Source"("id", "archiveId", "ownedAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MessageObservation" ADD CONSTRAINT "MessageObservation_snapshot_fkey" FOREIGN KEY ("snapshotId", "archiveId", "ownedAccountId") REFERENCES "Snapshot"("id", "archiveId", "ownedAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MessageObservation" ADD CONSTRAINT "MessageObservation_job_fkey" FOREIGN KEY ("importJobId", "archiveId", "ownedAccountId") REFERENCES "ImportJob"("id", "archiveId", "ownedAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MessageObservation" ADD CONSTRAINT "MessageObservation_conversation_fkey" FOREIGN KEY ("sourceConversationId", "archiveId", "ownedAccountId") REFERENCES "SourceConversation"("id", "archiveId", "ownedAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MessageObservation" ADD CONSTRAINT "MessageObservation_message_fkey" FOREIGN KEY ("messageId", "archiveId") REFERENCES "Message"("id", "archiveId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RevisionObservation" ADD CONSTRAINT "RevisionObservation_archive_fkey" FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RevisionObservation" ADD CONSTRAINT "RevisionObservation_account_fkey" FOREIGN KEY ("ownedAccountId", "archiveId") REFERENCES "OwnedAccount"("id", "archiveId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RevisionObservation" ADD CONSTRAINT "RevisionObservation_source_fkey" FOREIGN KEY ("sourceId", "archiveId", "ownedAccountId") REFERENCES "Source"("id", "archiveId", "ownedAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RevisionObservation" ADD CONSTRAINT "RevisionObservation_snapshot_fkey" FOREIGN KEY ("snapshotId", "archiveId", "ownedAccountId") REFERENCES "Snapshot"("id", "archiveId", "ownedAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RevisionObservation" ADD CONSTRAINT "RevisionObservation_job_fkey" FOREIGN KEY ("importJobId", "archiveId", "ownedAccountId") REFERENCES "ImportJob"("id", "archiveId", "ownedAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RevisionObservation" ADD CONSTRAINT "RevisionObservation_conversation_fkey" FOREIGN KEY ("sourceConversationId", "archiveId", "ownedAccountId") REFERENCES "SourceConversation"("id", "archiveId", "ownedAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RevisionObservation" ADD CONSTRAINT "RevisionObservation_revision_fkey" FOREIGN KEY ("revisionId", "archiveId") REFERENCES "MessageRevision"("id", "archiveId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReactionObservation" ADD CONSTRAINT "ReactionObservation_archive_fkey" FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReactionObservation" ADD CONSTRAINT "ReactionObservation_account_fkey" FOREIGN KEY ("ownedAccountId", "archiveId") REFERENCES "OwnedAccount"("id", "archiveId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReactionObservation" ADD CONSTRAINT "ReactionObservation_source_fkey" FOREIGN KEY ("sourceId", "archiveId", "ownedAccountId") REFERENCES "Source"("id", "archiveId", "ownedAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReactionObservation" ADD CONSTRAINT "ReactionObservation_snapshot_fkey" FOREIGN KEY ("snapshotId", "archiveId", "ownedAccountId") REFERENCES "Snapshot"("id", "archiveId", "ownedAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReactionObservation" ADD CONSTRAINT "ReactionObservation_job_fkey" FOREIGN KEY ("importJobId", "archiveId", "ownedAccountId") REFERENCES "ImportJob"("id", "archiveId", "ownedAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReactionObservation" ADD CONSTRAINT "ReactionObservation_conversation_fkey" FOREIGN KEY ("sourceConversationId", "archiveId", "ownedAccountId") REFERENCES "SourceConversation"("id", "archiveId", "ownedAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReactionObservation" ADD CONSTRAINT "ReactionObservation_reaction_fkey" FOREIGN KEY ("reactionId", "archiveId") REFERENCES "Reaction"("id", "archiveId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AttachmentReferenceObservation" ADD CONSTRAINT "AttachmentReferenceObservation_archive_fkey" FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttachmentReferenceObservation" ADD CONSTRAINT "AttachmentReferenceObservation_account_fkey" FOREIGN KEY ("ownedAccountId", "archiveId") REFERENCES "OwnedAccount"("id", "archiveId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AttachmentReferenceObservation" ADD CONSTRAINT "AttachmentReferenceObservation_source_fkey" FOREIGN KEY ("sourceId", "archiveId", "ownedAccountId") REFERENCES "Source"("id", "archiveId", "ownedAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AttachmentReferenceObservation" ADD CONSTRAINT "AttachmentReferenceObservation_snapshot_fkey" FOREIGN KEY ("snapshotId", "archiveId", "ownedAccountId") REFERENCES "Snapshot"("id", "archiveId", "ownedAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AttachmentReferenceObservation" ADD CONSTRAINT "AttachmentReferenceObservation_job_fkey" FOREIGN KEY ("importJobId", "archiveId", "ownedAccountId") REFERENCES "ImportJob"("id", "archiveId", "ownedAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AttachmentReferenceObservation" ADD CONSTRAINT "AttachmentReferenceObservation_conversation_fkey" FOREIGN KEY ("sourceConversationId", "archiveId", "ownedAccountId") REFERENCES "SourceConversation"("id", "archiveId", "ownedAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AttachmentReferenceObservation" ADD CONSTRAINT "AttachmentReferenceObservation_link_fkey" FOREIGN KEY ("messageAttachmentId", "archiveId") REFERENCES "MessageAttachment"("id", "archiveId") ON DELETE RESTRICT ON UPDATE CASCADE;
