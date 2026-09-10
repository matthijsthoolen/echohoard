import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const [userId, archiveOneId, archiveTwoId, personOneId, personTwoId, conversationOneId] =
  Array.from({ length: 6 }, () => randomUUID());

describe("people and conversation ownership constraints", () => {
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
      `INSERT INTO "Conversation" (id,"archiveId",kind,"stableKey","updatedAt") VALUES ('${conversationOneId}','${archiveOneId}','direct','alex',now())`,
    );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id='${userId}'`);
    await prisma.$disconnect();
  });

  it("keeps identities archive-scoped while allowing exact links", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Identity" ("archiveId","personId",kind,value,"updatedAt") VALUES ('${archiveOneId}','${personOneId}','phone','+311',now())`,
      ),
    ).resolves.toBe(1);
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Identity" ("archiveId","personId",kind,value,"updatedAt") VALUES ('${archiveOneId}','${personOneId}','phone','+311',now())`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Identity" ("archiveId","personId",kind,value,"updatedAt") VALUES ('${archiveTwoId}','${personTwoId}','phone','+311',now())`,
      ),
    ).resolves.toBe(1);
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Identity" ("archiveId","personId",kind,value,"updatedAt") VALUES ('${archiveTwoId}','${personOneId}','phone','+312',now())`,
      ),
    ).rejects.toThrow();
  });

  it("enforces archive-scoped conversation keys and membership", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Conversation" ("archiveId",kind,"stableKey","updatedAt") VALUES ('${archiveOneId}','group','alex',now())`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Conversation" ("archiveId",kind,"stableKey","updatedAt") VALUES ('${archiveTwoId}','direct','alex',now())`,
      ),
    ).resolves.toBe(1);
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "ConversationParticipant" ("archiveId","conversationId","personId","updatedAt") VALUES ('${archiveOneId}','${conversationOneId}','${personOneId}',now())`,
      ),
    ).resolves.toBe(1);
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "ConversationParticipant" ("archiveId","conversationId","personId","updatedAt") VALUES ('${archiveTwoId}','${conversationOneId}','${personTwoId}',now())`,
      ),
    ).rejects.toThrow();
  });
});
