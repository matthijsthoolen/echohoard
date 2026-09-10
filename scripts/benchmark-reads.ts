import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { ArchiveReadService, CursorCodec } from "../src/application/reads.js";
import {
  CI_CORPUS,
  FULL_CORPUS,
  corpusDistribution,
} from "../src/infrastructure/corpus/reference-corpus.js";
import { PrismaReadPersistence } from "../src/infrastructure/db/prisma-persistence.js";

type Options = {
  databaseUrl: string;
  output: string;
  seed: number;
  expectedMessages: number;
  expectedAttachments: number;
  warmup: number;
  iterations: number;
  coldIterations: number;
  searchTerm: string;
};

type Stats = {
  samples: number;
  minMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
};

type BenchmarkCase =
  | { id: string; kind: "conversation-list" }
  | { id: string; kind: "search"; query: string; from?: string; to?: string }
  | { id: string; kind: "fuzzy-search"; fuzzyText: string };

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`Expected a positive integer, got ${value}`);
  return parsed;
};

const argument = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

const options = (): Options => {
  const args = process.argv.slice(2);
  const full = args.includes("--full");
  const corpus = full ? FULL_CORPUS : CI_CORPUS;
  const seed = parsePositiveInt(argument(args, "--seed"), corpus.seed);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error("DATABASE_URL is required; benchmark execution is database-backed");
  return {
    databaseUrl,
    output: resolve(argument(args, "--output") ?? "docs/benchmarks/eh-06-06-latest.json"),
    seed,
    expectedMessages: parsePositiveInt(
      argument(args, "--expected-messages"),
      full ? FULL_CORPUS.messages : corpus.messages,
    ),
    expectedAttachments: parsePositiveInt(
      argument(args, "--expected-attachments"),
      full ? FULL_CORPUS.attachments : corpus.attachments,
    ),
    warmup: parsePositiveInt(argument(args, "--warmup"), 5),
    iterations: parsePositiveInt(argument(args, "--iterations"), 31),
    coldIterations: parsePositiveInt(argument(args, "--cold-iterations"), 5),
    searchTerm: argument(args, "--search-term") ?? `synthetic-${seed}`,
  };
};

const percentile = (values: readonly number[], fraction: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
};

const statistics = (values: readonly number[]): Stats => ({
  samples: values.length,
  minMs: Number(Math.min(...values).toFixed(3)),
  medianMs: Number(percentile(values, 0.5).toFixed(3)),
  p95Ms: Number(percentile(values, 0.95).toFixed(3)),
  maxMs: Number(Math.max(...values).toFixed(3)),
});

const measure = async (work: () => Promise<unknown>): Promise<number> => {
  const start = performance.now();
  await work();
  return performance.now() - start;
};

