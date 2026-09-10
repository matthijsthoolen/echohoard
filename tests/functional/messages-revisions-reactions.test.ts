import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const [
  userId,
  archiveOneId,
  archiveTwoId,
  personOneId,
  personTwoId,
  conversationOneId,
  conversationTwoId,
  messageOneId,
  messageTwoId,
] = Array.from({ length: 9 }, () => randomUUID());

describe("message, revision, and reaction ownership constraints", () => {
  beforeAll(async () => {
    await prisma.$connect();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "User" (id, "updatedAt") VALUES ('${userId}', now())`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Archive" (id, "userId", name, "updatedAt") VALUES ('${archiveOneId}','${userId}','one',now()),('${archiveTwoId}','${userId}','two',now())`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Person" (id,"archiveId","displayName","updatedAt") VALUES ('${personOneId}','${archiveOneId}','Alex',now()),('${personTwoId}','${archiveTwoId}','Alex',now())`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Conversation" (id,"archiveId",kind,"stableKey","updatedAt") VALUES ('${conversationOneId}','${archiveOneId}','direct','one',now()),('${conversationTwoId}','${archiveTwoId}','direct','one',now())`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Message" (id,"archiveId","conversationId","senderId","stableKey","messageType",body,"updatedAt") VALUES ('${messageOneId}','${archiveOneId}','${conversationOneId}','${personOneId}','m-1','text','hello',now()),('${messageTwoId}','${archiveTwoId}','${conversationTwoId}','${personTwoId}','m-1','text','hello',now())`,
    );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id='${userId}'`);
    await prisma.$disconnect();
  });

  it("preserves stable messages and append-only revisions", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Message" ("archiveId","conversationId","senderId","stableKey","messageType","updatedAt") VALUES ('${archiveOneId}','${conversationOneId}','${personOneId}','m-1','text',now())`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "MessageRevision" ("archiveId","messageId","revisionKey",body,"updatedAt") VALUES ('${archiveOneId}','${messageOneId}','r-1','edited',now())`,
      ),
    ).resolves.toBe(1);
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "MessageRevision" ("archiveId","messageId","revisionKey",body,"updatedAt") VALUES ('${archiveOneId}','${messageOneId}','r-1','edited again',now())`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "MessageRevision" ("archiveId","messageId","revisionKey",body,"updatedAt") VALUES ('${archiveTwoId}','${messageOneId}','r-2','wrong archive',now())`,
      ),
    ).rejects.toThrow();
  });

  it("rejects cross-conversation replies and scopes reaction identity", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Message" ("archiveId","conversationId","senderId","replyToId","stableKey","messageType","updatedAt") VALUES ('${archiveOneId}','${conversationOneId}','${personOneId}','${messageTwoId}','m-cross','text',now())`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Reaction" ("archiveId","messageId","personId",emoji,"stableKey","updatedAt") VALUES ('${archiveOneId}','${messageOneId}','${personOneId}','👍','r-1',now())`,
      ),
    ).resolves.toBe(1);
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Reaction" ("archiveId","messageId","personId",emoji,"stableKey","updatedAt") VALUES ('${archiveOneId}','${messageOneId}','${personOneId}','👍','r-1',now())`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Reaction" ("archiveId","messageId","personId",emoji,"stableKey","updatedAt") VALUES ('${archiveTwoId}','${messageOneId}','${personTwoId}','👍','r-2',now())`,
      ),
    ).rejects.toThrow();
  });
});
