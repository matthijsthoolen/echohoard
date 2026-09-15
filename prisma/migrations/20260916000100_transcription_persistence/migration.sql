-- EHV2-06-01: immutable transcript history and archive-scoped runs.
CREATE TABLE "Transcript" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "archiveId" UUID NOT NULL,
  "attachmentId" UUID NOT NULL,
  "sourceMediaSha256" VARCHAR(64) NOT NULL,
  "currentMediaSha256" VARCHAR(64) NOT NULL,
  "language" TEXT,
  "selectedModel" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "errorClass" TEXT,
  "manualAuthority" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Transcript_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Transcript_source_digest_check" CHECK ("sourceMediaSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "Transcript_current_digest_check" CHECK ("currentMediaSha256" ~ '^[0-9a-f]{64}$')
);
CREATE TABLE "TranscriptionRequest" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "archiveId" UUID NOT NULL,
  "transcriptId" UUID NOT NULL, "language" TEXT, "selectedModel" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'requested', "errorClass" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TranscriptionRequest_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "TranscriptionRun" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "archiveId" UUID NOT NULL,
  "transcriptId" UUID NOT NULL, "requestId" UUID NOT NULL, "mediaSha256" VARCHAR(64) NOT NULL,
  "language" TEXT, "selectedModel" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending',
  "errorClass" TEXT, "startedAt" TIMESTAMP(3), "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TranscriptionRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TranscriptionRun_digest_check" CHECK ("mediaSha256" ~ '^[0-9a-f]{64}$')
);
CREATE TABLE "TranscriptVersion" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "archiveId" UUID NOT NULL,
  "transcriptId" UUID NOT NULL, "runId" UUID, "mediaSha256" VARCHAR(64) NOT NULL,
  "language" TEXT, "selectedModel" TEXT, "text" TEXT NOT NULL, "isManual" BOOLEAN NOT NULL DEFAULT false,
  "editorId" TEXT, "editedAt" TIMESTAMP(3), "isActive" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TranscriptVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TranscriptVersion_digest_check" CHECK ("mediaSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "TranscriptVersion_manual_editor_check" CHECK (NOT "isManual" OR ("editorId" IS NOT NULL AND "editedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "Transcript_archiveId_id_key" ON "Transcript"("archiveId", "id");
CREATE UNIQUE INDEX "Transcript_archiveId_attachmentId_key" ON "Transcript"("archiveId", "attachmentId");
CREATE INDEX "Transcript_archiveId_status_idx" ON "Transcript"("archiveId", "status");
CREATE UNIQUE INDEX "TranscriptionRequest_archiveId_id_key" ON "TranscriptionRequest"("archiveId", "id");
CREATE INDEX "TranscriptionRequest_archiveId_transcriptId_requestedAt_idx" ON "TranscriptionRequest"("archiveId", "transcriptId", "requestedAt");
CREATE UNIQUE INDEX "TranscriptionRun_archiveId_id_key" ON "TranscriptionRun"("archiveId", "id");
CREATE INDEX "TranscriptionRun_archiveId_transcriptId_createdAt_idx" ON "TranscriptionRun"("archiveId", "transcriptId", "createdAt");
CREATE INDEX "TranscriptionRun_archiveId_status_idx" ON "TranscriptionRun"("archiveId", "status");
CREATE UNIQUE INDEX "TranscriptVersion_archiveId_id_key" ON "TranscriptVersion"("archiveId", "id");
CREATE INDEX "TranscriptVersion_archiveId_transcriptId_createdAt_idx" ON "TranscriptVersion"("archiveId", "transcriptId", "createdAt");
CREATE UNIQUE INDEX "TranscriptVersion_one_active_per_transcript"
  ON "TranscriptVersion"("archiveId", "transcriptId") WHERE "isActive" = true;
ALTER TABLE "Transcript" ADD CONSTRAINT "Transcript_archive_fkey" FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Transcript" ADD CONSTRAINT "Transcript_attachment_fkey" FOREIGN KEY ("attachmentId", "archiveId") REFERENCES "Attachment"("id", "archiveId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TranscriptionRequest" ADD CONSTRAINT "TranscriptionRequest_archive_fkey" FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TranscriptionRequest" ADD CONSTRAINT "TranscriptionRequest_transcript_fkey" FOREIGN KEY ("transcriptId", "archiveId") REFERENCES "Transcript"("id", "archiveId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TranscriptionRun" ADD CONSTRAINT "TranscriptionRun_archive_fkey" FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TranscriptionRun" ADD CONSTRAINT "TranscriptionRun_transcript_fkey" FOREIGN KEY ("transcriptId", "archiveId") REFERENCES "Transcript"("id", "archiveId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TranscriptionRun" ADD CONSTRAINT "TranscriptionRun_request_fkey" FOREIGN KEY ("requestId", "archiveId") REFERENCES "TranscriptionRequest"("id", "archiveId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TranscriptVersion" ADD CONSTRAINT "TranscriptVersion_archive_fkey" FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TranscriptVersion" ADD CONSTRAINT "TranscriptVersion_transcript_fkey" FOREIGN KEY ("transcriptId", "archiveId") REFERENCES "Transcript"("id", "archiveId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TranscriptVersion" ADD CONSTRAINT "TranscriptVersion_run_fkey" FOREIGN KEY ("runId", "archiveId") REFERENCES "TranscriptionRun"("id", "archiveId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Version text/provenance is append-only. Switching the active pointer is the
-- sole permitted update and does not alter historical content.
CREATE FUNCTION prevent_transcript_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."archiveId" IS DISTINCT FROM OLD."archiveId"
     OR NEW."transcriptId" IS DISTINCT FROM OLD."transcriptId"
     OR NEW."runId" IS DISTINCT FROM OLD."runId"
     OR NEW."mediaSha256" IS DISTINCT FROM OLD."mediaSha256"
     OR NEW."language" IS DISTINCT FROM OLD."language"
     OR NEW."selectedModel" IS DISTINCT FROM OLD."selectedModel"
     OR NEW.text IS DISTINCT FROM OLD.text
     OR NEW."isManual" IS DISTINCT FROM OLD."isManual"
     OR NEW."editorId" IS DISTINCT FROM OLD."editorId"
     OR NEW."editedAt" IS DISTINCT FROM OLD."editedAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'transcript versions are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "TranscriptVersion_immutable"
  BEFORE UPDATE ON "TranscriptVersion"
  FOR EACH ROW EXECUTE FUNCTION prevent_transcript_version_mutation();
