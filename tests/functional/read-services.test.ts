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
const hiddenConversationId = randomUUID();
const lockedConversationId = randomUUID();
const hiddenMessageId = randomUUID();
const lockedMessageId = randomUUID();
const deletedMessageId = randomUUID();

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
      `INSERT INTO "Conversation" (id,"archiveId",kind,"stableKey",title,"uiVisibility","createdAt","updatedAt") VALUES ('${hiddenConversationId}','${archiveOneId}','direct','hidden','Hidden chat','hidden','2026-01-03T00:00:00Z',now()),('${lockedConversationId}','${archiveOneId}','direct','locked','Locked chat','locked','2026-01-04T00:00:00Z',now())`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Person" ("archiveId","displayName","updatedAt") VALUES ('${archiveOneId}','Alex',now()),('${archiveOneId}','Alex',now()),('${archiveTwoId}','Alex',now())`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Message" ("archiveId","conversationId","stableKey","messageType",body,"sentAt","updatedAt") VALUES ('${archiveOneId}','${conversationId}','m1','text','one','2026-01-01T00:00:00Z',now()),('${archiveOneId}','${conversationId}','m2','text','two','2026-01-02T00:00:00Z',now())`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Message" (id,"archiveId","conversationId","stableKey","messageType",body,"sentAt","updatedAt") VALUES ('${hiddenMessageId}','${archiveOneId}','${hiddenConversationId}','hidden-message','text','hidden sentinel','2026-01-03T00:00:00Z',now()),('${lockedMessageId}','${archiveOneId}','${lockedConversationId}','locked-message','text','locked sentinel','2026-01-04T00:00:00Z',now())`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Message" (id,"archiveId","conversationId","stableKey","messageType",body,"sourceDeleted","contentUnavailable","sourceDeletedAt","sourceDeletionMetadata","sentAt","updatedAt") VALUES ('${deletedMessageId}','${archiveOneId}','${conversationId}','deleted-message','text','captured before revoke',true,false,'2026-01-05T00:00:00Z','{"kind":"revoke","eventKey":"event-1"}','2026-01-05T00:00:00Z',now())`,
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

  it("returns source deletion state without exposing deletion metadata", async () => {
    const messages = await service.listMessages({
      archiveId: archiveOneId,
      conversationId,
      limit: 10,
    });
    expect(messages.items.find((item) => item.id === deletedMessageId)).toMatchObject({
      text: "captured before revoke",
      sourceDeleted: true,
      contentUnavailable: false,
      sourceDeletedAt: "2026-01-05T00:00:00.000Z",
      sourceDeletionKind: "revoke",
    });
    expect(
      (await service.listMessages({ archiveId: archiveTwoId, conversationId, limit: 10 })).items,
    ).toEqual([]);
  });

  it("filters every ordinary and authorized UI mode without enumerating locked ids", async () => {
    const ordinary = { archiveId: archiveOneId, uiAccess: { mode: "ordinary" as const } };
    const hidden = { archiveId: archiveOneId, uiAccess: { mode: "hidden" as const } };
    const locked = {
      archiveId: archiveOneId,
      uiAccess: { mode: "locked" as const, authorizedConversationIds: [lockedConversationId] },
    };
    expect((await service.listConversations(ordinary)).items.map((item) => item.id)).toEqual([
      conversationId,
    ]);
    expect((await service.listConversations(hidden)).items.map((item) => item.id)).toEqual([
      hiddenConversationId,
    ]);
    expect(
      (await service.listConversations({ archiveId: archiveOneId, uiAccess: { mode: "locked" } }))
        .items,
    ).toEqual([]);
    expect((await service.listConversations(locked)).items.map((item) => item.id)).toEqual([
      lockedConversationId,
    ]);

    expect(
      (await service.listMessages({ ...ordinary, conversationId: hiddenConversationId })).items,
    ).toEqual([]);
    expect(
      (await service.listMessages({ ...hidden, conversationId: hiddenConversationId })).items[0]
        ?.id,
    ).toBe(hiddenMessageId);
    expect(
      (await service.listMessages({ ...ordinary, conversationId: lockedConversationId })).items,
    ).toEqual([]);
    expect(
      (await service.listMessages({ ...locked, conversationId: lockedConversationId })).items[0]
        ?.id,
    ).toBe(lockedMessageId);
    expect((await service.search({ ...ordinary, query: "sentinel" })).items).toEqual([]);
    expect((await service.search({ ...hidden, query: "sentinel" })).items[0]?.id).toBe(
      hiddenMessageId,
    );
    expect((await service.search({ ...locked, query: "sentinel" })).items[0]?.id).toBe(
      lockedMessageId,
    );
    expect(
      (await service.listTimeline(ordinary)).items.every((item) => item.id !== hiddenMessageId),
    ).toBe(true);
  });
});
