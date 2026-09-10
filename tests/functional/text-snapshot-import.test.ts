import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaTextSnapshotImporter } from "../../src/infrastructure/db/text-import.js";
import type { ImportRecord } from "../../src/application/text-import.js";

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
  await prisma.source.create({
    data: {
      id: sourceId,
      archiveId,
      kind: "whatsapp",
      stableKey: "android",
      sha256: "a".repeat(64),
    },
  });
  await prisma.snapshot.create({
    data: { id: snapshotId, archiveId, sourceId, sha256: "b".repeat(64) },
  });
  await prisma.importJob.create({
    data: { id: jobId, archiveId, sourceId, snapshotId, status: "queued" },
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
    await prisma.snapshot.create({
      data: {
        id: missingSnapshot,
        archiveId: archiveTwoId,
        sourceId: sourceTwoId,
        sha256: "c".repeat(64),
      },
    });
    await prisma.importJob.create({
      data: {
        id: missingJob,
        archiveId: archiveTwoId,
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

  it("keeps identical normalized keys isolated between archives", async () => {
    expect(await prisma.message.count({ where: { archiveId: archiveOneId } })).toBe(1);
    expect(await prisma.message.count({ where: { archiveId: archiveTwoId } })).toBe(1);
    expect(await prisma.person.count({ where: { archiveId: archiveOneId } })).toBe(1);
    expect(await prisma.person.count({ where: { archiveId: archiveTwoId } })).toBe(1);
  });
});
