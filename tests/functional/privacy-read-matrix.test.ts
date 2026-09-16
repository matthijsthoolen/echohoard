import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArchiveReadService, CursorCodec } from "../../src/application/reads.js";
import { ArchiveStatisticsService } from "../../src/application/statistics.js";
import { PrismaMediaDelivery } from "../../src/infrastructure/db/media-delivery.js";
import {
  PrismaReadPersistence,
  PrismaStatisticsPersistence,
} from "../../src/infrastructure/db/prisma-persistence.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const ids = Object.fromEntries(
  [
    "user",
    "archive",
    "account",
    "source",
    "snapshot",
    "job",
    "normalConversation",
    "hiddenConversation",
    "lockedConversation",
    "targetConversation",
    "normalSourceConversation",
    "lockedSourceConversation",
    "targetSourceLink",
    "normalSourceLink",
    "lockedSourceLink",
    "normalPerson",
    "hiddenPerson",
    "lockedPerson",
    "groupPerson",
    "normalMessage",
    "hiddenMessage",
    "lockedMessage",
    "groupNormalMessage",
    "groupLockedMessage",
    "normalAttachment",
    "hiddenAttachment",
    "lockedAttachment",
  ].map((name) => [name, randomUUID()]),
) as Record<string, string>;

const readService = new ArchiveReadService(
  new PrismaReadPersistence(prisma),
  new CursorCodec("privacy-matrix-read-secret"),
);
const statisticsService = new ArchiveStatisticsService(new PrismaStatisticsPersistence(prisma));

const access = (mode: "ordinary" | "hidden" | "locked", idsToAuthorize: string[] = []) => ({
  archiveId: ids.archive,
  uiAccess: { mode, authorizedConversationIds: idsToAuthorize },
});

