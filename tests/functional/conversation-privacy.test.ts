import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UpdateConversationPrivacyService } from "../../src/application/conversation-privacy.js";
import { PrismaConversationPrivacyPersistence } from "../../src/infrastructure/db/prisma-persistence.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const persistence = new PrismaConversationPrivacyPersistence(prisma);
const userId = randomUUID();
const archiveA = randomUUID();
const archiveB = randomUUID();
const conversationA = randomUUID();

describe("conversation privacy PostgreSQL persistence", () => {
  beforeAll(async () => {
    await prisma.$connect();
    await prisma.user.create({ data: { id: userId } });
    await prisma.archive.createMany({
      data: [
        { id: archiveA, userId, name: "synthetic-a" },
        { id: archiveB, userId, name: "synthetic-b" },
      ],
    });
    await prisma.conversation.create({
      data: { id: conversationA, archiveId: archiveA, kind: "direct", stableKey: "synthetic-chat" },
    });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("migrates safe V1 defaults and records identifier/action-only updates", async () => {
    await expect(persistence.findPolicy(archiveA, conversationA)).resolves.toMatchObject({
      uiVisibility: "normal",
      mcpAccess: "allowed",
    });
    const result = await new UpdateConversationPrivacyService(persistence).execute({
      archiveId: archiveA,
      conversationId: conversationA,
      actorId: "synthetic-user",
      uiVisibility: "hidden",
      mcpAccess: "denied",
    });
    expect(result.policy).toMatchObject({ uiVisibility: "hidden", mcpAccess: "denied" });
    expect(result.audit.map((audit) => audit.action)).toEqual([
      "set-ui-visibility",
      "set-mcp-access",
    ]);
    expect(result.audit[0]).not.toHaveProperty("title");
  });

  it("rejects cross-archive writes and keeps policies isolated", async () => {
    await expect(
      new UpdateConversationPrivacyService(persistence).execute({
        archiveId: archiveB,
        conversationId: conversationA,
        actorId: "synthetic-user",
        uiVisibility: "locked",
      }),
    ).rejects.toThrow("not found in archive");
    await expect(persistence.findPolicy(archiveB, conversationA)).resolves.toBeNull();
    await expect(
      prisma.conversationPrivacyAudit.count({ where: { archiveId: archiveB } }),
    ).resolves.toBe(0);
  });
});
