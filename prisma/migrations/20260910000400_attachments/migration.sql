CREATE TABLE "Attachment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "archiveId" UUID NOT NULL,
  "stableKey" TEXT,
  "sha256" VARCHAR(64) NOT NULL,
  "availability" TEXT NOT NULL DEFAULT 'missing',
  "casKey" TEXT,
  "originalName" TEXT,
  "originalPath" TEXT,
  "mimeType" TEXT,
  "byteSize" BIGINT,
  "width" INTEGER,
  "height" INTEGER,
  "durationMs" INTEGER,
  "sourceMetadata" JSONB,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MessageAttachment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "archiveId" UUID NOT NULL,
  "messageId" UUID NOT NULL,
  "attachmentId" UUID NOT NULL,
  "ordinal" INTEGER,
  "role" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MessageAttachment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Attachment_archiveId_id_key" ON "Attachment"("archiveId", "id");
CREATE UNIQUE INDEX "Attachment_archiveId_stableKey_key" ON "Attachment"("archiveId", "stableKey");
CREATE UNIQUE INDEX "Attachment_archiveId_sha256_key" ON "Attachment"("archiveId", "sha256");
CREATE INDEX "Attachment_archiveId_availability_idx" ON "Attachment"("archiveId", "availability");
CREATE UNIQUE INDEX "MessageAttachment_archiveId_id_key" ON "MessageAttachment"("archiveId", "id");
CREATE UNIQUE INDEX "MessageAttachment_archiveId_messageId_attachmentId_key" ON "MessageAttachment"("archiveId", "messageId", "attachmentId");
CREATE INDEX "MessageAttachment_archiveId_messageId_idx" ON "MessageAttachment"("archiveId", "messageId");

ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_messageId_archiveId_fkey" FOREIGN KEY ("messageId", "archiveId") REFERENCES "Message"("id", "archiveId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_attachmentId_archiveId_fkey" FOREIGN KEY ("attachmentId", "archiveId") REFERENCES "Attachment"("id", "archiveId") ON DELETE CASCADE ON UPDATE CASCADE;
