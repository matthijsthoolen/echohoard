import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createPrismaPersistence } from "../../src/infrastructure/db/prisma-persistence.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const ports = createPrismaPersistence(prisma);
const ids = Array.from({ length: 18 }, () => randomUUID());
const [
  userId,
  archiveOneId,
  archiveTwoId,
  accountOneId,
  accountTwoId,
  sourceOneId,
  sourceTwoId,
  conversationOneId,
  conversationTwoId,
  sourceConversationOneId,
  sourceConversationTwoId,
  messageOneId,
  messageTwoId,
  revisionId,
  reactionId,
  attachmentId,
  linkId,
  personId,
] = ids;
const jobOneId = randomUUID();
const jobTwoId = randomUUID();
const jobOtherId = randomUUID();
const snapshotId = randomUUID();

const digest = "a".repeat(64);
const baseObservation = {
  ownedAccountId: accountOneId,
  sourceId: sourceOneId,
  snapshotId,
  importJobId: jobOneId,
  sourceConversationId: sourceConversationOneId,
  sourceNamespace: "synthetic-whatsapp",
  sourceConversationKey: "chat-1",
  sourceEntityKey: "entity-1",
  logicalEntityKey: "logical-1",
  observationKey: "observation-1",
  observationKind: "value",
  valueDigest: digest,
  observedAt: new Date("2026-01-01T00:00:00.000Z"),
};

