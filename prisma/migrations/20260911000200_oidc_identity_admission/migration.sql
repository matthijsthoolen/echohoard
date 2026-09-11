CREATE TABLE "ArchiveIdentity" (
  "id" UUID NOT NULL,
  "archiveId" UUID NOT NULL,
  "issuer" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'pending',
  "approvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ArchiveIdentity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ArchiveIdentity_archiveId_issuer_subject_key"
  ON "ArchiveIdentity"("archiveId", "issuer", "subject");
CREATE INDEX "ArchiveIdentity_archiveId_role_idx"
  ON "ArchiveIdentity"("archiveId", "role");
ALTER TABLE "ArchiveIdentity"
  ADD CONSTRAINT "ArchiveIdentity_archiveId_fkey"
  FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE;
