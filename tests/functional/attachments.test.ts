import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const [userId, archiveOneId, archiveTwoId, conversationId, messageId, secondMessageId] = Array.from(
  { length: 6 },
  () => randomUUID(),
);

describe("attachment ownership constraints", () => {
  beforeAll(async () => {
    await prisma.$connect();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "User" (id, "updatedAt") VALUES ('${userId}', now())`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Archive" (id, "userId", name, "updatedAt") VALUES ('${archiveOneId}','${userId}','one',now()),('${archiveTwoId}','${userId}','two',now())`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Conversation" (id,"archiveId",kind,"stableKey","updatedAt") VALUES ('${conversationId}','${archiveOneId}','direct','one',now())`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Message" (id,"archiveId","conversationId","stableKey","messageType","updatedAt") VALUES ('${messageId}','${archiveOneId}','${conversationId}','m-1','text',now()),('${secondMessageId}','${archiveOneId}','${conversationId}','m-2','text',now())`,
    );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id='${userId}'`);
    await prisma.$disconnect();
  });

  it("deduplicates hashes per archive and allows missing media", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Attachment" ("archiveId",sha256,availability,"updatedAt") VALUES ('${archiveOneId}','${"a".repeat(64)}','missing',now())`,
      ),
    ).resolves.toBe(1);
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Attachment" ("archiveId",sha256,availability,"updatedAt") VALUES ('${archiveOneId}','${"a".repeat(64)}','available',now())`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Attachment" ("archiveId",sha256,availability,"updatedAt") VALUES ('${archiveTwoId}','${"a".repeat(64)}','missing',now())`,
      ),
    ).resolves.toBe(1);
  });

  it("retains multiple message links and rejects cross-archive links", async () => {
    const [{ id: attachmentId }] = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM "Attachment" WHERE "archiveId"='${archiveOneId}' LIMIT 1`,
    );
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "MessageAttachment" ("archiveId","messageId","attachmentId",ordinal,"updatedAt") VALUES ('${archiveOneId}','${messageId}','${attachmentId}',0,now())`,
      ),
    ).resolves.toBe(1);
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "MessageAttachment" ("archiveId","messageId","attachmentId",ordinal,"updatedAt") VALUES ('${archiveOneId}','${secondMessageId}','${attachmentId}',1,now())`,
      ),
    ).resolves.toBe(1);
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "MessageAttachment" ("archiveId","messageId","attachmentId",ordinal,"updatedAt") VALUES ('${archiveTwoId}','${messageId}','${attachmentId}',0,now())`,
      ),
    ).rejects.toThrow();
  });
});
