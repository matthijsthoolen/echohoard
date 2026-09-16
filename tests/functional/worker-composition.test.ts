import { PrismaClient } from "@prisma/client";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DecryptJobRunner,
  type JobStorePort,
  type SnapshotAdapterPort,
} from "../../src/application/intake.js";
import type { ImportRecord, TextSnapshotImporter } from "../../src/application/text-import.js";
import {
  PrismaDecryptJobStore,
  PrismaImportJobLeases,
} from "../../src/infrastructure/db/worker-persistence.js";
import { PrismaTextSnapshotImporter } from "../../src/infrastructure/db/text-import.js";
import { LocalJobWork } from "../../src/infrastructure/files/index.js";
import { createFixtureOwnedAccount } from "./owned-account-fixture.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const now = new Date("2026-01-01T00:00:00.000Z");
const userId = randomUUID();
const archiveId = randomUUID();
const sourceId = randomUUID();
const snapshotId = randomUUID();
const jobId = randomUUID();
const staleJobId = randomUUID();
const failedJobId = randomUUID();
let workRoot = "";
let ownedAccountId = "";

describe("PostgreSQL worker job composition", () => {
  beforeAll(async () => {
    await prisma.$connect();
    workRoot = await mkdtemp(join(tmpdir(), "echohoard-worker-"));
    await prisma.user.create({ data: { id: userId } });
    await prisma.archive.create({ data: { id: archiveId, userId, name: "worker fixture" } });
    ownedAccountId = await createFixtureOwnedAccount(prisma, archiveId);
    await prisma.source.create({
      data: {
        id: sourceId,
        archiveId,
        ownedAccountId,
        kind: "whatsapp",
        stableKey: "worker-fixture",
        sha256: "a".repeat(64),
      },
    });
    await prisma.snapshot.create({
      data: {
        id: snapshotId,
        archiveId,
        ownedAccountId,
        sourceId,
        sha256: "b".repeat(64),
        lifecycle: "ready",
      },
    });
    await prisma.importJob.createMany({
      data: [
        { id: jobId, archiveId, ownedAccountId, sourceId, snapshotId, status: "queued" },
        { id: staleJobId, archiveId, ownedAccountId, sourceId, snapshotId, status: "leased" },
        { id: failedJobId, archiveId, ownedAccountId, sourceId, snapshotId, status: "queued" },
      ],
    });
    await prisma.importJob.update({
      where: { id: staleJobId },
      data: {
        leaseId: randomUUID(),
        leaseOwner: "old-worker",
        leaseExpiresAt: new Date(now.getTime() - 1_000),
      },
    });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    if (workRoot) await rm(workRoot, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  it("claims and processes a queued job exactly once", async () => {
    const jobs = new PrismaDecryptJobStore(prisma);
    const leases = new PrismaImportJobLeases(prisma);
    let decryptCalls = 0;
    const runner = new DecryptJobRunner(
      jobs,
      leases,
      new LocalJobWork(workRoot),
      { path: async () => "/synthetic/snapshot/msgstore.db.crypt15" },
      {
        decrypt: async () => {
          decryptCalls += 1;
          return { outputPath: "/synthetic/work/msgstore.db" };
        },
      },
      { now: () => now, sleep: async () => {} },
      {
        owner: "functional-worker",
        leaseDurationMilliseconds: 10_000,
        heartbeatMilliseconds: 1_000,
        decryptTimeoutMilliseconds: 5_000,
      },
    );

    await expect(runner.run(jobId)).resolves.toBe(true);
    await expect(runner.run(jobId)).resolves.toBe(false);
    expect(decryptCalls).toBe(1);
    await expect(prisma.importJob.findUnique({ where: { id: jobId } })).resolves.toMatchObject({
      status: "completed",
      leaseId: null,
    });
  });

  it("recovers an expired lease before requeueing", async () => {
    const jobs = new PrismaDecryptJobStore(prisma);
    const leases = new PrismaImportJobLeases(prisma);
    await expect(leases.recoverExpired(now)).resolves.toContain(staleJobId);
    await jobs.requeue(staleJobId, now);
    await expect(prisma.importJob.findUnique({ where: { id: staleJobId } })).resolves.toMatchObject(
      {
        status: "queued",
        leaseId: null,
        leaseOwner: null,
      },
    );
  });

  it("records an invalid-key failure using only the sanitized classification", async () => {
    const jobs = new PrismaDecryptJobStore(prisma);
    const leases = new PrismaImportJobLeases(prisma);
    const runner = new DecryptJobRunner(
      jobs,
      leases,
      new LocalJobWork(workRoot),
      { path: async () => "/synthetic/snapshot/msgstore.db.crypt15" },
      {
        decrypt: async () => {
          const error = Object.assign(new Error("key=synthetic-secret /private/source"), {
            kind: "invalid-key",
          });
          throw error;
        },
      },
      { now: () => now, sleep: async () => {} },
      {
        owner: "functional-worker",
        leaseDurationMilliseconds: 10_000,
        heartbeatMilliseconds: 1_000,
        decryptTimeoutMilliseconds: 5_000,
      },
    );

    await expect(runner.run(failedJobId)).resolves.toBe(false);
    const row = await prisma.importJob.findUnique({ where: { id: failedJobId } });
    expect(row).toMatchObject({ status: "failed", errorClass: "invalid-key", retryable: false });
    expect(JSON.stringify(row?.outcome)).toBe(
      JSON.stringify({ diagnostic: "decryption terminal failure (invalid-key)" }),
    );
    expect(JSON.stringify(row?.outcome)).not.toMatch(/synthetic-secret|private\/source/);
    await expect(prisma.snapshot.findUnique({ where: { id: snapshotId } })).resolves.toMatchObject({
      lifecycle: "ready",
      completedAt: null,
    });
    expect(await readdir(workRoot)).toEqual([]);
  });

  it("adapts and imports normalized records before finalizing the snapshot", async () => {
    const seeded = await seedPipelineJob("success");
    const records = pipelineRecords(seeded.snapshotId);
    const adapter: SnapshotAdapterPort = {
      adapt: async () => ({ adapterVersion: "synthetic-whatsapp.v1", records }),
    };
    const runner = createPipelineRunner(
      seeded.jobId,
      adapter,
      new PrismaTextSnapshotImporter(prisma),
    );

    await expect(runner.run(seeded.jobId)).resolves.toBe(true);
    await expect(
      prisma.importJob.findUnique({ where: { id: seeded.jobId } }),
    ).resolves.toMatchObject({
      status: "completed",
      adapterVersion: "synthetic-whatsapp.v1",
      retryable: false,
    });
    await expect(
      prisma.snapshot.findUnique({ where: { id: seeded.snapshotId } }),
    ).resolves.toMatchObject({
      lifecycle: "completed",
    });
    expect(
      await prisma.message.count({ where: { archiveId, stableKey: "worker-pipeline-message" } }),
    ).toBe(1);
    expect(await readdir(workRoot)).toEqual([]);
  });

  it("keeps unsupported adaptation terminal and preserves the source snapshot", async () => {
    const seeded = await seedPipelineJob("adaptation");
    const adapter: SnapshotAdapterPort = {
      adapt: async () =>
        Promise.reject(Object.assign(new Error("table details"), { kind: "unsupported-format" })),
    };
    const importer: TextSnapshotImporter = { import: async () => ({ imported: 0 }) };
    const runner = createPipelineRunner(seeded.jobId, adapter, importer);

    await expect(runner.run(seeded.jobId)).resolves.toBe(false);
    await expect(
      prisma.importJob.findUnique({ where: { id: seeded.jobId } }),
    ).resolves.toMatchObject({
      status: "failed",
      errorClass: "unsupported-format",
      retryable: false,
      outcome: { diagnostic: "adaptation terminal failure (unsupported-format)" },
    });
    await expect(
      prisma.snapshot.findUnique({ where: { id: seeded.snapshotId } }),
    ).resolves.toMatchObject({
      lifecycle: "ready",
      completedAt: null,
    });
    expect(await readdir(workRoot)).toEqual([]);
  });

  it("rolls back an import failure and leaves the job retryable", async () => {
    const seeded = await seedPipelineJob("import");
    const adapter: SnapshotAdapterPort = {
      adapt: async () => ({
        adapterVersion: "synthetic-whatsapp.v1",
        records: [
          ...pipelineRecords(seeded.snapshotId),
          {
            kind: "message",
            stableKey: "worker-pipeline-invalid-message",
            source: { namespace: "whatsapp-android", value: "worker-invalid" },
            conversationKey: "worker-pipeline-conversation",
            timestamp: "not-a-date",
            direction: "received",
            messageKind: "text",
            body: "must roll back",
            bodyState: "present",
          },
        ],
      }),
    };
    const importer = new PrismaTextSnapshotImporter(prisma);
    const runner = createPipelineRunner(seeded.jobId, adapter, importer);

    await expect(runner.run(seeded.jobId)).resolves.toBe(false);
    await expect(
      prisma.importJob.findUnique({ where: { id: seeded.jobId } }),
    ).resolves.toMatchObject({
      status: "failed",
      errorClass: "internal",
      retryable: true,
      outcome: { diagnostic: "import retryable failure (internal)" },
    });
    expect(
      await prisma.message.count({ where: { archiveId, stableKey: "worker-pipeline-message" } }),
    ).toBe(1);
    expect(
      await prisma.message.count({
        where: { archiveId, stableKey: "worker-pipeline-invalid-message" },
      }),
    ).toBe(0);
    expect(await readdir(workRoot)).toEqual([]);
  });

  it("classifies a finalization transition failure and still cleans work", async () => {
    const seeded = await seedPipelineJob("finalization");
    const adapter: SnapshotAdapterPort = {
      adapt: async () => ({ adapterVersion: "synthetic-whatsapp.v1", records: [] }),
    };
    const importer: TextSnapshotImporter = { import: async () => ({ imported: 0 }) };
    const base = new PrismaDecryptJobStore(prisma);
    const jobs: JobStorePort = {
      get: base.get.bind(base),
      markLeased: base.markLeased.bind(base),
      markDecrypting: base.markDecrypting.bind(base),
      markAdapting: base.markAdapting.bind(base),
      markImporting: base.markImporting.bind(base),
      markFinalizing: async () =>
        Promise.reject(Object.assign(new Error("finalization details"), { kind: "internal" })),
      markCompleted: base.markCompleted.bind(base),
      markFailed: base.markFailed.bind(base),
      requeue: base.requeue.bind(base),
    };
    const runner = createPipelineRunner(seeded.jobId, adapter, importer, jobs);

    await expect(runner.run(seeded.jobId)).resolves.toBe(false);
    await expect(
      prisma.importJob.findUnique({ where: { id: seeded.jobId } }),
    ).resolves.toMatchObject({
      status: "failed",
      errorClass: "internal",
      retryable: true,
      outcome: { diagnostic: "finalization retryable failure (internal)" },
    });
    expect(await readdir(workRoot)).toEqual([]);
  });
});

async function seedPipelineJob(
  label: string,
): Promise<{ readonly jobId: string; readonly snapshotId: string }> {
  const sourceId = randomUUID();
  const snapshotId = randomUUID();
  const jobId = randomUUID();
  await prisma.source.create({
    data: {
      id: sourceId,
      archiveId,
      ownedAccountId,
      kind: "whatsapp",
      stableKey: `pipeline-${label}-${sourceId}`,
      sha256: "c".repeat(64),
    },
  });
  await prisma.snapshot.create({
    data: {
      id: snapshotId,
      archiveId,
      ownedAccountId,
      sourceId,
      sha256: "d".repeat(64),
      lifecycle: "ready",
    },
  });
  await prisma.importJob.create({
    data: { id: jobId, archiveId, ownedAccountId, sourceId, snapshotId, status: "queued" },
  });
  return { jobId, snapshotId };
}

function createPipelineRunner(
  jobId: string,
  adapter: SnapshotAdapterPort,
  importer: TextSnapshotImporter,
  jobs: JobStorePort = new PrismaDecryptJobStore(prisma),
): DecryptJobRunner {
  return new DecryptJobRunner(
    jobs,
    new PrismaImportJobLeases(prisma),
    new LocalJobWork(workRoot),
    { path: async () => "/synthetic/snapshot/msgstore.db.crypt15" },
    { decrypt: async () => ({ outputPath: "/synthetic/work/msgstore.db" }) },
    { now: () => now, sleep: async () => {} },
    {
      owner: "functional-worker",
      leaseDurationMilliseconds: 10_000,
      heartbeatMilliseconds: 1_000,
      decryptTimeoutMilliseconds: 5_000,
    },
    adapter,
    importer,
  );
}

function pipelineRecords(snapshotId: string): readonly ImportRecord[] {
  return [
    { kind: "person", stableKey: "worker-pipeline-person", displayName: "Synthetic Worker" },
    {
      kind: "identity",
      stableKey: "worker-pipeline-identity",
      personKey: "worker-pipeline-person",
      source: { namespace: "whatsapp-android", value: "worker@example" },
    },
    {
      kind: "conversation",
      stableKey: "worker-pipeline-conversation",
      source: { namespace: "whatsapp-android", value: "worker-chat" },
      conversationKind: "direct",
      title: "Synthetic Worker Chat",
    },
    {
      kind: "participant",
      conversationKey: "worker-pipeline-conversation",
      identityKey: "worker-pipeline-identity",
      role: "member",
    },
    {
      kind: "message",
      stableKey: "worker-pipeline-message",
      source: { namespace: "whatsapp-android", value: "worker-message" },
      conversationKey: "worker-pipeline-conversation",
      senderIdentityKey: "worker-pipeline-identity",
      timestamp: now.toISOString(),
      direction: "received",
      messageKind: "text",
      body: "synthetic worker message",
      bodyState: "present",
    },
    {
      kind: "revision",
      stableKey: "worker-pipeline-revision",
      messageKey: "worker-pipeline-message",
      revisionOrdinal: 1,
      body: "synthetic worker message",
      bodyState: "present",
      firstSeenSnapshotId: snapshotId,
    },
  ];
}
