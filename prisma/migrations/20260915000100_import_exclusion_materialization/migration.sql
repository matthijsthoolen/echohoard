-- EH-13-06: reversible import eligibility and transactional materialization
-- generations. Exclusion never deletes source, snapshot, job, or observation
-- evidence; derived rows are retained but marked not materialized.
ALTER TABLE "ImportJob" ADD COLUMN "eligibility" TEXT NOT NULL DEFAULT 'eligible';
ALTER TABLE "ImportJob"
  ADD CONSTRAINT "ImportJob_eligibility_check"
  CHECK ("eligibility" IN ('eligible', 'excluded'));
CREATE INDEX "ImportJob_archiveId_eligibility_idx"
  ON "ImportJob"("archiveId", "eligibility");

ALTER TABLE "Conversation"
  ADD COLUMN "materialized" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "materializationRunId" TEXT,
  ADD COLUMN "materializationInputDigest" VARCHAR(64),
  ADD COLUMN "materializationPolicyVersion" TEXT;
ALTER TABLE "Message"
  ADD COLUMN "materialized" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "materializationRunId" TEXT,
  ADD COLUMN "materializationInputDigest" VARCHAR(64),
  ADD COLUMN "materializationPolicyVersion" TEXT;
ALTER TABLE "MessageRevision"
  ADD COLUMN "materialized" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "materializationRunId" TEXT,
  ADD COLUMN "materializationInputDigest" VARCHAR(64),
  ADD COLUMN "materializationPolicyVersion" TEXT;
ALTER TABLE "Reaction"
  ADD COLUMN "materialized" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "materializationRunId" TEXT,
  ADD COLUMN "materializationInputDigest" VARCHAR(64),
  ADD COLUMN "materializationPolicyVersion" TEXT;
ALTER TABLE "MessageAttachment"
  ADD COLUMN "materialized" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "materializationRunId" TEXT,
  ADD COLUMN "materializationInputDigest" VARCHAR(64),
  ADD COLUMN "materializationPolicyVersion" TEXT;

ALTER TABLE "ConversationObservation" ADD COLUMN "observedValue" JSONB;
ALTER TABLE "MessageObservation" ADD COLUMN "observedValue" JSONB;
ALTER TABLE "RevisionObservation" ADD COLUMN "observedValue" JSONB;
ALTER TABLE "ReactionObservation" ADD COLUMN "observedValue" JSONB;
ALTER TABLE "AttachmentReferenceObservation" ADD COLUMN "observedValue" JSONB;

CREATE TABLE "ImportEligibilityDecision" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "archiveId" UUID NOT NULL,
  "importJobId" UUID NOT NULL,
  "eligibility" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "decidedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImportEligibilityDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ImportEligibilityDecision_eligibility_check"
    CHECK ("eligibility" IN ('eligible', 'excluded'))
);
CREATE UNIQUE INDEX "ImportEligibilityDecision_archiveId_id_key"
  ON "ImportEligibilityDecision"("archiveId", "id");
CREATE UNIQUE INDEX "ImportEligibilityDecision_idempotency_key"
  ON "ImportEligibilityDecision"("archiveId", "importJobId", "idempotencyKey");
CREATE INDEX "ImportEligibilityDecision_job_idx"
  ON "ImportEligibilityDecision"("archiveId", "importJobId", "decidedAt");
ALTER TABLE "ImportEligibilityDecision"
  ADD CONSTRAINT "ImportEligibilityDecision_archive_fkey"
  FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ImportEligibilityDecision_job_fkey"
  FOREIGN KEY ("importJobId", "archiveId") REFERENCES "ImportJob"("id", "archiveId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "MaterializationRun" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "archiveId" UUID NOT NULL,
  "importJobId" UUID NOT NULL,
  "action" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "actor" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "inputSetDigest" VARCHAR(64) NOT NULL,
  "result" JSONB,
  "errorClass" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MaterializationRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MaterializationRun_status_check"
    CHECK ("status" IN ('running', 'completed', 'failed'))
);
CREATE UNIQUE INDEX "MaterializationRun_archiveId_id_key"
  ON "MaterializationRun"("archiveId", "id");
CREATE UNIQUE INDEX "MaterializationRun_idempotency_key"
  ON "MaterializationRun"("archiveId", "importJobId", "idempotencyKey");
CREATE INDEX "MaterializationRun_job_status_idx"
  ON "MaterializationRun"("archiveId", "importJobId", "status");
ALTER TABLE "MaterializationRun"
  ADD CONSTRAINT "MaterializationRun_archive_fkey"
  FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MaterializationRun_job_fkey"
  FOREIGN KEY ("importJobId", "archiveId") REFERENCES "ImportJob"("id", "archiveId") ON DELETE RESTRICT ON UPDATE CASCADE;
