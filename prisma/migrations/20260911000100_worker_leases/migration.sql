ALTER TABLE "ImportJob"
  ADD COLUMN "retryable" BOOLEAN,
  ADD COLUMN "leaseId" TEXT,
  ADD COLUMN "leaseOwner" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

CREATE INDEX "ImportJob_status_leaseExpiresAt_idx"
  ON "ImportJob"("status", "leaseExpiresAt");
