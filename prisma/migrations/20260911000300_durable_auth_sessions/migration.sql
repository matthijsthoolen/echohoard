CREATE TABLE "AuthSession" (
  "id" UUID NOT NULL,
  "tokenHash" VARCHAR(64) NOT NULL,
  "userId" UUID NOT NULL,
  "archiveId" UUID NOT NULL,
  "issuer" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "role" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuthSession_tokenHash_key" ON "AuthSession"("tokenHash");
CREATE INDEX "AuthSession_expiresAt_revokedAt_idx" ON "AuthSession"("expiresAt", "revokedAt");
CREATE INDEX "AuthSession_archiveId_expiresAt_idx" ON "AuthSession"("archiveId", "expiresAt");
ALTER TABLE "AuthSession"
  ADD CONSTRAINT "AuthSession_archiveId_fkey"
  FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE;
