import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArchiveReadService, CursorCodec } from "../../src/application/reads.js";
import { PrismaReadPersistence } from "../../src/infrastructure/db/prisma-persistence.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const userId = randomUUID();
const archiveOneId = randomUUID();
const archiveTwoId = randomUUID();
const conversationId = randomUUID();

describe("bounded archive read services", () => {
  const service = new ArchiveReadService(
    new PrismaReadPersistence(prisma),
    new CursorCodec("functional-read-secret"),
  );
  beforeAll(async () => {
    await prisma.$connect();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "User" (id,"updatedAt") VALUES ('${userId}',now())`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Archive" (id,"userId",name,"updatedAt") VALUES ('${archiveOneId}','${userId}','read-one',now()),('${archiveTwoId}','${userId}','read-two',now())`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Conversation" (id,"archiveId",kind,"stableKey",title,"createdAt","updatedAt") VALUES ('${conversationId}','${archiveOneId}','direct','stable','Chat','2026-01-01T00:00:00Z',now())`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Person" ("archiveId","displayName","updatedAt") VALUES ('${archiveOneId}','Alex',now()),('${archiveOneId}','Alex',now()),('${archiveTwoId}','Alex',now())`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Message" ("archiveId","conversationId","stableKey","messageType",body,"sentAt","updatedAt") VALUES ('${archiveOneId}','${conversationId}','m1','text','one','2026-01-01T00:00:00Z',now()),('${archiveOneId}','${conversationId}','m2','text','two','2026-01-02T00:00:00Z',now())`,
    );
  });
  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id='${userId}'`);
    await prisma.$disconnect();
  });

  it("paginates conversations and messages deterministically", async () => {
    const conversations = await service.listConversations({ archiveId: archiveOneId, limit: 1 });
    expect(conversations.items.map((item) => item.id)).toEqual([conversationId]);
    const messages = await service.listMessages({
      archiveId: archiveOneId,
      conversationId,
      limit: 1,
    });
    expect(messages.items[0]?.text).toBe("one");
    expect(messages.nextCursor).toBeDefined();
    const next = await service.listMessages({
      archiveId: archiveOneId,
      conversationId,
      limit: 1,
      cursor: messages.nextCursor,
    });
    expect(next.items[0]?.text).toBe("two");
  });

  it("keeps people and messages isolated by archive", async () => {
    expect((await service.listPeople({ archiveId: archiveTwoId })).items).toHaveLength(1);
    expect((await service.listMessages({ archiveId: archiveTwoId, conversationId })).items).toEqual(
      [],
    );
  });
});
