-- EHV2-08-04: bounded, recoverable claims keep poison receipts from blocking intake.
ALTER TABLE "LiveEventInbox"
  ADD COLUMN "claimId" UUID,
  ADD COLUMN "claimExpiresAt" TIMESTAMP(3),
  ADD COLUMN "errorClass" VARCHAR(64),
  ADD COLUMN "retryable" BOOLEAN;

CREATE INDEX "LiveEventInbox_claim_idx"
  ON "LiveEventInbox"("status", "claimExpiresAt", "receivedAt");
