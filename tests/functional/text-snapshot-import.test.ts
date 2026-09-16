import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaTextSnapshotImporter } from "../../src/infrastructure/db/text-import.js";
import type { ImportRecord } from "../../src/application/text-import.js";
import { createFixtureOwnedAccount } from "./owned-account-fixture.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const importer = new PrismaTextSnapshotImporter(prisma);
const userId = randomUUID();
const archiveOneId = randomUUID();
const archiveTwoId = randomUUID();
const sourceOneId = randomUUID();
const sourceTwoId = randomUUID();
const snapshotOneId = randomUUID();
const snapshotTwoId = randomUUID();
const jobOneId = randomUUID();
const jobTwoId = randomUUID();
const observedAt = new Date("2026-01-01T00:00:00.000Z");
const personKey = "whatsapp:person:alice";
const identityKey = "whatsapp:identity:alice";
const conversationKey = "whatsapp:conversation:chat";
const messageKey = "whatsapp:message:hello";

const records: readonly ImportRecord[] = [
  { kind: "person", stableKey: personKey, displayName: "Alice" },
  {
    kind: "identity",
    stableKey: identityKey,
    personKey,
    source: { namespace: "whatsapp-android", value: "alice@example" },
  },
  { kind: "conversation", stableKey: conversationKey, conversationKind: "direct", title: "Alice" },
  { kind: "participant", conversationKey, identityKey, role: "member" },
  {
    kind: "message",
    stableKey: messageKey,
    source: { namespace: "whatsapp-android", value: "source-message-1" },
    conversationKey,
    senderIdentityKey: identityKey,
    timestamp: observedAt.toISOString(),
    direction: "received",
    messageKind: "text",
    body: "hello",
    bodyState: "present",
  },
  {
    kind: "revision",
    stableKey: "whatsapp:revision:hello:1",
    messageKey,
    revisionOrdinal: 1,
    body: "hello",
    bodyState: "present",
    firstSeenSnapshotId: snapshotOneId,
  },
];

async function seedArchive(archiveId: string, sourceId: string, snapshotId: string, jobId: string) {
  await prisma.archive.create({ data: { id: archiveId, userId, name: archiveId } });
  const ownedAccountId = await createFixtureOwnedAccount(prisma, archiveId);
  await prisma.source.create({
    data: {
      id: sourceId,
      archiveId,
      ownedAccountId,
      kind: "whatsapp",
      stableKey: "android",
      sha256: "a".repeat(64),
    },
  });
  await prisma.snapshot.create({
    data: { id: snapshotId, archiveId, ownedAccountId, sourceId, sha256: "b".repeat(64) },
  });
  await prisma.importJob.create({
    data: { id: jobId, archiveId, ownedAccountId, sourceId, snapshotId, status: "queued" },
  });
}

