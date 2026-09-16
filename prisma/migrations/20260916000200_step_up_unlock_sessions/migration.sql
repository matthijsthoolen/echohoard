ALTER TABLE "AuthSession"
  ADD CONSTRAINT "AuthSession_id_archiveId_key" UNIQUE ("id", "archiveId");

CREATE TABLE "UnlockChallenge" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tokenHash" VARCHAR(64) NOT NULL,
  "runtimeId" VARCHAR(64) NOT NULL,
  "sessionHash" VARCHAR(64) NOT NULL,
  "authSessionId" UUID NOT NULL,
  "archiveId" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "UnlockChallenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UnlockChallenge_tokenHash_key" ON "UnlockChallenge"("tokenHash");
CREATE UNIQUE INDEX "UnlockChallenge_archiveId_id_key" ON "UnlockChallenge"("archiveId", "id");
CREATE INDEX "UnlockChallenge_runtimeId_expiresAt_consumedAt_revokedAt_idx"
  ON "UnlockChallenge"("runtimeId", "expiresAt", "consumedAt", "revokedAt");
CREATE INDEX "UnlockChallenge_sessionHash_archiveId_conversationId_idx"
  ON "UnlockChallenge"("sessionHash", "archiveId", "conversationId");
ALTER TABLE "UnlockChallenge"
  ADD CONSTRAINT "UnlockChallenge_authSessionId_archiveId_fkey"
    FOREIGN KEY ("authSessionId", "archiveId") REFERENCES "AuthSession"("id", "archiveId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "UnlockChallenge_archiveId_fkey"
    FOREIGN KEY ("archiveId") REFERENCES "Archive"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "UnlockChallenge_conversationId_archiveId_fkey"
    FOREIGN KEY ("conversationId", "archiveId") REFERENCES "Conversation"("id", "archiveId")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "UnlockGrant" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tokenHash" VARCHAR(64) NOT NULL,
  "runtimeId" VARCHAR(64) NOT NULL,
  "sessionHash" VARCHAR(64) NOT NULL,
  "authSessionId" UUID NOT NULL,
  "archiveId" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "UnlockGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UnlockGrant_tokenHash_key" ON "UnlockGrant"("tokenHash");
CREATE UNIQUE INDEX "UnlockGrant_archiveId_id_key" ON "UnlockGrant"("archiveId", "id");
CREATE INDEX "UnlockGrant_runtimeId_expiresAt_revokedAt_idx"
  ON "UnlockGrant"("runtimeId", "expiresAt", "revokedAt");
CREATE INDEX "UnlockGrant_sessionHash_archiveId_conversationId_idx"
  ON "UnlockGrant"("sessionHash", "archiveId", "conversationId");
ALTER TABLE "UnlockGrant"
  ADD CONSTRAINT "UnlockGrant_authSessionId_archiveId_fkey"
    FOREIGN KEY ("authSessionId", "archiveId") REFERENCES "AuthSession"("id", "archiveId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "UnlockGrant_archiveId_fkey"
    FOREIGN KEY ("archiveId") REFERENCES "Archive"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "UnlockGrant_conversationId_archiveId_fkey"
    FOREIGN KEY ("conversationId", "archiveId") REFERENCES "Conversation"("id", "archiveId")
    ON DELETE CASCADE ON UPDATE CASCADE;
