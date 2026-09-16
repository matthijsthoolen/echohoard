import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import {
  LeaseFenceError,
  type ImportJob,
  type ImportJobId,
  type LeaseId,
  type LeasePort,
} from "../../application/echohoard.js";
import type { JobFailureClass, JobStorePort } from "../../application/intake.js";

const JOB_STATUSES = [
  "queued",
  "leased",
  "decrypting",
  "adapting",
  "importing",
  "finalizing",
  "completed",
  "failed",
] as const;
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
        archiveId: true,
        ownedAccountId: true,
        sourceId: true,
        snapshotId: true,
        status: true,
        leaseId: true,
        retryable: true,
        updatedAt: true,
        snapshot: { select: { capturedAt: true } },
      },
    });
    return row ? toImportJob(row) : null;
  }

  public async listEligible(limit: number): Promise<readonly ImportJobId[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = await this.prisma.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
      SELECT id
        FROM "ImportJob"
       WHERE (
         status = 'queued'
         OR (status = 'failed' AND COALESCE(retryable, false) = true)
       )
         AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= clock_timestamp())
       ORDER BY "createdAt" ASC, id ASC
       LIMIT ${boundedLimit}
    `);
    return rows.map((row) => row.id);
  }

  public async markLeased(jobId: ImportJobId, lease: LeaseId): Promise<void> {
    await this.transition(
      jobId,
      lease,
      ["queued", "failed"],
      "leased",
      Prisma.sql`"startedAt" = database_clock.now`,
      true,
      "job lease state changed before start",
    );
  }

  public async markDecrypting(jobId: ImportJobId, lease: LeaseId): Promise<void> {
    await this.transition(
      jobId,
      lease,
      ["leased"],
      "decrypting",
      Prisma.sql`"startedAt" = database_clock.now`,
      false,
      "job lease state changed during decryption",
    );
  }

  public async markAdapting(jobId: ImportJobId, lease: LeaseId): Promise<void> {
    await this.transition(
      jobId,
      lease,
      ["decrypting"],
      "adapting",
      Prisma.empty,
      false,
      "job state changed before adaptation",
    );
  }

  public async markImporting(
    jobId: ImportJobId,
    lease: LeaseId,
    adapterVersion: string,
  ): Promise<void> {
    await this.transition(
      jobId,
      lease,
      ["adapting"],
      "importing",
      Prisma.sql`"adapterVersion" = ${adapterVersion}`,
      false,
      "job state changed before import",
    );
  }

  public async markFinalizing(jobId: ImportJobId, lease: LeaseId): Promise<void> {
    await this.transition(
      jobId,
      lease,
      ["importing"],
      "finalizing",
      Prisma.empty,
      false,
      "job state changed before finalization",
    );
  }

  public async markCompleted(jobId: ImportJobId, lease: LeaseId): Promise<void> {
    await this.transition(
      jobId,
      lease,
      ["decrypting", "finalizing"],
      "completed",
      Prisma.sql`
        "finishedAt" = database_clock.now,
        "retryable" = false,
        "leaseId" = NULL,
        "leaseOwner" = NULL,
        "leaseExpiresAt" = NULL
      `,
      false,
      "job completion state changed unexpectedly",
    );
  }

  public async markFailed(
    jobId: ImportJobId,
    lease: LeaseId,
    failure: {
      readonly class: JobFailureClass;
      readonly retryable: boolean;
      readonly diagnostic: string;
    },
  ): Promise<void> {
    await this.transition(
      jobId,
      lease,
      ["leased", "decrypting", "adapting", "importing", "finalizing"],
      "failed",
      Prisma.sql`
          "errorClass" = ${failure.class},
          "retryable" = ${failure.retryable},
          "outcome" = CAST(${JSON.stringify({ diagnostic: failure.diagnostic })} AS jsonb),
          "finishedAt" = database_clock.now,
          "leaseId" = NULL,
          "leaseOwner" = NULL,
          "leaseExpiresAt" = NULL
        `,
      false,
      "job failure state changed unexpectedly",
    );
  }

  private async transition(
    jobId: ImportJobId,
    lease: LeaseId,
    from: readonly PersistedJobStatus[],
    to: PersistedJobStatus,
    assignments: Prisma.Sql,
    allowRetryableFailed: boolean,
    message: string,
  ): Promise<void> {
    const result = await this.prisma.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
      WITH database_clock AS (SELECT clock_timestamp() AS now)
      UPDATE "ImportJob" AS job
         SET "status" = ${to},
             ${assignments}${assignments.sql.length > 0 ? Prisma.sql`,` : Prisma.empty}
             "updatedAt" = database_clock.now
        FROM database_clock
       WHERE job.id = CAST(${jobId} AS uuid)
         AND job."leaseId" = ${lease}
         AND job."leaseExpiresAt" > database_clock.now
         AND job.status IN (${Prisma.join(from.map((status) => Prisma.sql`${status}`))})
         AND (${allowRetryableFailed ? Prisma.sql`job.status <> 'failed' OR COALESCE(job.retryable, false) = true` : Prisma.sql`true`})
       RETURNING job.id
    `);
    if (result.length !== 1) throw new LeaseFenceError(message);
  }
}