describe("PostgreSQL UI privacy read matrix", () => {
  beforeAll(async () => {
    await prisma.$connect();
    await prisma.user.create({ data: { id: ids.user } });
    await prisma.archive.create({
      data: { id: ids.archive, userId: ids.user, name: "privacy-matrix" },
    });
    await prisma.ownedAccount.create({
      data: { id: ids.account, archiveId: ids.archive, accountKey: "privacy-matrix-account" },
    });
    await prisma.source.create({
      data: {
        id: ids.source,
        archiveId: ids.archive,
        ownedAccountId: ids.account,
        kind: "synthetic",
        stableKey: "privacy-matrix-source",
        sha256: "1".repeat(64),
      },
    });
    await prisma.snapshot.create({
      data: {
        id: ids.snapshot,
        archiveId: ids.archive,
        ownedAccountId: ids.account,
        sourceId: ids.source,
        sha256: "2".repeat(64),
        lifecycle: "completed",
        completedAt: new Date("2026-01-01T00:01:00Z"),
      },
    });
    await prisma.importJob.create({
      data: {
        id: ids.job,
        archiveId: ids.archive,
        ownedAccountId: ids.account,
        sourceId: ids.source,
        snapshotId: ids.snapshot,
        status: "completed",
        finishedAt: new Date("2026-01-01T00:01:00Z"),
      },
    });
    await prisma.conversation.createMany({
      data: [
        conversation(ids.normalConversation, "normal", "Normal chat"),
        conversation(ids.hiddenConversation, "hidden", "Hidden chat"),
        conversation(ids.lockedConversation, "locked", "Locked chat"),
        conversation(ids.targetConversation, "normal", "Unified chat"),
        conversation(ids.normalSourceConversation, "normal", "Unified source normal"),
        conversation(ids.lockedSourceConversation, "locked", "Unified source locked"),
      ],
    });
    await prisma.sourceConversation.createMany({
      data: [
        sourceConversation(ids.targetSourceLink, ids.targetConversation),
        sourceConversation(ids.normalSourceLink, ids.targetConversation),
        sourceConversation(ids.lockedSourceLink, ids.targetConversation),
      ],
    });
    await prisma.person.createMany({
      data: [
        { id: ids.normalPerson, archiveId: ids.archive, displayName: "Normal person" },
        { id: ids.hiddenPerson, archiveId: ids.archive, displayName: "Hidden person" },
        { id: ids.lockedPerson, archiveId: ids.archive, displayName: "Locked person" },
        { id: ids.groupPerson, archiveId: ids.archive, displayName: "Unified person" },
      ],
    });
    await prisma.conversationParticipant.createMany({
      data: [
        participant(ids.normalConversation, ids.normalPerson),
        participant(ids.hiddenConversation, ids.hiddenPerson),
        participant(ids.lockedConversation, ids.lockedPerson),
        participant(ids.normalSourceConversation, ids.groupPerson, ids.normalSourceLink),
        participant(ids.lockedSourceConversation, ids.groupPerson, ids.lockedSourceLink),
      ],
    });
    await prisma.message.createMany({
      data: [
        message(ids.normalMessage, ids.normalConversation, "normal sentinel"),
        message(ids.hiddenMessage, ids.hiddenConversation, "hidden sentinel"),
        message(ids.lockedMessage, ids.lockedConversation, "locked sentinel"),
        message(
          ids.groupNormalMessage,
          ids.normalSourceConversation,
          "unified normal sentinel",
          ids.normalSourceLink,
        ),
        message(
          ids.groupLockedMessage,
          ids.lockedSourceConversation,
          "unified locked sentinel",
          ids.lockedSourceLink,
        ),
      ],
    });
    await prisma.attachment.createMany({
      data: [
        attachment(ids.normalAttachment, "privacy-normal-attachment"),
        attachment(ids.hiddenAttachment, "privacy-hidden-attachment"),
        attachment(ids.lockedAttachment, "privacy-locked-attachment"),
      ],
    });
    await prisma.messageAttachment.createMany({
      data: [
        {
          archiveId: ids.archive,
          messageId: ids.normalMessage,
          attachmentId: ids.normalAttachment,
        },
        {
          archiveId: ids.archive,
          messageId: ids.hiddenMessage,
          attachmentId: ids.hiddenAttachment,
        },
        {
          archiveId: ids.archive,
          messageId: ids.lockedMessage,
          attachmentId: ids.lockedAttachment,
        },
        {
          archiveId: ids.archive,
          messageId: ids.groupLockedMessage,
          attachmentId: ids.lockedAttachment,
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: ids.user } });
    await prisma.$disconnect();
  });

  it("filters normal, hidden, and locked reads, including direct IDs and derived people", async () => {
    const ordinaryConversations = await readService.listConversations(access("ordinary"));
    expect(ordinaryConversations.items.map((item) => item.id)).toEqual([ids.normalConversation]);
    expect(
      (await readService.listConversations(access("hidden"))).items.map((item) => item.id),
    ).toEqual([ids.hiddenConversation]);
    expect((await readService.listConversations(access("locked"))).items).toEqual([]);

    expect(
      (
        await readService.listMessages({
          ...access("ordinary"),
          conversationId: ids.lockedConversation,
        })
      ).items,
    ).toEqual([]);
    expect(
      (await readService.search({ ...access("ordinary"), query: "hidden sentinel" })).items,
    ).toEqual([]);
    expect((await readService.listPeople(access("ordinary"))).items.map((item) => item.id)).toEqual(
      [ids.normalPerson],
    );
    expect(
      (await readService.listMedia({ ...access("ordinary"), attachmentId: ids.lockedAttachment }))
        .items,
    ).toEqual([]);
    expect(
      (
        await readService.listMessages({
          ...access("ordinary"),
          conversationId: "not-a-real-conversation-id",
        })
      ).items,
    ).toEqual([]);
    expect(
      (
        await readService.listMedia({
          ...access("ordinary"),
          attachmentId: "not-a-real-attachment-id",
        })
      ).items,
    ).toEqual([]);
    expect((await readService.listTimeline(access("ordinary"))).items).toHaveLength(2);
  });

  it("uses the most restrictive source policy for a unified presentation group", async () => {
    const ordinary = await readService.listMessages({
      ...access("ordinary"),
      conversationId: ids.targetConversation,
    });
    expect(ordinary.items).toEqual([]);

    const unlocked = await readService.listMessages({
      ...access("locked", [ids.lockedSourceConversation]),
      conversationId: ids.targetConversation,
    });
    expect(unlocked.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([ids.groupNormalMessage, ids.groupLockedMessage]),
    );
    expect(
      (
        await readService.search({
          ...access("ordinary"),
          query: "unified locked sentinel",
        })
      ).items,
    ).toEqual([]);
    expect((await statisticsService.getStatistics(access("ordinary"))).totals.messages).toBe(1);
    expect(
      (await statisticsService.getStatistics(access("locked", [ids.lockedSourceConversation])))
        .totals.messages,
    ).toBe(2);
  });

  it("denies direct media IDs and permits them only with the matching UI grant", async () => {
    const media = new PrismaMediaDelivery(prisma, "/nonexistent-cas-root");
    await expect(media.find(ids.archive, ids.lockedAttachment)).resolves.toBeNull();
    await expect(media.find(ids.archive, "not-a-real-attachment-id")).resolves.toBeNull();
    await expect(
      media.find(ids.archive, ids.lockedAttachment, {
        mode: "locked",
        authorizedConversationIds: [ids.lockedSourceConversation, ids.lockedConversation],
      }),
    ).resolves.toMatchObject({ state: "missing" });
    await expect(media.find(ids.archive, ids.normalAttachment)).resolves.toMatchObject({
      state: "missing",
    });
  });

  it("takes direct policy changes immediately without a read-cache window", async () => {
    await prisma.conversation.update({
      where: { archiveId_id: { archiveId: ids.archive, id: ids.lockedSourceConversation } },
      data: { uiVisibility: "hidden" },
    });
    expect(
      (
        await readService.listMessages({
          ...access("ordinary"),
          conversationId: ids.targetConversation,
        })
      ).items,
    ).toEqual([]);
    expect(
      (
        await readService.listMessages({
          ...access("hidden"),
          conversationId: ids.targetConversation,
        })
      ).items.map((item) => item.id),
    ).toEqual(expect.arrayContaining([ids.groupNormalMessage, ids.groupLockedMessage]));
    await prisma.conversation.update({
      where: { archiveId_id: { archiveId: ids.archive, id: ids.lockedSourceConversation } },
      data: { uiVisibility: "normal" },
    });
    expect(
      (
        await readService.listMessages({
          ...access("ordinary"),
          conversationId: ids.targetConversation,
        })
      ).items.map((item) => item.id),
    ).toEqual(expect.arrayContaining([ids.groupNormalMessage, ids.groupLockedMessage]));
  });
});

function conversation(id: string, uiVisibility: string, title: string) {
  return {
    id,
    archiveId: ids.archive,
    kind: "direct",
    stableKey: `conversation-${id}`,
    title,
    uiVisibility,
  };
}

function sourceConversation(id: string, unifiedConversationId: string) {
  return {
    id,
    archiveId: ids.archive,
    ownedAccountId: ids.account,
    unifiedConversationId,
    sourceNamespace: "synthetic",
    sourceConversationKey: `source-${id}`,
  };
}

function participant(conversationId: string, personId: string, sourceConversationId?: string) {
  return {
    archiveId: ids.archive,
    conversationId,
    personId,
    ...(sourceConversationId ? { sourceConversationId } : {}),
  };
}

function message(id: string, conversationId: string, body: string, sourceConversationId?: string) {
  return {
    id,
    archiveId: ids.archive,
    conversationId,
    ...(sourceConversationId ? { sourceConversationId } : {}),
    stableKey: `message-${id}`,
    messageType: "text",
    body,
    metadata: { lastSeenSnapshotId: ids.snapshot },
    sentAt: new Date("2026-01-01T00:02:00Z"),
  };
}

function attachment(id: string, stableKey: string) {
  return {
    id,
    archiveId: ids.archive,
    stableKey,
    sha256: id.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    availability: "missing",
    mimeType: "image/png",
  };
}
