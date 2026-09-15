import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const main = async (): Promise<void> => {
  try {
    const archiveId = "00000000-0000-4000-8000-000000000002";
    const [account, source, snapshot, job, conversation, message, sourceConversation] =
      await Promise.all([
        prisma.ownedAccount.findFirst({ where: { archiveId, accountKey: "legacy-default" } }),
        prisma.source.findUnique({
          where: { archiveId_id: { archiveId, id: "00000000-0000-4000-8000-000000000003" } },
        }),
        prisma.snapshot.findUnique({
          where: { archiveId_id: { archiveId, id: "00000000-0000-4000-8000-000000000004" } },
        }),
        prisma.importJob.findUnique({
          where: { archiveId_id: { archiveId, id: "00000000-0000-4000-8000-000000000005" } },
        }),
        prisma.conversation.findUnique({
          where: { archiveId_id: { archiveId, id: "00000000-0000-4000-8000-000000000007" } },
        }),
        prisma.message.findUnique({
          where: { archiveId_id: { archiveId, id: "00000000-0000-4000-8000-000000000008" } },
        }),
        prisma.sourceConversation.findFirst({
          where: { archiveId, unifiedConversationId: "00000000-0000-4000-8000-000000000007" },
        }),
      ]);
    if (
      !account ||
      !source ||
      !snapshot ||
      !job ||
      !conversation ||
      !message ||
      !sourceConversation
    )
      throw new Error("EH-13 migration did not preserve the synthetic V1 rows");
    if (
      source.ownedAccountId !== account.id ||
      snapshot.ownedAccountId !== account.id ||
      job.ownedAccountId !== account.id
    )
      throw new Error("EH-13 migration did not bind V1 rows to the archive-local account");
    if (
      source.id !== "00000000-0000-4000-8000-000000000003" ||
      message.id !== "00000000-0000-4000-8000-000000000008"
    )
      throw new Error("EH-13 migration rewrote stable V1 identifiers");
    console.log(
      JSON.stringify({
        archive: "synthetic",
        preserved: { sources: 1, snapshots: 1, jobs: 1, conversations: 1, messages: 1 },
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
};
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
