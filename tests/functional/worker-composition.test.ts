import { PrismaClient } from "@prisma/client";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DecryptJobRunner } from "../../src/application/intake.js";
import {
  PrismaDecryptJobStore,
  PrismaImportJobLeases,
} from "../../src/infrastructure/db/worker-persistence.js";
import { LocalJobWork } from "../../src/infrastructure/files/index.js";

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

describe("PostgreSQL worker job composition", () => {
  beforeAll(async () => {
    await prisma.$connect();
    workRoot = await mkdtemp(join(tmpdir(), "echohoard-worker-"));
    await prisma.user.create({ data: { id: userId } });
    await prisma.archive.create({ data: { id: archiveId, userId, name: "worker fixture" } });
    await prisma.source.create({
      data: {
        id: sourceId,
        archiveId,
        kind: "whatsapp",
        stableKey: "worker-fixture",
        sha256: "a".repeat(64),
      },
    });
    await prisma.snapshot.create({
      data: {
        id: snapshotId,
        archiveId,
        sourceId,
        sha256: "b".repeat(64),
        lifecycle: "ready",
      },
    });
    await prisma.importJob.createMany({
      data: [
        { id: jobId, archiveId, sourceId, snapshotId, status: "queued" },
        { id: staleJobId, archiveId, sourceId, snapshotId, status: "leased" },
        { id: failedJobId, archiveId, sourceId, snapshotId, status: "queued" },
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
  });
});
