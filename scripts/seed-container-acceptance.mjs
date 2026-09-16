import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

// These identifiers are disposable acceptance fixtures, not deployment data.
// Keeping them fixed makes the HTTP probes deterministic across clean runs.
const ids = {
  user: "00000000-0000-4000-8000-000000000001",
  archive: "00000000-0000-4000-8000-000000000011",
  otherArchive: "00000000-0000-4000-8000-000000000012",
  account: "00000000-0000-4000-8000-000000000021",
  otherAccount: "00000000-0000-4000-8000-000000000022",
  deniedConversation: "00000000-0000-4000-8000-000000000031",
  otherConversation: "00000000-0000-4000-8000-000000000032",
  deniedMessage: "00000000-0000-4000-8000-000000000041",
  otherMessage: "00000000-0000-4000-8000-000000000042",
};

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
try {
  await prisma.$transaction(async (tx) => {
    await tx.user.upsert({
      where: { id: ids.user },
      create: { id: ids.user },
      update: {},
    });
    await tx.archive.upsert({
      where: { id: ids.archive },
      create: { id: ids.archive, userId: ids.user, name: "synthetic acceptance archive" },
      update: { userId: ids.user, name: "synthetic acceptance archive" },
    });
    await tx.archive.upsert({
      where: { id: ids.otherArchive },
      create: { id: ids.otherArchive, userId: ids.user, name: "synthetic other archive" },
      update: { userId: ids.user, name: "synthetic other archive" },
    });
    await tx.ownedAccount.upsert({
      where: {
        archiveId_accountKey: {
          archiveId: ids.archive,
          accountKey: "synthetic-acceptance-account",
        },
      },
      create: {
        id: ids.account,
        archiveId: ids.archive,
        accountKey: "synthetic-acceptance-account",
        displayLabel: "Synthetic acceptance account",
        liveEnabled: true,
      },
      update: { liveEnabled: true, displayLabel: "Synthetic acceptance account" },
    });
    await tx.ownedAccount.upsert({
      where: {
        archiveId_accountKey: {
          archiveId: ids.archive,
          accountKey: "synthetic-other-account",
        },
      },
      create: {
        id: ids.otherAccount,
        archiveId: ids.archive,
        accountKey: "synthetic-other-account",
        displayLabel: "Synthetic other account",
        liveEnabled: true,
      },
      update: { liveEnabled: true, displayLabel: "Synthetic other account" },
    });
    await tx.conversation.upsert({
      where: { archiveId_stableKey: { archiveId: ids.archive, stableKey: "synthetic-denied" } },
      create: {
        id: ids.deniedConversation,
        archiveId: ids.archive,
        kind: "direct",
        stableKey: "synthetic-denied",
        title: "Synthetic denied conversation",
        mcpAccess: "denied",
      },
      update: { title: "Synthetic denied conversation", mcpAccess: "denied" },
    });
    await tx.conversation.upsert({
      where: {
        archiveId_stableKey: { archiveId: ids.otherArchive, stableKey: "synthetic-other" },
      },
      create: {
        id: ids.otherConversation,
        archiveId: ids.otherArchive,
        kind: "direct",
        stableKey: "synthetic-other",
        title: "Synthetic other archive conversation",
      },
      update: { title: "Synthetic other archive conversation" },
    });
    await tx.message.upsert({
      where: {
        archiveId_stableKey: { archiveId: ids.archive, stableKey: "synthetic-denied-message" },
      },
      create: {
        id: ids.deniedMessage,
        archiveId: ids.archive,
        conversationId: ids.deniedConversation,
        stableKey: "synthetic-denied-message",
        messageType: "text",
        body: "synthetic privacy denied evidence",
        sentAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      update: { body: "synthetic privacy denied evidence" },
    });
    await tx.message.upsert({
      where: {
        archiveId_stableKey: { archiveId: ids.otherArchive, stableKey: "synthetic-other-message" },
      },
      create: {
        id: ids.otherMessage,
        archiveId: ids.otherArchive,
        conversationId: ids.otherConversation,
        stableKey: "synthetic-other-message",
        messageType: "text",
        body: "synthetic cross archive evidence",
        sentAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      update: { body: "synthetic cross archive evidence" },
    });
  });
  console.log("Synthetic container acceptance fixture seeded");
} finally {
  await prisma.$disconnect();
}
