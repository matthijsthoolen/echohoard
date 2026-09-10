CREATE TABLE "Message" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "archiveId" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "senderId" UUID,
  "replyToId" UUID,
  "stableKey" TEXT NOT NULL,
  "sourceType" TEXT,
  "sourceKey" TEXT,
  "messageType" TEXT NOT NULL,
  "body" TEXT,
  "metadata" JSONB,
  "sentAt" TIMESTAMP(3),
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MessageRevision" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "archiveId" UUID NOT NULL,
  "messageId" UUID NOT NULL,
  "revisionKey" TEXT NOT NULL,
  "body" TEXT,
  "metadata" JSONB,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MessageRevision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Reaction" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "archiveId" UUID NOT NULL,
  "messageId" UUID NOT NULL,
  "personId" UUID NOT NULL,
  "emoji" TEXT NOT NULL,
  "stableKey" TEXT NOT NULL,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Reaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Message_archiveId_id_key" ON "Message"("archiveId", "id");
CREATE UNIQUE INDEX "Message_archiveId_conversationId_id_key" ON "Message"("archiveId", "conversationId", "id");
CREATE UNIQUE INDEX "Message_archiveId_stableKey_key" ON "Message"("archiveId", "stableKey");
CREATE INDEX "Message_archiveId_conversationId_sentAt_idx" ON "Message"("archiveId", "conversationId", "sentAt");
CREATE INDEX "Message_archiveId_senderId_idx" ON "Message"("archiveId", "senderId");
CREATE UNIQUE INDEX "MessageRevision_archiveId_id_key" ON "MessageRevision"("archiveId", "id");
CREATE UNIQUE INDEX "MessageRevision_archiveId_messageId_revisionKey_key" ON "MessageRevision"("archiveId", "messageId", "revisionKey");
CREATE INDEX "MessageRevision_archiveId_messageId_firstSeenAt_idx" ON "MessageRevision"("archiveId", "messageId", "firstSeenAt");
CREATE UNIQUE INDEX "Reaction_archiveId_id_key" ON "Reaction"("archiveId", "id");
CREATE UNIQUE INDEX "Reaction_archiveId_messageId_stableKey_key" ON "Reaction"("archiveId", "messageId", "stableKey");
CREATE INDEX "Reaction_archiveId_messageId_idx" ON "Reaction"("archiveId", "messageId");

ALTER TABLE "Message" ADD CONSTRAINT "Message_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_archiveId_fkey" FOREIGN KEY ("conversationId", "archiveId") REFERENCES "Conversation"("id", "archiveId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_archiveId_fkey" FOREIGN KEY ("senderId", "archiveId") REFERENCES "Person"("id", "archiveId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_replyToId_conversationId_archiveId_fkey" FOREIGN KEY ("replyToId", "conversationId", "archiveId") REFERENCES "Message"("id", "conversationId", "archiveId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MessageRevision" ADD CONSTRAINT "MessageRevision_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageRevision" ADD CONSTRAINT "MessageRevision_messageId_archiveId_fkey" FOREIGN KEY ("messageId", "archiveId") REFERENCES "Message"("id", "archiveId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_messageId_archiveId_fkey" FOREIGN KEY ("messageId", "archiveId") REFERENCES "Message"("id", "archiveId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_personId_archiveId_fkey" FOREIGN KEY ("personId", "archiveId") REFERENCES "Person"("id", "archiveId") ON DELETE RESTRICT ON UPDATE CASCADE;