/** Atomic database lease implementation. A worker can only proceed after the
 * conditional UPDATE returns its newly generated lease id. */
export class PrismaImportJobLeases implements LeasePort {
  public constructor(private readonly prisma: PrismaClient) {}

  public async acquire(
    jobId: ImportJobId,
    owner: string,
    durationMilliseconds: number,
  ): Promise<LeaseId | null> {
    const duration = validDuration(durationMilliseconds);
    const leaseId = randomUUID();
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH database_clock AS (SELECT clock_timestamp() AS now)
      UPDATE "ImportJob" AS job
         SET "leaseId" = ${leaseId},
             "leaseOwner" = ${owner},
             "leaseExpiresAt" = database_clock.now + (${duration} * INTERVAL '1 millisecond'),
             "updatedAt" = database_clock.now
        FROM database_clock
       WHERE job.id = CAST(${jobId} AS uuid)
         AND (
           job.status = 'queued'
           OR (job.status = 'failed' AND COALESCE(job.retryable, false) = true)
         )
         AND (job."leaseExpiresAt" IS NULL OR job."leaseExpiresAt" <= database_clock.now)
       RETURNING job.id
    `);
    return rows.length === 1 ? leaseId : null;
  }

  public async renew(leaseId: LeaseId, durationMilliseconds: number): Promise<boolean> {
    const duration = validDuration(durationMilliseconds);
    const rows = await this.prisma.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
      WITH database_clock AS (SELECT clock_timestamp() AS now)
      UPDATE "ImportJob" AS job
         SET "leaseExpiresAt" = database_clock.now + (${duration} * INTERVAL '1 millisecond'),
             "updatedAt" = database_clock.now
        FROM database_clock
       WHERE job."leaseId" = ${leaseId}
         AND job.status IN ('leased', 'decrypting', 'adapting', 'importing', 'finalizing')
         AND job."leaseExpiresAt" > database_clock.now
       RETURNING job.id
    `);
    return rows.length === 1;
  }

  public async release(leaseId: LeaseId): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      WITH database_clock AS (SELECT clock_timestamp() AS now)
      UPDATE "ImportJob" AS job
         SET "leaseId" = NULL,
             "leaseOwner" = NULL,
             "leaseExpiresAt" = NULL,
             "updatedAt" = database_clock.now
        FROM database_clock
       WHERE job."leaseId" = ${leaseId}
         AND job."leaseExpiresAt" > database_clock.now
    `);
  }

  public async recoverExpired(): Promise<
    readonly { readonly jobId: ImportJobId; readonly leaseId: LeaseId }[]
  > {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; leaseId: string }>>(Prisma.sql`
      WITH database_clock AS (SELECT clock_timestamp() AS now),
      expired AS (
        SELECT id, "leaseId" AS old_lease_id
          FROM "ImportJob"
         CROSS JOIN database_clock
         WHERE status IN ('leased', 'decrypting', 'adapting', 'importing', 'finalizing')
           AND "leaseId" IS NOT NULL
           AND "leaseExpiresAt" IS NOT NULL
           AND "leaseExpiresAt" <= database_clock.now
          FOR UPDATE
      )
      UPDATE "ImportJob" AS job
         SET status = 'queued',
              "leaseId" = NULL,
              "leaseOwner" = NULL,
              "leaseExpiresAt" = NULL,
              "updatedAt" = database_clock.now
         FROM expired
         CROSS JOIN database_clock
        WHERE job.id = expired.id
       RETURNING job.id, expired.old_lease_id AS "leaseId"
    `);
    return rows.map((row) => ({ jobId: row.id, leaseId: row.leaseId }));
  }
}

function toImportJob(row: {
  id: string;
  archiveId: string;
  ownedAccountId: string;
  sourceId: string;
  snapshotId: string | null;
  status: string;
  leaseId: string | null;
  retryable: boolean | null;
  updatedAt: Date;
  snapshot: { capturedAt: Date } | null;
}): ImportJob | null {
  if (!JOB_STATUSES.includes(row.status as PersistedJobStatus)) return null;
  const status = row.status as ImportJob["status"];
  return {
    id: row.id,
    archiveId: row.archiveId,
    ownedAccountId: row.ownedAccountId,
    sourceId: row.sourceId,
    ...(row.snapshotId ? { snapshotId: row.snapshotId } : {}),
    status,
    ...(row.leaseId ? { lease: row.leaseId } : {}),
    ...(row.retryable !== null ? { retryable: row.retryable } : {}),
    ...(row.snapshot ? { observedAt: row.snapshot.capturedAt } : {}),
    updatedAt: row.updatedAt,
  };
}

function validDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("lease duration must be a positive safe integer");
  return value;
}