describe("transactional normalized text snapshot import", () => {
  beforeAll(async () => {
    await prisma.$connect();
    await prisma.user.create({ data: { id: userId } });
    await seedArchive(archiveOneId, sourceOneId, snapshotOneId, jobOneId);
    await seedArchive(archiveTwoId, sourceTwoId, snapshotTwoId, jobTwoId);
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("imports relationships and provenance, then converges on retry", async () => {
    await importer.import({
      archiveId: archiveOneId,
      snapshotId: snapshotOneId,
      importJobId: jobOneId,
      observedAt,
      records,
    });
    await importer.import({
      archiveId: archiveOneId,
      snapshotId: snapshotOneId,
      importJobId: jobOneId,
      observedAt,
      records,
    });
    expect(await prisma.person.count({ where: { archiveId: archiveOneId } })).toBe(1);
    expect(await prisma.identity.count({ where: { archiveId: archiveOneId } })).toBe(1);
    expect(await prisma.conversationParticipant.count({ where: { archiveId: archiveOneId } })).toBe(
      1,
    );
    expect(await prisma.message.count({ where: { archiveId: archiveOneId } })).toBe(1);
    expect(await prisma.messageRevision.count({ where: { archiveId: archiveOneId } })).toBe(1);
    expect(await prisma.messageObservation.count({ where: { archiveId: archiveOneId } })).toBe(1);
    expect(await prisma.conversationObservation.count({ where: { archiveId: archiveOneId } })).toBe(
      1,
    );
    const message = await prisma.message.findFirstOrThrow({ where: { archiveId: archiveOneId } });
    expect(message.firstSeenAt.toISOString()).toBe(observedAt.toISOString());
    expect(message.lastSeenAt.toISOString()).toBe(observedAt.toISOString());
    expect((message.metadata as { firstSeenSnapshotId: string }).firstSeenSnapshotId).toBe(
      snapshotOneId,
    );
    expect(
      (await prisma.snapshot.findUniqueOrThrow({ where: { id: snapshotOneId } })).lifecycle,
    ).toBe("completed");
    expect((await prisma.importJob.findUniqueOrThrow({ where: { id: jobOneId } })).status).toBe(
      "completed",
    );
  });

  it("rolls back rows when finalization fails, allowing a clean retry", async () => {
    const missingSnapshot = randomUUID();
    const missingJob = randomUUID();
    const accountTwo = await prisma.ownedAccount.findFirstOrThrow({
      where: { archiveId: archiveTwoId },
    });
    await expect(
      importer.import({
        archiveId: archiveTwoId,
        snapshotId: missingSnapshot,
        importJobId: missingJob,
        observedAt,
        records,
      }),
    ).rejects.toThrow();
    expect(await prisma.message.count({ where: { archiveId: archiveTwoId } })).toBe(0);
    expect(await prisma.messageObservation.count({ where: { archiveId: archiveTwoId } })).toBe(0);
    await prisma.snapshot.create({
      data: {
        id: missingSnapshot,
        archiveId: archiveTwoId,
        ownedAccountId: accountTwo.id,
        sourceId: sourceTwoId,
        sha256: "c".repeat(64),
      },
    });
    await prisma.importJob.create({
      data: {
        id: missingJob,
        archiveId: archiveTwoId,
        ownedAccountId: accountTwo.id,
        sourceId: sourceTwoId,
        snapshotId: missingSnapshot,
        status: "queued",
      },
    });
    await importer.import({
      archiveId: archiveTwoId,
      snapshotId: missingSnapshot,
      importJobId: missingJob,
      observedAt,
      records,
    });
    expect(await prisma.message.count({ where: { archiveId: archiveTwoId } })).toBe(1);
  });

  it("keeps the same source chat and message separate for another owned account", async () => {
    const accountId = await createFixtureOwnedAccount(
      prisma,
      archiveOneId,
      `second-${randomUUID()}`,
    );
    const sourceId = randomUUID();
    const snapshotId = randomUUID();
    const jobId = randomUUID();
    await prisma.source.create({
      data: {
        id: sourceId,
        archiveId: archiveOneId,
        ownedAccountId: accountId,
        kind: "whatsapp",
        stableKey: `second-${sourceId}`,
        sha256: "d".repeat(64),
      },
    });
    await prisma.snapshot.create({
      data: {
        id: snapshotId,
        archiveId: archiveOneId,
        ownedAccountId: accountId,
        sourceId,
        sha256: "e".repeat(64),
      },
    });
    await prisma.importJob.create({
      data: {
        id: jobId,
        archiveId: archiveOneId,
        ownedAccountId: accountId,
        sourceId,
        snapshotId,
        status: "queued",
      },
    });
    await importer.import({
      archiveId: archiveOneId,
      ownedAccountId: accountId,
      snapshotId,
      importJobId: jobId,
      observedAt,
      records,
    });
    expect(await prisma.sourceConversation.count({ where: { archiveId: archiveOneId } })).toBe(2);
    expect(await prisma.conversation.count({ where: { archiveId: archiveOneId } })).toBe(2);
    expect(await prisma.message.count({ where: { archiveId: archiveOneId } })).toBe(2);
    expect(await prisma.messageObservation.count({ where: { archiveId: archiveOneId } })).toBe(2);
  });

  it("preserves revoke tombstones across before/after-content order", async () => {
    const tombstoneMessageKey = "whatsapp:message:revoke-before";
    const account = await prisma.ownedAccount.findFirstOrThrow({
      where: { archiveId: archiveOneId },
    });
    const sourceId = randomUUID();
    const snapshotId = randomUUID();
    const jobId = randomUUID();
    await prisma.source.create({
      data: {
        id: sourceId,
        archiveId: archiveOneId,
        ownedAccountId: account.id,
        kind: "live",
        stableKey: `live-${sourceId}`,
        sha256: "f".repeat(64),
      },
    });
    await prisma.snapshot.create({
      data: {
        id: snapshotId,
        archiveId: archiveOneId,
        ownedAccountId: account.id,
        sourceId,
        sha256: "e".repeat(64),
      },
    });
    await prisma.importJob.create({
      data: {
        id: jobId,
        archiveId: archiveOneId,
        ownedAccountId: account.id,
        sourceId,
        snapshotId,
        status: "queued",
      },
    });
    const tombstone: ImportRecord = {
      kind: "message",
      stableKey: tombstoneMessageKey,
      source: { namespace: "whatsapp-android", value: "source-revoke-before" },
      conversationKey,
      timestamp: observedAt.toISOString(),
      direction: "received",
      messageKind: "text",
      bodyState: "missing",
      sourceDeletion: {
        kind: "revoke",
        eventKey: "synthetic-revoke-1",
        observedAt: observedAt.toISOString(),
      },
    };
    await importer.import({
      archiveId: archiveOneId,
      ownedAccountId: account.id,
      snapshotId,
      importJobId: jobId,
      observedAt,
      records: [
        { kind: "conversation", stableKey: conversationKey, conversationKind: "direct" },
        tombstone,
      ],
    });
    await expect(
      prisma.message.findFirstOrThrow({
        where: { archiveId: archiveOneId, stableKey: tombstoneMessageKey },
      }),
    ).resolves.toMatchObject({
      body: null,
      sourceDeleted: true,
      contentUnavailable: true,
      ownerDeleted: false,
    });
    const laterSnapshot = randomUUID();
    await prisma.snapshot.create({
      data: {
        id: laterSnapshot,
        archiveId: archiveOneId,
        ownedAccountId: account.id,
        sourceId,
        sha256: "d".repeat(64),
      },
    });
    const laterJob = randomUUID();
    await prisma.importJob.create({
      data: {
        id: laterJob,
        archiveId: archiveOneId,
        ownedAccountId: account.id,
        sourceId,
        snapshotId: laterSnapshot,
        status: "queued",
      },
    });
    await importer.import({
      archiveId: archiveOneId,
      ownedAccountId: account.id,
      snapshotId: laterSnapshot,
      importJobId: laterJob,
      observedAt: new Date("2026-01-02T00:00:00.000Z"),
      records: [
        { kind: "conversation", stableKey: conversationKey, conversationKind: "direct" },
        { ...tombstone, body: "hello", bodyState: "present", sourceDeletion: undefined },
      ],
    });
    await expect(
      prisma.message.findFirstOrThrow({
        where: { archiveId: archiveOneId, stableKey: tombstoneMessageKey },
      }),
    ).resolves.toMatchObject({
      body: "hello",
      sourceDeleted: true,
      contentUnavailable: false,
      ownerDeleted: false,
    });
    expect(
      await prisma.messageObservation.count({
        where: {
          archiveId: archiveOneId,
          messageId: (
            await prisma.message.findFirstOrThrow({
              where: { archiveId: archiveOneId, stableKey: tombstoneMessageKey },
            })
          ).id,
        },
      }),
    ).toBe(2);
  });

  it("keeps identical normalized keys isolated between archives", async () => {
    expect(await prisma.message.count({ where: { archiveId: archiveOneId } })).toBe(3);
    expect(await prisma.message.count({ where: { archiveId: archiveTwoId } })).toBe(1);
    expect(await prisma.person.count({ where: { archiveId: archiveOneId } })).toBe(1);
    expect(await prisma.person.count({ where: { archiveId: archiveTwoId } })).toBe(1);
  });

  it("imports a 5k-message synthetic stream in one bounded transaction", async () => {
    const account = await prisma.ownedAccount.findFirstOrThrow({
      where: { archiveId: archiveTwoId },
    });
    const sourceId = randomUUID();
    const snapshotId = randomUUID();
    const importJobId = randomUUID();
    await prisma.source.create({
      data: {
        id: sourceId,
        archiveId: archiveTwoId,
        ownedAccountId: account.id,
        kind: "whatsapp",
        stableKey: `scale-${sourceId}`,
        sha256: "f".repeat(64),
      },
    });
    await prisma.snapshot.create({
      data: {
        id: snapshotId,
        archiveId: archiveTwoId,
        ownedAccountId: account.id,
        sourceId,
        sha256: "0".repeat(64),
      },
    });
    await prisma.importJob.create({
      data: {
        id: importJobId,
        archiveId: archiveTwoId,
        ownedAccountId: account.id,
        sourceId,
        snapshotId,
        status: "queued",
      },
    });
    let sourcePasses = 0;
    const started = performance.now();
    const beforeHeap = process.memoryUsage().heapUsed;
    const result = await importer.import({
      archiveId: archiveTwoId,
      ownedAccountId: account.id,
      snapshotId,
      importJobId,
      observedAt,
      records: syntheticMessageStream(5_000, () => (sourcePasses += 1)),
    });
    const elapsedMilliseconds = performance.now() - started;
    const heapDelta = process.memoryUsage().heapUsed - beforeHeap;
    expect(result.imported).toBe(5_001);
    expect(sourcePasses).toBe(1);
    expect(elapsedMilliseconds).toBeLessThan(30_000);
    expect(heapDelta).toBeLessThan(128 * 1024 * 1024);
    await expect(
      prisma.importJob.findUnique({ where: { id: importJobId } }),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      prisma.message.count({
        where: { archiveId: archiveTwoId, stableKey: { startsWith: "scale-message-" } },
      }),
    ).resolves.toBe(5_000);
  }, 45_000);
});

function syntheticMessageStream(
  count: number,
  onStart: () => void,
): AsyncIterable<readonly ImportRecord[]> {
  return {
    [Symbol.asyncIterator]: async function* () {
      onStart();
      yield [{ kind: "conversation", stableKey: "scale-conversation", conversationKind: "direct" }];
      for (let offset = 0; offset < count; offset += 250) {
        const batch: ImportRecord[] = [];
        for (let n = offset; n < Math.min(offset + 250, count); n++)
          batch.push({
            kind: "message",
            stableKey: `scale-message-${n}`,
            source: { namespace: "synthetic", value: `scale-source-${n}` },
            conversationKey: "scale-conversation",
            timestamp: observedAt.toISOString(),
            direction: n % 2 === 0 ? "sent" : "received",
            messageKind: "text",
            body: `synthetic scale message ${n}`,
            bodyState: "present",
          });
        yield batch;
      }
    },
  };
}
