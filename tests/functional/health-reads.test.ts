import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArchiveHealthService } from "../../src/application/health-reads.js";
import { PrismaHealthReadPersistence } from "../../src/infrastructure/db/prisma-persistence.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const userId = randomUUID();
const archiveOneId = randomUUID();
const archiveTwoId = randomUUID();
const sourceId = randomUUID();
const snapshotId = randomUUID();
const conversationId = randomUUID();
const personId = randomUUID();
const messageId = randomUUID();
const attachmentMissingId = randomUUID();
const attachmentAvailableId = randomUUID();
const jobId = randomUUID();

describe("PostgreSQL archive health reads", () => {
  const service = new ArchiveHealthService(new PrismaHealthReadPersistence(prisma), {
    now: () => new Date("2026-09-10T12:00:00.000Z"),
  });

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.user.create({ data: { id: userId } });
    await prisma.archive.createMany({
      data: [
        { id: archiveOneId, userId, name: "health-one" },
        { id: archiveTwoId, userId, name: "health-two" },
      ],
    });
    await prisma.source.create({
      data: {
        id: sourceId,
        archiveId: archiveOneId,
        kind: "whatsapp",
        stableKey: "health-source",
        sha256: "a".repeat(64),
      },
    });
    await prisma.snapshot.create({
      data: {
        id: snapshotId,
        archiveId: archiveOneId,
        sourceId,
        sha256: "b".repeat(64),
        lifecycle: "completed",
        capturedAt: new Date("2026-09-10T10:00:00.000Z"),
        completedAt: new Date("2026-09-10T11:00:00.000Z"),
      },
    });
    await prisma.importJob.create({
      data: {
        id: jobId,
        archiveId: archiveOneId,
        sourceId,
        snapshotId,
        status: "completed",
        startedAt: new Date("2026-09-10T10:01:00.000Z"),
        finishedAt: new Date("2026-09-10T11:00:00.000Z"),
        createdAt: new Date("2026-09-10T10:00:00.000Z"),
      },
    });
    await prisma.conversation.create({
      data: {
        id: conversationId,
        archiveId: archiveOneId,
        kind: "direct",
        stableKey: "health-conversation",
        title: "Synthetic conversation",
      },
    });
    await prisma.person.create({
      data: { id: personId, archiveId: archiveOneId, displayName: "Synthetic person" },
    });
    await prisma.message.create({
      data: {
        id: messageId,
        archiveId: archiveOneId,
        conversationId,
        senderId: personId,
        stableKey: "health-message",
        messageType: "unsupported",
        body: "synthetic body must not be returned by health",
        metadata: { unsupportedTypeCode: 999 },
        sentAt: new Date("2026-09-10T11:30:00.000Z"),
      },
    });
    await prisma.attachment.createMany({
      data: [
        {
          id: attachmentMissingId,
          archiveId: archiveOneId,
          stableKey: "health-missing",
          sha256: "c".repeat(64),
          availability: "missing",
        },
        {
          id: attachmentAvailableId,
          archiveId: archiveOneId,
          stableKey: "health-available",
          sha256: "d".repeat(64),
          availability: "available",
        },
      ],
    });
    await prisma.messageAttachment.createMany({
      data: [
        { archiveId: archiveOneId, messageId, attachmentId: attachmentMissingId },
        { archiveId: archiveOneId, messageId, attachmentId: attachmentAvailableId },
      ],
    });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("reconciles finalized snapshot, latest message, jobs, counts, media, and unsupported type", async () => {
    const result = await service.getArchiveHealth({ archiveId: archiveOneId });
    expect(result.state).toBe("unsupported");
    expect(result.snapshots.latestCompleted?.id).toBe(snapshotId);
    expect(result.latestMessageAt).toBe("2026-09-10T11:30:00.000Z");
    expect(result.lastJob).toMatchObject({ id: jobId, status: "completed" });
    expect(result.counts).toMatchObject({
      messages: 1,
      conversations: 1,
      people: 1,
      mediaReferenced: 2,
      mediaAvailable: 1,
      unsupported: 1,
    });
    expect(result.media).toMatchObject({ referenced: 2, available: 1, missing: 1 });
    expect(result.unsupportedTypes).toEqual([{ type: "999", count: 1 }]);
    expect(JSON.stringify(result)).not.toContain("synthetic body");
  });

  it("returns no information for the other archive", async () => {
    const result = await service.getArchiveHealth({ archiveId: archiveTwoId });
    expect(result.state).toBe("empty");
    expect(result.snapshots).toEqual({});
    expect(result.jobs).toEqual([]);
    expect(result.counts).toMatchObject({
      messages: 0,
      conversations: 0,
      people: 0,
      mediaReferenced: 0,
      unsupported: 0,
    });
    expect(JSON.stringify(result)).not.toContain(archiveOneId);
  });
});