const cgroupValue = async (name: string): Promise<string | undefined> => {
  try {
    const value = (await readFile(`/sys/fs/cgroup/${name}`, "utf8")).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
};

const commandValue = (command: string, args: readonly string[]): string | undefined => {
  try {
    return (
      execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
};

const toNumber = (value: bigint | number): number => Number(value);

const queryName = (item: BenchmarkCase): string => item.id;

const runCase = async (
  service: ArchiveReadService,
  archiveId: string,
  item: BenchmarkCase,
): Promise<unknown> => {
  if (item.kind === "conversation-list") return service.listConversations({ archiveId, limit: 50 });
  if (item.kind === "fuzzy-search")
    return service.search({ archiveId, fuzzyText: item.fuzzyText, limit: 50 });
  return service.search({
    archiveId,
    query: item.query,
    limit: 50,
    ...(item.from ? { from: item.from } : {}),
    ...(item.to ? { to: item.to } : {}),
  });
};

const explainSearch = async (
  prisma: PrismaClient,
  archiveId: string,
  item: BenchmarkCase,
): Promise<unknown> => {
  if (item.kind === "conversation-list") return null;
  const search =
    item.kind === "fuzzy-search"
      ? Prisma.sql`message.body % ${item.fuzzyText}`
      : Prisma.sql`message."searchVector" @@ plainto_tsquery('simple'::regconfig, ${item.query})`;
  const dateConditions = [];
  if (item.kind === "search" && item.from)
    dateConditions.push(Prisma.sql`message."sentAt" >= CAST(${item.from} AS timestamp)`);
  if (item.kind === "search" && item.to)
    dateConditions.push(Prisma.sql`message."sentAt" < CAST(${item.to} AS timestamp)`);
  const dateFilters = dateConditions.length
    ? Prisma.sql`AND ${Prisma.join(dateConditions, " AND ")}`
    : Prisma.empty;
  const plan = await prisma.$queryRaw<Array<{ "QUERY PLAN": unknown }>>(Prisma.sql`
    EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, FORMAT JSON)
    SELECT message.id
    FROM "Message" AS message
    LEFT JOIN "Person" AS sender
      ON sender.id = message."senderId" AND sender."archiveId" = message."archiveId"
    JOIN "Conversation" AS conversation
      ON conversation.id = message."conversationId" AND conversation."archiveId" = message."archiveId"
    WHERE message."archiveId" = ${archiveId}::uuid
      AND ${search}
      ${dateFilters}
    ORDER BY message."sentAt" ASC NULLS LAST, message.id ASC
    LIMIT 51
  `);
  return plan[0]?.["QUERY PLAN"] ?? null;
};

const explainConversationList = async (
  prisma: PrismaClient,
  archiveId: string,
): Promise<unknown> => {
  const plan = await prisma.$queryRaw<Array<{ "QUERY PLAN": unknown }>>(Prisma.sql`
    EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, FORMAT JSON)
    SELECT conversation.id, conversation.title,
      COUNT(DISTINCT participant.id) AS participant_count,
      MAX(message."sentAt") AS last_message_at
    FROM "Conversation" AS conversation
    LEFT JOIN "ConversationParticipant" AS participant
      ON participant."conversationId" = conversation.id
      AND participant."archiveId" = conversation."archiveId"
    LEFT JOIN "Message" AS message
      ON message."conversationId" = conversation.id
      AND message."archiveId" = conversation."archiveId"
    WHERE conversation."archiveId" = ${archiveId}::uuid
    GROUP BY conversation.id
    ORDER BY conversation."createdAt" ASC, conversation.id ASC
    LIMIT 51
  `);
  return plan[0]?.["QUERY PLAN"] ?? null;
};

const planSummary = (plan: unknown): Record<string, unknown> | null => {
  if (!Array.isArray(plan) || !plan[0] || typeof plan[0] !== "object") return null;
  const root = plan[0] as Record<string, unknown>;
  const planNode = root["Plan"];
  if (!planNode || typeof planNode !== "object") return null;
  const nodes: Array<Record<string, unknown>> = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    nodes.push(record);
    if (Array.isArray(record["Plans"])) record["Plans"].forEach(visit);
  };
  visit(planNode);
  return {
    nodeTypes: nodes
      .map((node) => node["Node Type"])
      .filter((value): value is string => typeof value === "string"),
    indexes: nodes
      .map((node) => node["Index Name"])
      .filter((value): value is string => typeof value === "string"),
    actualTotalTimeMs: root["Execution Time"] ?? null,
    sharedHitBlocks: nodes.reduce(
      (total, node) =>
        total + (typeof node["Shared Hit Blocks"] === "number" ? node["Shared Hit Blocks"] : 0),
      0,
    ),
    sharedReadBlocks: nodes.reduce(
      (total, node) =>
        total + (typeof node["Shared Read Blocks"] === "number" ? node["Shared Read Blocks"] : 0),
      0,
    ),
  };
};

const main = async (): Promise<void> => {
  const config = options();
  const metadataClient = new PrismaClient({ datasourceUrl: config.databaseUrl });
  await metadataClient.$connect();
  try {
    const [database, corpusCounts, archives] = await Promise.all([
      metadataClient.$queryRaw<Array<Record<string, string>>>(Prisma.sql`
        SELECT current_database() AS database, version() AS version,
          current_setting('server_version') AS server_version,
          current_setting('shared_buffers') AS shared_buffers,
          current_setting('work_mem') AS work_mem
      `),
      metadataClient.$queryRaw<
        Array<{
          messages: bigint;
          attachments: bigint;
          attachment_links: bigint;
          conversations: bigint;
          archives: bigint;
        }>
      >(Prisma.sql`
        SELECT
          (SELECT COUNT(*) FROM "Message") AS messages,
          (SELECT COUNT(*) FROM "Attachment") AS attachments,
          (SELECT COUNT(*) FROM "MessageAttachment") AS attachment_links,
          (SELECT COUNT(*) FROM "Conversation") AS conversations,
          (SELECT COUNT(DISTINCT "archiveId") FROM "Message") AS archives
      `),
      metadataClient.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "archiveId"::text AS id
        FROM "Message"
        GROUP BY "archiveId"
        ORDER BY COUNT(*) DESC, "archiveId"
        LIMIT 1
      `),
    ]);
    const archiveId = archives[0]?.id;
    if (!archiveId)
      throw new Error(
        "No archive-scoped messages found; load the synthetic corpus before benchmarking",
      );
    const counts = corpusCounts[0];
    if (!counts) throw new Error("Could not read corpus counts");
    const cases: BenchmarkCase[] = [
      { id: "conversation-first-page", kind: "conversation-list" },
      { id: "search-common-term", kind: "search", query: config.searchTerm },
      {
        id: "search-date-window",
        kind: "search",
        query: config.searchTerm,
        from: "2020-01-01T00:00:00.000Z",
        to: "2021-01-01T00:00:00.000Z",
      },
      { id: "search-fuzzy-body", kind: "fuzzy-search", fuzzyText: config.searchTerm },
    ];
    const targetScale =
      toNumber(counts.messages) >= config.expectedMessages &&
      toNumber(counts.attachments) >= config.expectedAttachments;
    const measurements: Record<
      string,
      {
        coldSession: Stats;
        warm: Stats;
        meetsWarmTarget: boolean;
        explain: Record<string, unknown> | null;
      }
    > = {};
    for (const item of cases) {
      const cold: number[] = [];
      for (let index = 0; index < config.coldIterations; index += 1) {
        const client = new PrismaClient({ datasourceUrl: config.databaseUrl });
        await client.$connect();
        try {
          cold.push(
            await measure(() =>
              runCase(
                new ArchiveReadService(
                  new PrismaReadPersistence(client),
                  new CursorCodec("benchmark-only-secret"),
                ),
                archiveId,
                item,
              ),
            ),
          );
        } finally {
          await client.$disconnect();
        }
      }
      const warmClient = new PrismaClient({ datasourceUrl: config.databaseUrl });
      await warmClient.$connect();
      try {
        const service = new ArchiveReadService(
          new PrismaReadPersistence(warmClient),
          new CursorCodec("benchmark-only-secret"),
        );
        for (let index = 0; index < config.warmup; index += 1)
          await runCase(service, archiveId, item);
        const warm: number[] = [];
        for (let index = 0; index < config.iterations; index += 1)
          warm.push(await measure(() => runCase(service, archiveId, item)));
        const explain =
          item.kind === "conversation-list"
            ? await explainConversationList(warmClient, archiveId)
            : await explainSearch(warmClient, archiveId, item);
        const warmStats = statistics(warm);
        measurements[queryName(item)] = {
          coldSession: statistics(cold),
          warm: warmStats,
          meetsWarmTarget: warmStats.p95Ms <= 2000,
          explain: planSummary(explain),
        };
      } finally {
        await warmClient.$disconnect();
      }
    }
    const allWarmQueriesWithinTarget = Object.values(measurements).every(
      (measurement) => measurement.meetsWarmTarget,
    );
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      gitCommit: commandValue("git", ["rev-parse", "HEAD"]) ?? "unknown",
      command: `pnpm benchmark:reads -- --seed ${config.seed}`,
      corpus: {
        seed: config.seed,
        expectedMessages: config.expectedMessages,
        expectedAttachments: config.expectedAttachments,
        messages: toNumber(counts.messages),
        attachments: toNumber(counts.attachments),
        attachmentLinks: toNumber(counts.attachment_links),
        conversations: toNumber(counts.conversations),
        archives: toNumber(counts.archives),
        generatorDistributionChecksum: corpusDistribution({
          seed: config.seed,
          messages: config.expectedMessages,
          attachments: config.expectedAttachments,
          archives: FULL_CORPUS.archives,
        }),
        targetScale,
      },
      environment: {
        node: process.version,
        prismaClient: Prisma.prismaVersion.client,
        platform: `${process.platform} ${os.release()}`,
        arch: process.arch,
        cpuModel: os.cpus()[0]?.model ?? "unknown",
        cpuCores: os.cpus().length,
        memoryBytes: os.totalmem(),
        storageFilesystem: commandValue("stat", ["-f", "-c", "%T", process.cwd()]) ?? "unknown",
        containerMemoryLimit: await cgroupValue("memory.max"),
        containerCpuLimit: await cgroupValue("cpu.max"),
        postgres: database[0] ?? {},
      },
      conditions: {
        cold: "new Prisma client/session per sample; timer starts after connect; PostgreSQL and OS buffer caches are not flushed",
        warm: `${config.warmup} excluded warm-up calls followed by ${config.iterations} calls on one Prisma client`,
        pageLimit: 50,
        coldIterations: config.coldIterations,
        warmup: config.warmup,
        iterations: config.iterations,
      },
      target: {
        p95Milliseconds: 2000,
        eligible: targetScale,
        allWarmQueriesWithinTarget,
        accepted: targetScale && allWarmQueriesWithinTarget,
      },
      queries: measurements,
    };
    const output = resolve(config.output);
    await mkdir(resolve(output, ".."), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(
      JSON.stringify({
        output,
        targetScale,
        corpus: report.corpus,
        queries: Object.fromEntries(
          Object.entries(measurements).map(([id, value]) => [id, value.warm]),
        ),
      }),
    );
  } finally {
    await metadataClient.$disconnect();
  }
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
