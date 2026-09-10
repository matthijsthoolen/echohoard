import { Prisma, PrismaClient } from "@prisma/client";
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
const conversationOneId = randomUUID();
const conversationTwoId = randomUUID();
const archiveTwoConversationId = randomUUID();
const aliceId = randomUUID();
const bobId = randomUUID();
const imageId = randomUUID();
const documentId = randomUUID();
const service = new ArchiveReadService(
  new PrismaReadPersistence(prisma),
  new CursorCodec("functional-filtered-search-secret"),
);

describe("PostgreSQL combinatorial filtered search", () => {
  beforeAll(async () => {
    await prisma.$connect();
    await prisma.$executeRaw`
      INSERT INTO "User" (id, "updatedAt") VALUES (${userId}::uuid, now())
    `;
    await prisma.$executeRaw`
      INSERT INTO "Archive" (id, "userId", name, "updatedAt") VALUES
        (${archiveOneId}::uuid, ${userId}::uuid, 'filter-one', now()),
        (${archiveTwoId}::uuid, ${userId}::uuid, 'filter-two', now())
    `;
    await prisma.$executeRaw`
      INSERT INTO "Conversation" (id, "archiveId", kind, "stableKey", title, "updatedAt") VALUES
        (${conversationOneId}::uuid, ${archiveOneId}::uuid, 'direct', 'filter-one', 'Alice chat', now()),
        (${conversationTwoId}::uuid, ${archiveOneId}::uuid, 'group', 'filter-two', 'Bob group', now()),
        (${archiveTwoConversationId}::uuid, ${archiveTwoId}::uuid, 'direct', 'filter-two-private', 'Private chat', now())
    `;
    await prisma.$executeRaw`
      INSERT INTO "Person" (id, "archiveId", "displayName", "updatedAt") VALUES
        (${aliceId}::uuid, ${archiveOneId}::uuid, 'Alice Example', now()),
        (${bobId}::uuid, ${archiveOneId}::uuid, 'Bob Example', now())
    `;
    await prisma.$executeRaw`
      INSERT INTO "Attachment" (id, "archiveId", "stableKey", sha256, "mimeType", "updatedAt") VALUES
        (${imageId}::uuid, ${archiveOneId}::uuid, 'image', repeat('1', 64), 'image/jpeg', now()),
        (${documentId}::uuid, ${archiveOneId}::uuid, 'document', repeat('2', 64), 'application/pdf', now())
    `;
    await prisma.$executeRaw`
      INSERT INTO "Message" (id, "archiveId", "conversationId", "senderId", "stableKey", "messageType", body, metadata, "sentAt", "updatedAt") VALUES
        (${randomUUID()}::uuid, ${archiveOneId}::uuid, ${conversationOneId}::uuid, ${aliceId}::uuid, 'sent-image', 'text', 'needle from Alice', ${JSON.stringify({ direction: "sent" })}::jsonb, '2026-01-01T00:00:00Z', now()),
        (${randomUUID()}::uuid, ${archiveOneId}::uuid, ${conversationOneId}::uuid, ${bobId}::uuid, 'received-document', 'text', 'needle from Bob', ${JSON.stringify({ direction: "received" })}::jsonb, '2026-01-02T00:00:00Z', now()),
        (${randomUUID()}::uuid, ${archiveOneId}::uuid, ${conversationTwoId}::uuid, null, 'unknown-plain', 'text', 'needle unknown', ${JSON.stringify({})}::jsonb, '2026-01-03T00:00:00Z', now()),
        (${randomUUID()}::uuid, ${archiveTwoId}::uuid, ${archiveTwoConversationId}::uuid, null, 'private', 'text', 'needle private', ${JSON.stringify({ direction: "sent" })}::jsonb, '2026-01-01T00:00:00Z', now())
    `;
    const messageIds = await prisma.$queryRaw<Array<{ id: string; stableKey: string }>>`
      SELECT id, "stableKey" FROM "Message" WHERE "archiveId" = ${archiveOneId}::uuid
    `;
    const sentImage = messageIds.find((row) => row.stableKey === "sent-image");
    const receivedDocument = messageIds.find((row) => row.stableKey === "received-document");
    if (!sentImage || !receivedDocument)
      throw new Error("filtered fixture messages were not created");
    await prisma.$executeRaw`
      INSERT INTO "MessageAttachment" (id, "archiveId", "messageId", "attachmentId", "updatedAt") VALUES
        (${randomUUID()}::uuid, ${archiveOneId}::uuid, ${sentImage.id}::uuid, ${imageId}::uuid, now()),
        (${randomUUID()}::uuid, ${archiveOneId}::uuid, ${receivedDocument.id}::uuid, ${documentId}::uuid, now())
    `;
    await prisma.$executeRaw`ANALYZE "Message"`;
    await prisma.$executeRaw`ANALYZE "Person"`;
    await prisma.$executeRaw`ANALYZE "Conversation"`;
  });

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM "User" WHERE id = ${userId}::uuid`;
    await prisma.$disconnect();
  });

  it.each([
    ["conversation", { conversationId: conversationOneId }, 2],
    ["person", { personId: aliceId }, 1],
    ["direction", { senderDirection: "received" as const }, 1],
    ["date range", { from: "2026-01-02T00:00:00Z", to: "2026-01-03T00:00:00Z" }, 1],
    ["image media", { mediaType: "image" as const }, 1],
    ["document media", { mediaType: "document" as const }, 1],
    ["fuzzy name", { fuzzyName: "Alice Exampel" }, 2],
    ["fuzzy text", { fuzzyText: "Alice" }, 1],
  ] as const)("applies the %s filter within the archive", async (_name, filter, expected) => {
    const page = await service.search({ archiveId: archiveOneId, query: "needle", ...filter });
    expect(page.items).toHaveLength(expected);
    const otherArchive = await service.search({
      archiveId: archiveTwoId,
      query: "needle",
      ...filter,
    });
    expect(otherArchive.items).toEqual([]);
  });

  it("composes all filters and treats hostile terms as data", async () => {
    const page = await service.search({
      archiveId: archiveOneId,
      query: "needle",
      conversationId: conversationOneId,
      personId: aliceId,
      senderDirection: "sent",
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-02T00:00:00Z",
      mediaType: "image",
      fuzzyName: "Alice",
      fuzzyText: "needle",
    });
    expect(page.items).toHaveLength(1);
    expect(
      (
        await service.search({
          archiveId: archiveOneId,
          query: "' OR 1=1 --",
          fuzzyName: "' OR 1=1 --",
        })
      ).items,
    ).toEqual([]);
  });

  it("paginates without duplicate rows when adjacent data is inserted", async () => {
    const first = await service.search({ archiveId: archiveOneId, query: "needle", limit: 1 });
    expect(first.nextCursor).toBeDefined();
    await prisma.$executeRaw`
      INSERT INTO "Message" (id, "archiveId", "conversationId", "stableKey", "messageType", body, "sentAt", "updatedAt")
      VALUES (${randomUUID()}::uuid, ${archiveOneId}::uuid, ${conversationOneId}::uuid, 'after-cursor', 'text', 'needle after cursor', '2026-02-01T00:00:00Z', now())
    `;
    const second = await service.search({
      archiveId: archiveOneId,
      query: "needle",
      limit: 10,
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.id)).not.toContain(first.items[0]?.id);
  });

  it("proves the migration-managed trigram indexes are available", async () => {
    const plans = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL enable_seqscan = off`;
      await transaction.$executeRaw`SET LOCAL enable_indexscan = off`;
      const body = await transaction.$queryRaw<Array<{ "QUERY PLAN": string }>>(Prisma.sql`
        EXPLAIN (COSTS OFF)
        SELECT id FROM "Message"
        WHERE body % ${"unique-trigram-never-present"}
      `);
      const name = await transaction.$queryRaw<Array<{ "QUERY PLAN": string }>>(Prisma.sql`
        EXPLAIN (COSTS OFF)
        SELECT id FROM "Person"
        WHERE "displayName" % ${"unique-name-never-present"}
      `);
      return { body, name };
    });
    expect(plans.body.map((line) => line["QUERY PLAN"]).join("\n")).toContain(
      "Message_body_trgm_idx",
    );
    expect(plans.name.map((line) => line["QUERY PLAN"]).join("\n")).toContain(
      "Person_displayName_trgm_idx",
    );
  });
});