describe("typed import observations", () => {
  beforeAll(async () => {
    await prisma.$connect();
    await prisma.user.create({ data: { id: userId } });
    await prisma.archive.createMany({
      data: [
        { id: archiveOneId, userId, name: `observations-one-${archiveOneId}` },
        { id: archiveTwoId, userId, name: `observations-two-${archiveTwoId}` },
      ],
    });
    await prisma.ownedAccount.createMany({
      data: [
        { id: accountOneId, archiveId: archiveOneId, accountKey: `account-${accountOneId}` },
        { id: accountTwoId, archiveId: archiveTwoId, accountKey: `account-${accountTwoId}` },
      ],
    });
    await prisma.source.createMany({
      data: [
        {
          id: sourceOneId,
          archiveId: archiveOneId,
          ownedAccountId: accountOneId,
          kind: "backup",
          stableKey: "source-1",
          sha256: digest,
        },
        {
          id: sourceTwoId,
          archiveId: archiveTwoId,
          ownedAccountId: accountTwoId,
          kind: "backup",
          stableKey: "source-2",
          sha256: digest,
        },
      ],
    });
    await prisma.snapshot.create({
      data: {
        id: snapshotId,
        archiveId: archiveOneId,
        ownedAccountId: accountOneId,
        sourceId: sourceOneId,
        sha256: digest,
      },
    });
    await prisma.importJob.createMany({
      data: [
        {
          id: jobOneId,
          archiveId: archiveOneId,
          ownedAccountId: accountOneId,
          sourceId: sourceOneId,
          snapshotId,
          status: "complete",
        },
        {
          id: jobTwoId,
          archiveId: archiveOneId,
          ownedAccountId: accountOneId,
          sourceId: sourceOneId,
          status: "complete",
        },
        {
          id: jobOtherId,
          archiveId: archiveTwoId,
          ownedAccountId: accountTwoId,
          sourceId: sourceTwoId,
          status: "complete",
        },
      ],
    });
    await prisma.conversation.createMany({
      data: [
        {
          id: conversationOneId,
          archiveId: archiveOneId,
          kind: "direct",
          stableKey: "conversation-1",
        },
        {
          id: conversationTwoId,
          archiveId: archiveTwoId,
          kind: "direct",
          stableKey: "conversation-2",
        },
      ],
    });
    await prisma.sourceConversation.createMany({
      data: [
        {
          id: sourceConversationOneId,
          archiveId: archiveOneId,
          ownedAccountId: accountOneId,
          unifiedConversationId: conversationOneId,
          sourceNamespace: "synthetic-whatsapp",
          sourceConversationKey: "chat-1",
        },
        {
          id: sourceConversationTwoId,
          archiveId: archiveTwoId,
          ownedAccountId: accountTwoId,
          unifiedConversationId: conversationTwoId,
          sourceNamespace: "synthetic-whatsapp",
          sourceConversationKey: "chat-1",
        },
      ],
    });
    await prisma.person.create({
      data: { id: personId, archiveId: archiveOneId, displayName: "Synthetic" },
    });
    await prisma.message.createMany({
      data: [
        {
          id: messageOneId,
          archiveId: archiveOneId,
          conversationId: conversationOneId,
          sourceConversationId: sourceConversationOneId,
          stableKey: "message-1",
          messageType: "text",
          body: "synthetic",
        },
        {
          id: messageTwoId,
          archiveId: archiveTwoId,
          conversationId: conversationTwoId,
          sourceConversationId: sourceConversationTwoId,
          stableKey: "message-2",
          messageType: "text",
          body: "synthetic",
        },
      ],
    });
    await prisma.messageRevision.create({
      data: {
        id: revisionId,
        archiveId: archiveOneId,
        messageId: messageOneId,
        revisionKey: "revision-1",
        body: "synthetic",
      },
    });
    await prisma.reaction.create({
      data: {
        id: reactionId,
        archiveId: archiveOneId,
        messageId: messageOneId,
        personId,
        emoji: "👍",
        stableKey: "reaction-1",
      },
    });
    await prisma.attachment.create({
      data: {
        id: attachmentId,
        archiveId: archiveOneId,
        stableKey: "attachment-1",
        sha256: digest,
      },
    });
    await prisma.messageAttachment.create({
      data: { id: linkId, archiveId: archiveOneId, messageId: messageOneId, attachmentId },
    });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("records every typed target, replays one import, and enumerates bounded provenance", async () => {
    await ports.conversationObservations.create(archiveOneId, { ...baseObservation });
    await ports.messageObservations.create(archiveOneId, {
      ...baseObservation,
      messageId: messageOneId,
    });
    await ports.revisionObservations.create(archiveOneId, {
      ...baseObservation,
      revisionId,
      sourceEntityKey: "revision-1",
    });
    await ports.reactionObservations.create(archiveOneId, {
      ...baseObservation,
      reactionId,
      sourceEntityKey: "reaction-1",
    });
    await ports.attachmentReferenceObservations.create(archiveOneId, {
      ...baseObservation,
      messageAttachmentId: linkId,
      sourceEntityKey: "attachment-reference-1",
    });

    await prisma.messageObservation.upsert({
      where: {
        archiveId_importJobId_observationKind_sourceConversationId_sourceEntityKey_observationKey: {
          archiveId: archiveOneId,
          importJobId: jobOneId,
          observationKind: "value",
          sourceConversationId: sourceConversationOneId,
          sourceEntityKey: "entity-1",
          observationKey: "observation-1",
        },
      },
      create: { archiveId: archiveOneId, messageId: messageOneId, ...baseObservation },
      update: {},
    });
    expect(
      await prisma.messageObservation.count({
        where: { archiveId: archiveOneId, messageId: messageOneId },
      }),
    ).toBe(1);

    await prisma.messageObservation.create({
      data: {
        archiveId: archiveOneId,
        messageId: messageOneId,
        ...baseObservation,
        importJobId: jobTwoId,
        observationKey: "observation-2",
      },
    });
    expect(
      await ports.messageObservations.listForEntity(archiveOneId, messageOneId, 1),
    ).toHaveLength(1);
    expect(
      await prisma.messageObservation.count({
        where: { archiveId: archiveOneId, messageId: messageOneId },
      }),
    ).toBe(2);
    expect(await prisma.conversationObservation.count({ where: { archiveId: archiveOneId } })).toBe(
      1,
    );
    expect(await prisma.revisionObservation.count({ where: { archiveId: archiveOneId } })).toBe(1);
    expect(await prisma.reactionObservation.count({ where: { archiveId: archiveOneId } })).toBe(1);
    expect(
      await prisma.attachmentReferenceObservation.count({ where: { archiveId: archiveOneId } }),
    ).toBe(1);
  });

  it("rejects dangling and cross-archive typed references", async () => {
    await expect(
      prisma.messageObservation.create({
        data: {
          archiveId: archiveTwoId,
          messageId: messageOneId,
          ...baseObservation,
          ownedAccountId: accountTwoId,
          sourceId: sourceTwoId,
          importJobId: jobOtherId,
          sourceConversationId: sourceConversationTwoId,
          observationKey: "cross-archive",
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.conversationObservation.create({
        data: {
          archiveId: archiveOneId,
          ...baseObservation,
          sourceConversationId: randomUUID(),
          observationKey: "dangling-conversation",
        },
      }),
    ).rejects.toThrow();
    expect(await ports.messageObservations.list(archiveTwoId)).toHaveLength(0);
  });
});
