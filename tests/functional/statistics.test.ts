import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArchiveStatisticsService } from "../../src/application/statistics.js";
import { PrismaStatisticsPersistence } from "../../src/infrastructure/db/prisma-persistence.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const service = new ArchiveStatisticsService(new PrismaStatisticsPersistence(prisma));
const userId = randomUUID();
const archiveOneId = randomUUID();
const archiveTwoId = randomUUID();
const emptyArchiveId = randomUUID();
const sourceOneId = randomUUID();
const sourceTwoId = randomUUID();
const finalizedSnapshotId = randomUUID();
const pendingSnapshotId = randomUUID();
const finalizedOtherSnapshotId = randomUUID();
const finalizedJobId = randomUUID();
const pendingJobId = randomUUID();
const finalizedOtherJobId = randomUUID();
const conversationOneId = randomUUID();
const conversationTwoId = randomUUID();
const otherConversationId = randomUUID();
const aliceId = randomUUID();
const bobId = randomUUID();
const otherPersonId = randomUUID();
const imageId = randomUUID();
const documentId = randomUUID();

describe("PostgreSQL archive statistics", () => {
  beforeAll(async () => {
    await prisma.$connect();
    await prisma.user.create({ data: { id: userId } });
    await prisma.archive.createMany({
      data: [
        { id: archiveOneId, userId, name: "statistics-one" },
        { id: archiveTwoId, userId, name: "statistics-two" },
        { id: emptyArchiveId, userId, name: "statistics-empty" },
      ],
    });
    await prisma.source.createMany({
      data: [
        {
          id: sourceOneId,
          archiveId: archiveOneId,
          kind: "whatsapp",
          stableKey: "statistics-source-one",
          sha256: "1".repeat(64),
        },
        {
          id: sourceTwoId,
          archiveId: archiveTwoId,
          kind: "whatsapp",
          stableKey: "statistics-source-two",
          sha256: "2".repeat(64),
        },
      ],
    });
    await prisma.snapshot.createMany({
      data: [
        {
          id: finalizedSnapshotId,
          archiveId: archiveOneId,
          sourceId: sourceOneId,
          sha256: "3".repeat(64),
          lifecycle: "completed",
          capturedAt: new Date("2026-01-01T00:00:00.000Z"),
          completedAt: new Date("2026-01-01T00:05:00.000Z"),
        },
        {
          id: pendingSnapshotId,
          archiveId: archiveOneId,
          sourceId: sourceOneId,
          sha256: "4".repeat(64),
          lifecycle: "ready",
          capturedAt: new Date("2026-01-02T00:00:00.000Z"),
        },
        {
          id: finalizedOtherSnapshotId,
          archiveId: archiveTwoId,
          sourceId: sourceTwoId,
          sha256: "5".repeat(64),
          lifecycle: "completed",
          capturedAt: new Date("2026-01-01T00:00:00.000Z"),
          completedAt: new Date("2026-01-01T00:05:00.000Z"),
        },
      ],
    });
    await prisma.importJob.createMany({
      data: [
        {
          id: finalizedJobId,
          archiveId: archiveOneId,
          sourceId: sourceOneId,
          snapshotId: finalizedSnapshotId,
          status: "completed",
          finishedAt: new Date("2026-01-01T00:05:00.000Z"),
        },
        {
          id: pendingJobId,
          archiveId: archiveOneId,
          sourceId: sourceOneId,
          snapshotId: pendingSnapshotId,
          status: "queued",
        },
        {
          id: finalizedOtherJobId,
          archiveId: archiveTwoId,
          sourceId: sourceTwoId,
          snapshotId: finalizedOtherSnapshotId,
          status: "completed",
          finishedAt: new Date("2026-01-01T00:05:00.000Z"),
        },
      ],
    });
    await prisma.conversation.createMany({
      data: [
        {
          id: conversationOneId,
          archiveId: archiveOneId,
          kind: "direct",
          stableKey: "statistics-chat-one",
          title: "Alice and Bob",
        },
        {
          id: conversationTwoId,
          archiveId: archiveOneId,
          kind: "group",
          stableKey: "statistics-chat-two",
          title: "Unfinalized chat",
        },
        {
          id: otherConversationId,
          archiveId: archiveTwoId,
          kind: "direct",
          stableKey: "statistics-other-chat",
          title: "Other archive",
        },
      ],
    });
    await prisma.person.createMany({
      data: [
        { id: aliceId, archiveId: archiveOneId, displayName: "Alice" },
        { id: bobId, archiveId: archiveOneId, displayName: "Bob" },
        { id: otherPersonId, archiveId: archiveTwoId, displayName: "Other" },
      ],
    });
    await prisma.conversationParticipant.createMany({
      data: [
        {
          archiveId: archiveOneId,
          conversationId: conversationOneId,
          personId: aliceId,
          role: "member",
        },
        {
          archiveId: archiveOneId,
          conversationId: conversationOneId,
          personId: bobId,
          role: "member",
        },
      ],
    });
    await prisma.attachment.createMany({
      data: [
        {
          id: imageId,
          archiveId: archiveOneId,
          stableKey: "statistics-image",
          sha256: "6".repeat(64),
          mimeType: "image/jpeg",
          availability: "available",
        },
        {
          id: documentId,
          archiveId: archiveOneId,
          stableKey: "statistics-document",
          sha256: "7".repeat(64),
          mimeType: "application/pdf",
          availability: "missing",
        },
      ],
    });
    await prisma.message.createMany({
      data: [
        {
          id: randomUUID(),
          archiveId: archiveOneId,
          conversationId: conversationOneId,
          senderId: aliceId,
          stableKey: "statistics-sent",
          messageType: "text",
          metadata: { direction: "sent", lastSeenSnapshotId: finalizedSnapshotId },
          sentAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        {
          id: randomUUID(),
          archiveId: archiveOneId,
          conversationId: conversationOneId,
          senderId: bobId,
          stableKey: "statistics-received-boundary",
          messageType: "text",
          metadata: { direction: "received", lastSeenSnapshotId: finalizedSnapshotId },
          sentAt: new Date("2026-01-02T00:00:00.000Z"),
        },
        {
          id: randomUUID(),
          archiveId: archiveOneId,
          conversationId: conversationTwoId,
          senderId: aliceId,
          stableKey: "statistics-unfinalized",
          messageType: "text",
          metadata: { direction: "sent", lastSeenSnapshotId: pendingSnapshotId },
          sentAt: new Date("2026-01-01T12:00:00.000Z"),
        },
        {
          id: randomUUID(),
          archiveId: archiveTwoId,
          conversationId: otherConversationId,
          senderId: otherPersonId,
          stableKey: "statistics-other",
          messageType: "text",
          metadata: { direction: "received", lastSeenSnapshotId: finalizedOtherSnapshotId },
          sentAt: new Date("2026-01-01T12:00:00.000Z"),
        },
      ],
    });
    const messages = await prisma.message.findMany({
      where: { archiveId: archiveOneId },
      select: { id: true, stableKey: true },
    });
    const sent = messages.find((message) => message.stableKey === "statistics-sent");
    const received = messages.find(
      (message) => message.stableKey === "statistics-received-boundary",
    );
    if (!sent || !received) throw new Error("statistics fixture messages were not created");
    await prisma.messageAttachment.createMany({
      data: [
        { archiveId: archiveOneId, messageId: sent.id, attachmentId: imageId },
        { archiveId: archiveOneId, messageId: received.id, attachmentId: documentId },
      ],
    });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("reconciles finalized totals, media, direction, activity, and top conversations", async () => {
    const result = await service.getStatistics({ archiveId: archiveOneId });
    expect(result.totals).toEqual({ messages: 2, conversations: 1, people: 2, media: 2 });
    expect(result.direction).toEqual({ sent: 1, received: 1, unknown: 0 });
    expect(result.mediaByTypeAndState).toEqual([
      { type: "document", availability: "missing", count: 1 },
      { type: "image", availability: "available", count: 1 },
    ]);
    expect(result.activity).toEqual([
      { bucketStart: "2026-01-01T00:00:00.000Z", count: 1 },
      { bucketStart: "2026-01-02T00:00:00.000Z", count: 1 },
    ]);
    expect(result.mostActiveConversations).toEqual([
      {
        conversationId: conversationOneId,
        title: "Alice and Bob",
        messageCount: 2,
        lastMessageAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
  });

  it("uses an inclusive/exclusive UTC range and proves archive isolation", async () => {
    const result = await service.getStatistics({
      archiveId: archiveOneId,
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-02T00:00:00Z",
    });
    expect(result.totals).toMatchObject({ messages: 1, conversations: 1, people: 2, media: 1 });
    expect(result.direction).toEqual({ sent: 1, received: 0, unknown: 0 });
    expect(result.activity).toEqual([{ bucketStart: "2026-01-01T00:00:00.000Z", count: 1 }]);
    expect((await service.getStatistics({ archiveId: archiveTwoId })).totals.messages).toBe(1);
    expect((await service.getStatistics({ archiveId: emptyArchiveId })).totals).toEqual({
      messages: 0,
      conversations: 0,
      people: 0,
      media: 0,
    });
  });
});
