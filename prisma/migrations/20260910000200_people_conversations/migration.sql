CREATE TABLE "Person" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "archiveId" UUID NOT NULL,
  "displayName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Identity" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "archiveId" UUID NOT NULL,
  "personId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "displayName" TEXT,
  "provenance" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Identity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Conversation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "archiveId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "stableKey" TEXT NOT NULL,
  "title" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ConversationParticipant" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "archiveId" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "personId" UUID NOT NULL,
  "role" TEXT,
  "joinedAt" TIMESTAMP(3),
  "leftAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConversationParticipant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Person_archiveId_id_key" ON "Person"("archiveId", "id");
CREATE INDEX "Person_archiveId_idx" ON "Person"("archiveId");
CREATE UNIQUE INDEX "Identity_archiveId_id_key" ON "Identity"("archiveId", "id");
CREATE UNIQUE INDEX "Identity_archiveId_kind_value_key" ON "Identity"("archiveId", "kind", "value");
CREATE INDEX "Identity_archiveId_personId_idx" ON "Identity"("archiveId", "personId");
CREATE UNIQUE INDEX "Conversation_archiveId_id_key" ON "Conversation"("archiveId", "id");
CREATE UNIQUE INDEX "Conversation_archiveId_stableKey_key" ON "Conversation"("archiveId", "stableKey");
CREATE INDEX "Conversation_archiveId_kind_idx" ON "Conversation"("archiveId", "kind");
CREATE UNIQUE INDEX "ConversationParticipant_archiveId_id_key" ON "ConversationParticipant"("archiveId", "id");
CREATE UNIQUE INDEX "ConversationParticipant_archiveId_conversationId_personId_key" ON "ConversationParticipant"("archiveId", "conversationId", "personId");
CREATE INDEX "ConversationParticipant_archiveId_personId_idx" ON "ConversationParticipant"("archiveId", "personId");

ALTER TABLE "Person" ADD CONSTRAINT "Person_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Identity" ADD CONSTRAINT "Identity_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Identity" ADD CONSTRAINT "Identity_personId_archiveId_fkey" FOREIGN KEY ("personId", "archiveId") REFERENCES "Person"("id", "archiveId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_conversationId_archiveId_fkey" FOREIGN KEY ("conversationId", "archiveId") REFERENCES "Conversation"("id", "archiveId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_personId_archiveId_fkey" FOREIGN KEY ("personId", "archiveId") REFERENCES "Person"("id", "archiveId") ON DELETE CASCADE ON UPDATE CASCADE;
