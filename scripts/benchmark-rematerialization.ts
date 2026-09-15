import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { ApplyImportExclusionService } from "../src/application/import-exclusion.js";
import type { ImportRecord } from "../src/application/text-import.js";
import { PrismaImportExclusionPersistence } from "../src/infrastructure/db/import-exclusion.js";
import { PrismaTextSnapshotImporter } from "../src/infrastructure/db/text-import.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const messages = Number(argument("--messages") ?? 250);
if (!Number.isSafeInteger(messages) || messages < 1 || messages > 10_000)
  throw new Error("--messages must be an integer between 1 and 10000");
const output = resolve(
  argument("--output") ?? "docs/benchmarks/eh-13-08-rematerialization-latest.json",
);
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const userId = randomUUID();
const archiveId = randomUUID();
const accountId = randomUUID();
const importer = new PrismaTextSnapshotImporter(prisma);
const records: readonly ImportRecord[] = [
  {
    kind: "conversation",
    stableKey: "benchmark-chat",
    conversationKind: "direct",
    title: "Synthetic benchmark",
  },
  ...Array.from(
    { length: messages },
    (_, index): ImportRecord => ({
      kind: "message",
      stableKey: `benchmark-message-${index}`,
      source: { namespace: "synthetic-benchmark", value: `message-${index}` },
      conversationKey: "benchmark-chat",
      timestamp: new Date(Date.UTC(2020, 0, 1) + index * 60_000).toISOString(),
      direction: "received",
      messageKind: "text",
      body: `synthetic benchmark message ${index}`,
      bodyState: "present",
    }),
  ),
];
const main = async (): Promise<void> => {
  try {
    await prisma.user.create({ data: { id: userId } });
    await prisma.archive.create({
      data: { id: archiveId, userId, name: `benchmark-${archiveId}` },
    });
    await prisma.ownedAccount.create({
      data: { id: accountId, archiveId, accountKey: "synthetic-account" },
    });
    const jobs: string[] = [];
    for (const [index, kind] of (["backup", "live", "backup"] as const).entries()) {
      const sourceId = randomUUID(),
        snapshotId = randomUUID(),
        jobId = randomUUID();
      await prisma.source.create({
        data: {
          id: sourceId,
          archiveId,
          ownedAccountId: accountId,
          kind,
          stableKey: `benchmark-${kind}-${index}`,
          sha256: `${index}`.repeat(64),
        },
      });
      await prisma.snapshot.create({
        data: {
          id: snapshotId,
          archiveId,
          ownedAccountId: accountId,
          sourceId,
          sha256: `${index}`.repeat(64),
        },
      });
      await prisma.importJob.create({
        data: {
          id: jobId,
          archiveId,
          ownedAccountId: accountId,
          sourceId,
          snapshotId,
          status: "queued",
        },
      });
      await importer.import({
        archiveId,
        ownedAccountId: accountId,
        snapshotId,
        importJobId: jobId,
        observedAt: new Date(Date.UTC(2026, 0, index + 1)),
        records,
      });
      jobs.push(jobId);
    }
    const [logicalMessages, observations, sourceConversations] = await Promise.all([
      prisma.message.count({ where: { archiveId } }),
      prisma.messageObservation.count({ where: { archiveId } }),
      prisma.sourceConversation.count({ where: { archiveId } }),
    ]);
    if (logicalMessages !== messages || observations !== messages * 3 || sourceConversations !== 1)
      throw new Error("duplicate live/backup-shaped observations did not converge");
    const service = new ApplyImportExclusionService(new PrismaImportExclusionPersistence(prisma));
    const request = (action: "exclude" | "re-enable", key: string) => ({
      archiveId,
      importJobId: jobs[1],
      action,
      actor: "synthetic-benchmark",
      reason: "bounded benchmark",
      idempotencyKey: key,
    });
    const excludeStart = performance.now();
    await service.execute(request("exclude", "benchmark-exclude"));
    const excludeMs = performance.now() - excludeStart;
    const enableStart = performance.now();
    const enabled = await service.execute(request("re-enable", "benchmark-enable"));
    const enableMs = performance.now() - enableStart;
    const replay = await service.execute(request("re-enable", "benchmark-enable"));
    if (enabled.inputSetDigest !== replay.inputSetDigest || !replay.idempotent)
      throw new Error("rematerialization replay was not stable and idempotent");
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      scope: "synthetic bounded rematerialization",
      messages,
      imports: 3,
      logicalMessages,
      messageObservations: observations,
      sourceConversations,
      excludedImport: "live-shaped middle import",
      excludeMs: Number(excludeMs.toFixed(3)),
      reEnableMs: Number(enableMs.toFixed(3)),
      inputSetDigestStable: true,
      bounded: true,
      command: `pnpm benchmark:rematerialization -- --messages ${messages}`,
    };
    await mkdir(resolve(output, ".."), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(
      JSON.stringify({
        output,
        messages,
        excludeMs: report.excludeMs,
        reEnableMs: report.reEnableMs,
        inputSetDigestStable: true,
      }),
    );
  } finally {
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
};
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
