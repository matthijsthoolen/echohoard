-- EH-13-02: make the receiving WhatsApp account explicit without encoding a
-- production phone number or other owner-specific identity.
CREATE TABLE "OwnedAccount" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "archiveId" UUID NOT NULL,
  "accountKey" TEXT NOT NULL,
  "displayLabel" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OwnedAccount_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Source" ADD COLUMN "ownedAccountId" UUID;
ALTER TABLE "Snapshot" ADD COLUMN "ownedAccountId" UUID;
ALTER TABLE "ImportJob" ADD COLUMN "ownedAccountId" UUID;

-- Existing V1 rows are synthetic in the public repository. Give each archive
-- one explicit opaque legacy account so the backfill remains archive-local.
INSERT INTO "OwnedAccount" ("archiveId", "accountKey", "updatedAt")
SELECT "id", 'legacy-default', CURRENT_TIMESTAMP
FROM "Archive";

UPDATE "Source" AS source
SET "ownedAccountId" = account."id"
FROM "OwnedAccount" AS account
WHERE account."archiveId" = source."archiveId"
  AND account."accountKey" = 'legacy-default';

UPDATE "Snapshot" AS snapshot
SET "ownedAccountId" = account."id"
FROM "OwnedAccount" AS account
WHERE account."archiveId" = snapshot."archiveId"
  AND account."accountKey" = 'legacy-default';

UPDATE "ImportJob" AS job
SET "ownedAccountId" = account."id"
FROM "OwnedAccount" AS account
WHERE account."archiveId" = job."archiveId"
  AND account."accountKey" = 'legacy-default';

ALTER TABLE "Source" ALTER COLUMN "ownedAccountId" SET NOT NULL;
ALTER TABLE "Snapshot" ALTER COLUMN "ownedAccountId" SET NOT NULL;
ALTER TABLE "ImportJob" ALTER COLUMN "ownedAccountId" SET NOT NULL;

CREATE UNIQUE INDEX "OwnedAccount_archiveId_id_key" ON "OwnedAccount"("archiveId", "id");
CREATE UNIQUE INDEX "OwnedAccount_archiveId_accountKey_key" ON "OwnedAccount"("archiveId", "accountKey");
CREATE INDEX "OwnedAccount_archiveId_idx" ON "OwnedAccount"("archiveId");

DROP INDEX "Source_archiveId_kind_stableKey_key";
CREATE UNIQUE INDEX "Source_archiveId_ownedAccountId_kind_stableKey_key"
  ON "Source"("archiveId", "ownedAccountId", "kind", "stableKey");
CREATE UNIQUE INDEX "Source_id_archiveId_ownedAccountId_key"
  ON "Source"("id", "archiveId", "ownedAccountId");

DROP INDEX "Snapshot_archiveId_sourceId_sha256_key";
CREATE UNIQUE INDEX "Snapshot_archiveId_ownedAccountId_sourceId_sha256_key"
  ON "Snapshot"("archiveId", "ownedAccountId", "sourceId", "sha256");
CREATE UNIQUE INDEX "Snapshot_id_archiveId_ownedAccountId_key"
  ON "Snapshot"("id", "archiveId", "ownedAccountId");

ALTER TABLE "OwnedAccount"
  ADD CONSTRAINT "OwnedAccount_archiveId_fkey"
  FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Source"
  ADD CONSTRAINT "Source_ownedAccountId_archiveId_fkey"
  FOREIGN KEY ("ownedAccountId", "archiveId") REFERENCES "OwnedAccount"("id", "archiveId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Snapshot"
  ADD CONSTRAINT "Snapshot_ownedAccountId_archiveId_fkey"
  FOREIGN KEY ("ownedAccountId", "archiveId") REFERENCES "OwnedAccount"("id", "archiveId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Snapshot"
  DROP CONSTRAINT "Snapshot_sourceId_archiveId_fkey",
  ADD CONSTRAINT "Snapshot_sourceId_archiveId_ownedAccountId_fkey"
  FOREIGN KEY ("sourceId", "archiveId", "ownedAccountId") REFERENCES "Source"("id", "archiveId", "ownedAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImportJob"
  ADD CONSTRAINT "ImportJob_ownedAccountId_archiveId_fkey"
  FOREIGN KEY ("ownedAccountId", "archiveId") REFERENCES "OwnedAccount"("id", "archiveId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImportJob"
  DROP CONSTRAINT "ImportJob_sourceId_archiveId_fkey",
  ADD CONSTRAINT "ImportJob_sourceId_archiveId_ownedAccountId_fkey"
  FOREIGN KEY ("sourceId", "archiveId", "ownedAccountId") REFERENCES "Source"("id", "archiveId", "ownedAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImportJob"
  DROP CONSTRAINT "ImportJob_snapshotId_archiveId_fkey",
  ADD CONSTRAINT "ImportJob_snapshotId_archiveId_ownedAccountId_fkey"
  FOREIGN KEY ("snapshotId", "archiveId", "ownedAccountId") REFERENCES "Snapshot"("id", "archiveId", "ownedAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;
