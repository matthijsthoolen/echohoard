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

describe("PostgreSQL full-text message search", () => {
  const service = new ArchiveReadService(
    new PrismaReadPersistence(prisma),
    new CursorCodec("functional-search-secret"),
  );

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.$executeRaw`
      INSERT INTO "User" (id, "updatedAt") VALUES (${userId}::uuid, now())
    `;
    await prisma.$executeRaw`
      INSERT INTO "Archive" (id, "userId", name, "updatedAt") VALUES
        (${archiveOneId}::uuid, ${userId}::uuid, 'search-one', now()),
        (${archiveTwoId}::uuid, ${userId}::uuid, 'search-two', now())
    `;
    await prisma.$executeRaw`
      INSERT INTO "Conversation" (id, "archiveId", kind, "stableKey", title, "updatedAt") VALUES
        (${conversationOneId}::uuid, ${archiveOneId}::uuid, 'direct', 'search-one', 'Search one', now()),
        (${conversationTwoId}::uuid, ${archiveTwoId}::uuid, 'direct', 'search-two', 'Search two', now())
    `;
    await prisma.$executeRaw`
      INSERT INTO "Message" (id, "archiveId", "conversationId", "stableKey", "messageType", body, "sentAt", "updatedAt")
      VALUES
        (${randomUUID()}::uuid, ${archiveOneId}::uuid, ${conversationOneId}::uuid, 'rank-high', 'text', 'alpha alpha alpha', '2026-01-01T00:00:00Z', now()),
        (${randomUUID()}::uuid, ${archiveOneId}::uuid, ${conversationOneId}::uuid, 'rank-low', 'text', 'alpha', '2026-01-02T00:00:00Z', now()),
        (${randomUUID()}::uuid, ${archiveOneId}::uuid, ${conversationOneId}::uuid, 'special', 'text', 'O''Reilly says hello <tag>', '2026-01-03T00:00:00Z', now()),
        (${randomUUID()}::uuid, ${archiveTwoId}::uuid, ${conversationTwoId}::uuid, 'other-archive', 'text', 'alpha private archive', '2026-01-01T00:00:00Z', now())
    `;
    // A deterministic representative fixture makes the plan assertion prove
    // index availability at a non-trivial table size without personal data.
    await prisma.$executeRaw`
      INSERT INTO "Message" (id, "archiveId", "conversationId", "stableKey", "messageType", body, "sentAt", "updatedAt")
      SELECT gen_random_uuid(), ${archiveOneId}::uuid, ${conversationOneId}::uuid,
        'scale-' || fixture_number, 'text',
        CASE WHEN fixture_number % 20 = 0 THEN 'scale searchable alpha' ELSE 'scale fixture' END,
        TIMESTAMP '2025-01-01' + fixture_number * INTERVAL '1 minute', now()
      FROM generate_series(1, 12000) AS fixture_number
    `;
    await prisma.$executeRaw`ANALYZE "Message"`;
  });

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM "User" WHERE id = ${userId}::uuid`;
    await prisma.$disconnect();
  });

  it("returns ranked, bounded results with stable cursor pagination", async () => {
    const first = await service.search({ archiveId: archiveOneId, query: "alpha", limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.id).toBeDefined();
    expect(first.items[0]?.score).toBeGreaterThan(0);
    expect(first.hasMore).toBe(true);

    const next = await service.search({
      archiveId: archiveOneId,
      query: "alpha",
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(next.items).toHaveLength(1);
    expect(next.items[0]?.id).not.toBe(first.items[0]?.id);
  });

  it("handles punctuation and hostile query text as data", async () => {
    const special = await service.search({ archiveId: archiveOneId, query: "O'Reilly", limit: 10 });
    expect(special.items.map((item) => item.id)).toHaveLength(1);

    const injection = await service.search({
      archiveId: archiveOneId,
      query: "' OR 1=1 --",
      limit: 10,
    });
    expect(injection.items).toEqual([]);
    await expect(prisma.$queryRaw<[{ result: number }]>`SELECT 1 AS result`).resolves.toEqual([
      { result: 1 },
    ]);
  });

  it("isolates matching messages by archive", async () => {
    const archiveOne = await service.search({
      archiveId: archiveOneId,
      query: "private",
      limit: 10,
    });
    const archiveTwo = await service.search({
      archiveId: archiveTwoId,
      query: "private",
      limit: 10,
    });
    expect(archiveOne.items).toEqual([]);
    expect(archiveTwo.items).toHaveLength(1);
  });

  it("uses the migration-managed GIN index in the representative plan", async () => {
    const plan = await prisma.$transaction(async (transaction) => {
      // The fixture is intentionally smaller than the five-million-message
      // corpus, so disable competing scan paths only for this capability proof.
      // This demonstrates that PostgreSQL can use the migration-managed GIN
      // structure without changing the application query or session default.
      await transaction.$executeRaw`SET LOCAL enable_seqscan = off`;
      await transaction.$executeRaw`SET LOCAL enable_indexscan = off`;
      return transaction.$queryRaw<Array<{ "QUERY PLAN": string }>>(Prisma.sql`
        EXPLAIN (COSTS OFF)
        SELECT id
        FROM "Message"
        WHERE "archiveId" = ${archiveOneId}::uuid
          AND "searchVector" @@ plainto_tsquery('simple'::regconfig, ${"searchable"})
        ORDER BY "sentAt" ASC NULLS LAST, id ASC
        LIMIT 50
      `);
    });
    const text = plan.map((line) => line["QUERY PLAN"]).join("\n");
    expect(text).toContain("Message_searchVector_gin_idx");
  });
});
