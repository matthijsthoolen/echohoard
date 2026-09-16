-- EHV2-01-07: owner-controlled live account settings. No sidecar keys or QR
-- material is persisted here; pairing material is process-local and ephemeral.
ALTER TABLE "OwnedAccount"
  ADD COLUMN "liveEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pairedAt" TIMESTAMP(3),
  ADD COLUMN "pausedAt" TIMESTAMP(3);
