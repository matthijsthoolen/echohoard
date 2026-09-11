import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { ImportJob, ImportJobId, LeaseId, LeasePort } from "../../application/echohoard.js";
import type { JobFailureClass, JobStorePort } from "../../application/intake.js";

const JOB_STATUSES = ["queued", "leased", "decrypting", "completed", "failed"] as const;
type PersistedJobStatus = (typeof JOB_STATUSES)[number];

/** PostgreSQL-backed queue state. The lease columns are deliberately kept on
 * ImportJob so claiming and lease recovery share one transactional row. */
export class PrismaDecryptJobStore implements JobStorePort {
  public constructor(private readonly prisma: PrismaClient) {}

  public async get(jobId: ImportJobId): Promise<ImportJob | null> {
    const row = await this.prisma.importJob.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        snapshotId: true,
        status: true,
        leaseId: true,
        retryable: true,
        updatedAt: true,
      },
    });
    return row ? toImportJob(row) : null;
  }

  public async listEligible(limit: number): Promise<readonly ImportJobId[]> {
    const availableLease = {
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date() } }],
    };
    const rows = await this.prisma.importJob.findMany({
      where: {
        OR: [
          { status: "queued", ...availableLease },
          { status: "failed", retryable: true, ...availableLease },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: Math.max(1, Math.min(100, Math.trunc(limit))),
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  public async markLeased(jobId: ImportJobId, lease: LeaseId, updatedAt: Date): Promise<void> {
    const result = await this.prisma.importJob.updateMany({
      where: { id: jobId, leaseId: lease, status: { in: ["queued", "failed"] } },
      data: { status: "leased", startedAt: updatedAt },
    });
    if (result.count !== 1) throw new Error("job lease state changed before start");
  }

  public async markDecrypting(jobId: ImportJobId, updatedAt: Date): Promise<void> {
    const result = await this.prisma.importJob.updateMany({
      where: { id: jobId, status: "leased" },
      data: { status: "decrypting", startedAt: updatedAt },
    });
    if (result.count !== 1) throw new Error("job lease state changed during decryption");
  }

  public async markCompleted(jobId: ImportJobId, updatedAt: Date): Promise<void> {
    const result = await this.prisma.importJob.updateMany({
      where: { id: jobId, status: "decrypting" },
      data: {
        status: "completed",
        finishedAt: updatedAt,
        retryable: false,
        leaseId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    if (result.count !== 1) throw new Error("job completion state changed unexpectedly");
  }

  public async markFailed(
    jobId: ImportJobId,
    failure: {
      readonly class: JobFailureClass;
      readonly retryable: boolean;
      readonly diagnostic: string;
    },
    updatedAt: Date,
  ): Promise<void> {
    const result = await this.prisma.importJob.updateMany({
      where: { id: jobId, status: { in: ["leased", "decrypting"] } },
      data: {
        status: "failed",
        errorClass: failure.class,
        retryable: failure.retryable,
        outcome: { diagnostic: failure.diagnostic },
        finishedAt: updatedAt,
        leaseId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    if (result.count !== 1) throw new Error("job failure state changed unexpectedly");
  }

  public async requeue(jobId: ImportJobId, updatedAt: Date): Promise<void> {
    await this.prisma.importJob.updateMany({
      where: { id: jobId, status: { in: ["leased", "decrypting"] } },
      data: {
        status: "queued",
        updatedAt,
        leaseId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
  }
}

/** Atomic database lease implementation. A worker can only proceed after the
 * conditional UPDATE returns its newly generated lease id. */
export class PrismaImportJobLeases implements LeasePort {
  public constructor(private readonly prisma: PrismaClient) {}

  public async acquire(
    jobId: ImportJobId,
    owner: string,
    expiresAt: Date,
  ): Promise<LeaseId | null> {
    const leaseId = randomUUID();
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE "ImportJob"
      SET "leaseId" = ${leaseId}, "leaseOwner" = ${owner}, "leaseExpiresAt" = ${expiresAt}
      WHERE id = CAST(${jobId} AS uuid)
        AND (
          status = 'queued'
          OR (status = 'failed' AND COALESCE(retryable, false) = true)
        )
        AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= CURRENT_TIMESTAMP)
      RETURNING id
    `);
    return rows.length === 1 ? leaseId : null;
  }

  public async renew(leaseId: LeaseId, expiresAt: Date): Promise<boolean> {
    const result = await this.prisma.importJob.updateMany({
      where: {
        leaseId,
        status: { in: ["leased", "decrypting"] },
        leaseExpiresAt: { gt: new Date() },
      },
      data: { leaseExpiresAt: expiresAt },
    });
    return result.count === 1;
  }

  public async release(leaseId: LeaseId): Promise<void> {
    await this.prisma.importJob.updateMany({
      where: { leaseId },
      data: { leaseId: null, leaseOwner: null, leaseExpiresAt: null },
    });
  }

  public async recoverExpired(now: Date): Promise<readonly ImportJobId[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE "ImportJob"
      SET "leaseId" = NULL,
          "leaseOwner" = NULL,
          "leaseExpiresAt" = NULL,
          "updatedAt" = ${now}
      WHERE status IN ('leased', 'decrypting')
        AND "leaseExpiresAt" IS NOT NULL
        AND "leaseExpiresAt" <= ${now}
      RETURNING id
    `);
    return rows.map((row) => row.id);
  }
}

function toImportJob(row: {
  id: string;
  snapshotId: string | null;
  status: string;
  leaseId: string | null;
  retryable: boolean | null;
  updatedAt: Date;
}): ImportJob | null {
  if (!JOB_STATUSES.includes(row.status as PersistedJobStatus)) return null;
  const status = row.status as ImportJob["status"];
  return {
    id: row.id,
    ...(row.snapshotId ? { snapshotId: row.snapshotId } : {}),
    status,
    ...(row.leaseId ? { lease: row.leaseId } : {}),
    ...(row.retryable !== null ? { retryable: row.retryable } : {}),
    updatedAt: row.updatedAt,
  };
}
