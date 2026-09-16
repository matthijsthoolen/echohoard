import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createPrismaPersistence } from "../../src/infrastructure/db/prisma-persistence.js";
import {
  ConversationGroupingService,
  type ConversationGroupingRequest,
} from "../../src/application/conversation-grouping.js";
import { PrismaConversationGroupingPersistence } from "../../src/infrastructure/db/conversation-grouping.js";
import { ArchiveReadService, CursorCodec } from "../../src/application/reads.js";
import { PrismaReadPersistence } from "../../src/infrastructure/db/prisma-persistence.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const ports = createPrismaPersistence(prisma);
const [userId, archiveOneId, archiveTwoId] = Array.from({ length: 3 }, () => randomUUID());

describe("source and unified conversation persistence", () => {
  beforeAll(async () => {
    await prisma.$connect();
    await prisma.user.create({ data: { id: userId } });
    await prisma.archive.createMany({
      data: [
        { id: archiveOneId, userId, name: `source-one-${archiveOneId}` },
        { id: archiveTwoId, userId, name: `source-two-${archiveTwoId}` },
      ],
    });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("keeps same-JID accounts separate and preserves existing normalized IDs", async () => {
    const accountOneId = randomUUID();
    const accountTwoId = randomUUID();
    const conversationOneId = randomUUID();
    const conversationTwoId = randomUUID();
    const personOneId = randomUUID();
    const personTwoId = randomUUID();
    const messageOneId = randomUUID();
    const messageTwoId = randomUUID();

    await prisma.ownedAccount.createMany({
      data: [
        { id: accountOneId, archiveId: archiveOneId, accountKey: `account-${accountOneId}` },
        { id: accountTwoId, archiveId: archiveOneId, accountKey: `account-${accountTwoId}` },
      ],
    });
    await prisma.person.createMany({
      data: [
        { id: personOneId, archiveId: archiveOneId, displayName: "Jacky" },
        { id: personTwoId, archiveId: archiveOneId, displayName: "Jacky" },
      ],
    });
    await prisma.identity.createMany({
      data: [
        { archiveId: archiveOneId, personId: personOneId, kind: "jid", value: "jid-one" },
        { archiveId: archiveOneId, personId: personTwoId, kind: "jid", value: "jid-two" },
      ],
    });
    await prisma.conversation.createMany({
      data: [
        {
          id: conversationOneId,
          archiveId: archiveOneId,
          kind: "direct",
          stableKey: "chat-one",
          title: "Jacky",
        },
        {
          id: conversationTwoId,
          archiveId: archiveOneId,
          kind: "group",
          stableKey: "chat-two",
          title: "Jacky",
        },
      ],
    });
    await prisma.sourceConversation.createMany({
      data: [
        {
          id: conversationOneId,
          archiveId: archiveOneId,
          ownedAccountId: accountOneId,
          unifiedConversationId: conversationOneId,
          sourceNamespace: "whatsapp",
          sourceConversationKey: "same-jid",
        },
        {
          id: conversationTwoId,
          archiveId: archiveOneId,
          ownedAccountId: accountTwoId,
          unifiedConversationId: conversationTwoId,
          sourceNamespace: "whatsapp",
          sourceConversationKey: "same-jid",
        },
      ],
    });
    await prisma.conversationParticipant.createMany({
      data: [
        {
          archiveId: archiveOneId,
          conversationId: conversationOneId,
          sourceConversationId: conversationOneId,
          personId: personOneId,
        },
        {
          archiveId: archiveOneId,
          conversationId: conversationTwoId,
          sourceConversationId: conversationTwoId,
          personId: personTwoId,
        },
      ],
    });
    await prisma.message.createMany({
      data: [
        {
          id: messageOneId,
          archiveId: archiveOneId,
          conversationId: conversationOneId,
          sourceConversationId: conversationOneId,
          stableKey: "message-one",
          messageType: "text",
          body: "one",
        },
        {
          id: messageTwoId,
          archiveId: archiveOneId,
          conversationId: conversationTwoId,
          sourceConversationId: conversationTwoId,
          stableKey: "message-two",
          messageType: "text",
          body: "two",
        },
      ],
    });

    const sourceConversations = await ports.sourceConversations.list(archiveOneId);
    expect(sourceConversations.map((row) => row.id).sort()).toEqual(
      [conversationOneId, conversationTwoId].sort(),
    );
    expect((await prisma.message.findUnique({ where: { id: messageOneId } }))?.id).toBe(
      messageOneId,
    );
    expect((await prisma.message.findUnique({ where: { id: messageTwoId } }))?.id).toBe(
      messageTwoId,
    );
    expect(
      await prisma.sourceConversation.count({
        where: { archiveId: archiveOneId, sourceConversationKey: "same-jid" },
      }),
    ).toBe(2);
  });

  it("rejects cross-archive source and normalized links", async () => {
    const accountId = randomUUID();
    const conversationId = randomUUID();
    const personId = randomUUID();
    await prisma.ownedAccount.create({
      data: { id: accountId, archiveId: archiveOneId, accountKey: `isolated-${accountId}` },
    });
    await prisma.conversation.create({
      data: {
        id: conversationId,
        archiveId: archiveOneId,
        kind: "direct",
        stableKey: `isolated-${conversationId}`,
      },
    });
    await prisma.person.create({
      data: { id: personId, archiveId: archiveTwoId, displayName: "Other" },
    });

    await expect(
      prisma.sourceConversation.create({
        data: {
          archiveId: archiveTwoId,
          ownedAccountId: accountId,
          unifiedConversationId: conversationId,
          sourceNamespace: "whatsapp",
          sourceConversationKey: "cross-archive",
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.conversationParticipant.create({
        data: {
          archiveId: archiveOneId,
          conversationId,
          sourceConversationId: conversationId,
          personId,
        },
      }),
    ).rejects.toThrow();
    expect(await ports.sourceConversations.list(archiveTwoId)).toHaveLength(0);
  });

  it("merges and reverses exact sources without rewriting messages", async () => {
    const accountId = randomUUID();
    const targetId = randomUUID();
    const sourceId = randomUUID();
    const messageId = randomUUID();
    await prisma.ownedAccount.create({
      data: { id: accountId, archiveId: archiveOneId, accountKey: `merge-${accountId}` },
    });
    await prisma.conversation.createMany({
      data: [
        { id: targetId, archiveId: archiveOneId, kind: "direct", stableKey: `target-${targetId}` },
        { id: sourceId, archiveId: archiveOneId, kind: "direct", stableKey: `source-${sourceId}` },
      ],
    });
    await prisma.sourceConversation.createMany({
      data: [
        {
          id: targetId,
          archiveId: archiveOneId,
          ownedAccountId: accountId,
          unifiedConversationId: targetId,
          sourceNamespace: "synthetic",
          sourceConversationKey: `target-${targetId}`,
        },
        {
          id: sourceId,
          archiveId: archiveOneId,
          ownedAccountId: accountId,
          unifiedConversationId: sourceId,
          sourceNamespace: "synthetic",
          sourceConversationKey: `source-${sourceId}`,
        },
      ],
    });
    await prisma.message.create({
      data: {
        id: messageId,
        archiveId: archiveOneId,
        conversationId: sourceId,
        sourceConversationId: sourceId,
        stableKey: `message-${messageId}`,
        messageType: "text",
        body: "synthetic merge message",
      },
    });

    const service = new ConversationGroupingService(
      new PrismaConversationGroupingPersistence(prisma),
    );
    const merge: ConversationGroupingRequest = {
      archiveId: archiveOneId,
      targetConversationId: targetId,
      sourceConversationIds: [sourceId],
      expectedVersion: 0,
      actor: "synthetic-owner",
      reason: "synthetic exact selection",
      idempotencyKey: `merge-${messageId}`,
      ownerTitle: "Owner title",
      uiAccess: { authorizedConversationIds: [] },
    };
    const merged = await service.merge(merge);
    expect(merged.idempotent).toBe(false);
    expect((await service.merge(merge)).idempotent).toBe(true);
    const access = { authorizedConversationIds: [] };
    const mergedState = await service.getState(archiveOneId, targetId, access);
    expect(mergedState).toMatchObject({
      version: 1,
      mergeSourceIds: [sourceId],
      mergeAuditId: merged.auditId,
      sources: expect.arrayContaining([expect.objectContaining({ id: sourceId })]),
    });
    expect(mergedState.currentSourceIds).toEqual(expect.arrayContaining([targetId, sourceId]));
    expect(mergedState.currentSourceIds).toHaveLength(2);
    expect((await prisma.message.findUnique({ where: { id: messageId } }))?.conversationId).toBe(
      sourceId,
    );
    expect(
      (await prisma.sourceConversation.findUnique({ where: { id: sourceId } }))
        ?.unifiedConversationId,
    ).toBe(targetId);
    expect((await prisma.conversation.findUnique({ where: { id: targetId } }))?.ownerTitle).toBe(
      "Owner title",
    );

    const undone = await service.unmerge({
      ...merge,
      expectedVersion: 1,
      idempotencyKey: `unmerge-${messageId}`,
      auditId: merged.auditId,
    });
    expect(undone.version).toBe(2);
    expect(
      (await prisma.sourceConversation.findUnique({ where: { id: sourceId } }))
        ?.unifiedConversationId,
    ).toBe(sourceId);
    await expect(service.getState(archiveOneId, targetId, access)).resolves.toMatchObject({
      version: 2,
      currentSourceIds: [targetId],
      mergeSourceIds: [],
    });
    await expect(
      service.merge({ ...merge, expectedVersion: 0, idempotencyKey: `stale-${messageId}` }),
    ).rejects.toThrow("stale grouping version");
    await prisma.conversation.update({
      where: { id: targetId },
      data: { uiVisibility: "hidden" },
    });
    await expect(service.getState(archiveOneId, targetId, access)).rejects.toThrow(
      "grouping conversation unavailable",
    );
    await expect(
      service.merge({ ...merge, expectedVersion: 2, idempotencyKey: `hidden-${messageId}` }),
    ).rejects.toThrow("grouping conversation unavailable");
    await prisma.conversation.update({
      where: { id: targetId },
      data: { uiVisibility: "normal" },
    });
    await prisma.conversation.update({
      where: { id: sourceId },
      data: { uiVisibility: "locked" },
    });
    await expect(
      service.merge({
        ...merge,
        expectedVersion: 2,
        idempotencyKey: `locked-source-${messageId}`,
      }),
    ).rejects.toThrow("grouping conversation unavailable");
    await prisma.sourceConversation.update({
      where: { archiveId_id: { archiveId: archiveOneId, id: sourceId } },
      data: { unifiedConversationId: targetId },
    });
    await expect(service.getState(archiveOneId, targetId, access)).rejects.toThrow(
      "grouping conversation unavailable",
    );
    await expect(
      service.getState(archiveOneId, targetId, {
        authorizedConversationIds: [targetId, sourceId],
      }),
    ).resolves.toMatchObject({ currentSourceIds: expect.arrayContaining([targetId, sourceId]) });
    await prisma.conversation.update({
      where: { id: targetId },
      data: { uiVisibility: "locked" },
    });
    await expect(service.getState(archiveOneId, targetId, access)).rejects.toThrow(
      "grouping conversation unavailable",
    );
    await expect(
      service.getState(archiveOneId, targetId, {
        authorizedConversationIds: [targetId, sourceId],
      }),
    ).resolves.toBeDefined();
    await prisma.conversation.update({
      where: { id: targetId },
      data: { uiVisibility: "normal" },
    });
    await prisma.conversation.update({
      where: { id: sourceId },
      data: { uiVisibility: "normal" },
    });
    await prisma.conversation.update({ where: { id: targetId }, data: { groupingLocked: true } });
    await expect(
      service.merge({ ...merge, expectedVersion: 2, idempotencyKey: `locked-${messageId}` }),
    ).rejects.toThrow("locked");
  });

  it("lists active unified groups once with aggregate summaries and policy filtering", async () => {
    const accountId = randomUUID();
    const targetId = randomUUID();
    const sourceId = randomUUID();
    const personOneId = randomUUID();
    const personTwoId = randomUUID();
    const messageOneId = randomUUID();
    const messageTwoId = randomUUID();
    const equalTimestamp = new Date("2026-01-03T12:00:00.000Z");
    await prisma.ownedAccount.create({
      data: { id: accountId, archiveId: archiveOneId, accountKey: `list-${accountId}` },
    });
    await prisma.person.createMany({
      data: [
        { id: personOneId, archiveId: archiveOneId, displayName: "One" },
        { id: personTwoId, archiveId: archiveOneId, displayName: "Two" },
      ],
    });
    await prisma.conversation.createMany({
      data: [
        {
          id: targetId,
          archiveId: archiveOneId,
          kind: "direct",
          stableKey: `list-target-${targetId}`,
          title: "Target",
        },
        {
          id: sourceId,
          archiveId: archiveOneId,
          kind: "direct",
          stableKey: `list-source-${sourceId}`,
          title: "Source",
        },
      ],
    });
    await prisma.sourceConversation.createMany({
      data: [
        {
          id: targetId,
          archiveId: archiveOneId,
          ownedAccountId: accountId,
          unifiedConversationId: targetId,
          sourceNamespace: "synthetic",
          sourceConversationKey: `target-${targetId}`,
        },
        {
          id: sourceId,
          archiveId: archiveOneId,
          ownedAccountId: accountId,
          unifiedConversationId: sourceId,
          sourceNamespace: "synthetic",
          sourceConversationKey: `source-${sourceId}`,
        },
      ],
    });
    await prisma.conversationParticipant.createMany({
      data: [
        {
          archiveId: archiveOneId,
          conversationId: targetId,
          sourceConversationId: targetId,
          personId: personOneId,
        },
        {
          archiveId: archiveOneId,
          conversationId: sourceId,
          sourceConversationId: sourceId,
          personId: personTwoId,
        },
      ],
    });
    await prisma.message.createMany({
      data: [
        {
          id: messageOneId,
          archiveId: archiveOneId,
          conversationId: targetId,
          sourceConversationId: targetId,
          stableKey: `list-message-${messageOneId}`,
          messageType: "text",
          body: "one",
          sentAt: equalTimestamp,
        },
        {
          id: messageTwoId,
          archiveId: archiveOneId,
          conversationId: sourceId,
          sourceConversationId: sourceId,
          stableKey: `list-message-${messageTwoId}`,
          messageType: "text",
          body: "two",
          sentAt: equalTimestamp,
        },
      ],
    });

    const reads = new ArchiveReadService(
      new PrismaReadPersistence(prisma),
      new CursorCodec("list-test"),
    );
    await expect(reads.listConversations({ archiveId: archiveOneId })).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: targetId, participantCount: 1 }),
        expect.objectContaining({ id: sourceId, participantCount: 1 }),
      ]),
    });
    const grouping = new ConversationGroupingService(
      new PrismaConversationGroupingPersistence(prisma),
    );
    await grouping.merge({
      archiveId: archiveOneId,
      targetConversationId: targetId,
      sourceConversationIds: [sourceId],
      expectedVersion: 0,
      actor: "synthetic-owner",
      reason: "aggregate test",
      idempotencyKey: `list-merge-${targetId}`,
      uiAccess: { authorizedConversationIds: [] },
    });
    const merged = await reads.listConversations({ archiveId: archiveOneId });
    const mergedRows = merged.items.filter((item) => item.id === targetId || item.id === sourceId);
    expect(mergedRows).toHaveLength(1);
    expect(mergedRows[0]).toMatchObject({
      id: targetId,
      participantCount: 2,
      lastMessageAt: equalTimestamp.toISOString(),
    });

    await prisma.conversation.update({ where: { id: sourceId }, data: { uiVisibility: "locked" } });
    expect((await reads.listConversations({ archiveId: archiveOneId })).items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: targetId })]),
    );
    expect(
      (
        await reads.listConversations({
          archiveId: archiveOneId,
          uiAccess: { mode: "locked", authorizedConversationIds: [sourceId] },
        })
      ).items,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: targetId, participantCount: 2 })]),
    );

    await grouping.unmerge({
      archiveId: archiveOneId,
      targetConversationId: targetId,
      sourceConversationIds: [sourceId],
      expectedVersion: 1,
      actor: "synthetic-owner",
      reason: "aggregate test undo",
      idempotencyKey: `list-unmerge-${targetId}`,
      auditId: (
        await grouping.getState(archiveOneId, targetId, { authorizedConversationIds: [sourceId] })
      ).mergeAuditId!,
      uiAccess: { authorizedConversationIds: [sourceId] },
    });
    await prisma.conversation.update({ where: { id: sourceId }, data: { uiVisibility: "normal" } });
    const unmerged = await reads.listConversations({ archiveId: archiveOneId });
    expect(
      unmerged.items.filter((item) => item.id === targetId || item.id === sourceId),
    ).toHaveLength(2);
  });
});
