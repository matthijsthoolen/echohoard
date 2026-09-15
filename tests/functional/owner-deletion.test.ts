import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  OwnerDeletionConflictError,
  OwnerDeletionService,
} from "../../src/application/owner-deletion.js";
import { PrismaOwnerDeletionPersistence } from "../../src/infrastructure/db/owner-deletion.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const userId = randomUUID();
const archiveId = randomUUID();
const otherArchiveId = randomUUID();
const conversationId = randomUUID();
const messageId = randomUUID();
const attachmentId = randomUUID();

describe("owner soft deletion", () => {
  const command = new OwnerDeletionService(new PrismaOwnerDeletionPersistence(prisma));

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId } });
    await prisma.archive.createMany({
      data: [
        { id: archiveId, userId, name: `delete-${archiveId}` },
        { id: otherArchiveId, userId, name: `delete-other-${otherArchiveId}` },
      ],
    });
    await prisma.conversation.create({
      data: {
        id: conversationId,
        archiveId,
        kind: "direct",
        stableKey: `conversation-${conversationId}`,
      },
    });
    await prisma.message.create({
      data: {
        id: messageId,
        archiveId,
        conversationId,
        stableKey: `message-${messageId}`,
        messageType: "text",
        sourceDeleted: true,
      },
    });
    await prisma.attachment.create({
      data: { id: attachmentId, archiveId, sha256: "a".repeat(64) },
    });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("audits idempotent conversation cascade policy without changing descendants or source deletion", async () => {
    const request = {
      archiveId,
      entityKind: "conversation" as const,
      entityId: conversationId,
      action: "delete" as const,
      actor: "owner",
      reason: "privacy",
      idempotencyKey: "conversation-delete",
    };
    const first = await command.execute(request);
    const replay = await command.execute(request);
    expect(first).toMatchObject({
      ownerDeleted: true,
      version: 1,
      cascadeCount: 1,
      idempotent: false,
    });
    expect(replay).toMatchObject({ auditId: first.auditId, idempotent: true });
    expect(
      await prisma.message.findUnique({
        where: { archiveId_id: { archiveId, id: messageId } },
        select: { ownerDeleted: true, sourceDeleted: true },
      }),
    ).toEqual({ ownerDeleted: false, sourceDeleted: true });
    expect(await prisma.ownerDeletionAudit.count({ where: { archiveId } })).toBe(1);
  });

  it("restores only the conversation and rejects stale versions", async () => {
    await expect(
      command.execute({
        archiveId,
        entityKind: "conversation",
        entityId: conversationId,
        action: "restore",
        actor: "owner",
        reason: "restored",
        idempotencyKey: "conversation-restore",
        expectedVersion: 0,
      }),
    ).rejects.toBeInstanceOf(OwnerDeletionConflictError);
    const restored = await command.execute({
      archiveId,
      entityKind: "conversation",
      entityId: conversationId,
      action: "restore",
      actor: "owner",
      reason: "restored",
      idempotencyKey: "conversation-restore",
      expectedVersion: 1,
    });
    expect(restored).toMatchObject({ ownerDeleted: false, version: 2 });
  });

  it("enforces archive isolation", async () => {
    await expect(
      command.execute({
        archiveId: otherArchiveId,
        entityKind: "message",
        entityId: messageId,
        action: "delete",
        actor: "owner",
        reason: "wrong archive",
        idempotencyKey: "other-archive",
      }),
    ).rejects.toThrow("not in archive");
    expect(
      await prisma.message.findUnique({
        where: { archiveId_id: { archiveId, id: messageId } },
        select: { ownerDeleted: true },
      }),
    ).toEqual({ ownerDeleted: false });
  });
});
