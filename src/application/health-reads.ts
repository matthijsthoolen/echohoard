import {
  classifyHealth,
  DEFAULT_HEALTH_THRESHOLDS,
  type HealthDiagnosticInput,
  type HealthResult,
  type HealthThresholds,
  type HealthState,
  type FreshnessState,
} from "../domain/health.js";

/** The largest job history exposed by a health response. Health is a bounded
 * read and must not become an unbounded import-log endpoint. */
export const MAX_HEALTH_JOBS = 20;

export interface HealthReadQuery {
  readonly archiveId: string;
}

export type HealthSnapshotLifecycle = "completed" | "failed" | "in-progress" | "discovered";

export interface HealthSnapshotPersistenceRow {
  readonly id: string;
  readonly lifecycle: string;
  readonly capturedAt: Date;
  readonly completedAt?: Date;
}

export interface HealthJobPersistenceRow {
  readonly id: string;
  readonly status: string;
  readonly startedAt?: Date;
  readonly finishedAt?: Date;
  readonly createdAt: Date;
  readonly errorClass?: string;
}

export interface HealthPersistenceEvidence {
  readonly latestDiscoveredSnapshot?: HealthSnapshotPersistenceRow;
  readonly latestCompletedSnapshot?: HealthSnapshotPersistenceRow;
  readonly latestMessageAt?: Date;
  readonly jobs: readonly HealthJobPersistenceRow[];
  readonly counts: {
    readonly messages: number;
    readonly conversations: number;
    readonly people: number;
  };
  readonly media: {
    readonly referenced: number;
    readonly available: number;
    readonly missing: number;
    readonly unsafe: number;
    readonly unresolved: number;
  };
  readonly unsupportedTypes: readonly { readonly type: string; readonly count: number }[];
}

export interface HealthReadPersistencePort {
  getHealthEvidence(input: {
    readonly archiveId: string;
    readonly jobLimit: number;
  }): Promise<HealthPersistenceEvidence>;
}

export type HealthJobStatus = "completed" | "failed" | "in-progress";

export interface HealthJobRead {
  readonly id: string;
  readonly status: HealthJobStatus;
  readonly phase?: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly durationMilliseconds?: number;
}

export interface HealthSnapshotRead {
  readonly id: string;
  readonly lifecycle: HealthSnapshotLifecycle;
  readonly capturedAt: string;
  readonly completedAt?: string;
}

export interface ArchiveHealthRead {
  readonly archiveId: string;
  readonly state: HealthState;
  readonly freshness: FreshnessState;
  readonly snapshots: {
    readonly latestDiscovered?: HealthSnapshotRead;
    readonly latestCompleted?: HealthSnapshotRead;
  };
  readonly latestMessageAt?: string;
  readonly currentJob?: HealthJobRead;
  readonly lastJob?: HealthJobRead;
  readonly jobs: readonly HealthJobRead[];
  readonly counts: {
    readonly messages: number;
    readonly conversations: number;
    readonly people: number;
    readonly mediaReferenced: number;
    readonly mediaAvailable: number;
    readonly unsupported: number;
  };
  readonly media: {
    readonly referenced: number;
    readonly available: number;
    readonly missing: number;
    readonly unsafe: number;
    readonly unresolved: number;
  };
  readonly unsupportedTypes: readonly { readonly type: string; readonly count: number }[];
  /** Sanitized, stable diagnostics; source error text never crosses this port. */
  readonly failures: HealthResult["diagnostics"];
}

export interface ArchiveHealthServiceOptions {
  readonly now?: () => Date;
  readonly thresholds?: HealthThresholds;
  readonly maxJobs?: number;
}

export class ArchiveHealthService {
  private readonly now: () => Date;
  private readonly thresholds: HealthThresholds;
  private readonly maxJobs: number;

  public constructor(
    private readonly persistence: HealthReadPersistencePort,
    options: ArchiveHealthServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.thresholds = options.thresholds ?? DEFAULT_HEALTH_THRESHOLDS;
    this.maxJobs = Math.min(options.maxJobs ?? MAX_HEALTH_JOBS, MAX_HEALTH_JOBS);
    if (!Number.isSafeInteger(this.maxJobs) || this.maxJobs < 1)
      throw new RangeError("maxJobs must be a positive integer");
  }

  public async getArchiveHealth(query: HealthReadQuery): Promise<ArchiveHealthRead> {
    if (!query.archiveId.trim()) throw new Error("archiveId is required");
    const evidence = await this.persistence.getHealthEvidence({
      archiveId: query.archiveId,
      jobLimit: this.maxJobs,
    });
    const jobs = evidence.jobs.slice(0, this.maxJobs).map((job) => toJobRead(job, this.now()));
    const latestJob = jobs[0];
    const importStatus = latestJob?.status ?? "idle";
    const diagnostics = sanitizeFailureDiagnostics(evidence.jobs);
    const classification = classifyHealth(
      {
        now: this.now(),
        latestCompletedSnapshotAt: evidence.latestCompletedSnapshot?.completedAt,
        importStatus,
        messageCount: evidence.counts.messages,
        mediaReferencedCount: evidence.media.referenced,
        mediaAvailableCount: evidence.media.available,
        unsupportedCount: evidence.unsupportedTypes.reduce((total, item) => total + item.count, 0),
        diagnostics,
      },
      this.thresholds,
    );
    return {
      archiveId: query.archiveId,
      state: classification.state,
      freshness: classification.freshness,
      snapshots: {
        ...(evidence.latestDiscoveredSnapshot
          ? { latestDiscovered: toSnapshotRead(evidence.latestDiscoveredSnapshot) }
          : {}),
        ...(evidence.latestCompletedSnapshot
          ? { latestCompleted: toSnapshotRead(evidence.latestCompletedSnapshot) }
          : {}),
      },
      ...(evidence.latestMessageAt
        ? { latestMessageAt: evidence.latestMessageAt.toISOString() }
        : {}),
      ...(jobs.find((job) => job.status === "in-progress")
        ? { currentJob: jobs.find((job) => job.status === "in-progress") }
        : {}),
      ...(latestJob ? { lastJob: latestJob } : {}),
      jobs,
      counts: {
        messages: classification.counts.messages,
        conversations: safeCount(evidence.counts.conversations),
        people: safeCount(evidence.counts.people),
        mediaReferenced: classification.counts.mediaReferenced,
        mediaAvailable: classification.counts.mediaAvailable,
        unsupported: classification.counts.unsupported,
      },
      media: {
        referenced: classification.counts.mediaReferenced,
        available: classification.counts.mediaAvailable,
        missing: safeCount(evidence.media.missing),
        unsafe: safeCount(evidence.media.unsafe),
        unresolved: safeCount(evidence.media.unresolved),
      },
      unsupportedTypes: evidence.unsupportedTypes
        .map((item) => ({ type: sanitizeType(item.type), count: safeCount(item.count) }))
        .filter((item) => item.count > 0),
      failures: classification.diagnostics,
    };
  }

  /** Short alias for delivery adapters and future MCP status mapping. */
  public getHealth(query: HealthReadQuery): Promise<ArchiveHealthRead> {
    return this.getArchiveHealth(query);
  }
}

function toSnapshotRead(row: HealthSnapshotPersistenceRow): HealthSnapshotRead {
  return {
    id: row.id,
    lifecycle: snapshotLifecycle(row.lifecycle),
    capturedAt: row.capturedAt.toISOString(),
    ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
  };
}

function toJobRead(row: HealthJobPersistenceRow, now: Date): HealthJobRead {
  const status = jobStatus(row.status);
  const start = row.startedAt?.getTime();
  const end = row.finishedAt?.getTime() ?? (status === "in-progress" ? now.getTime() : undefined);
  const durationMilliseconds =
    start !== undefined && end !== undefined && end >= start ? end - start : undefined;
  return {
    id: row.id,
    status,
    ...(safePhase(row.status) ? { phase: safePhase(row.status) } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
    ...(row.finishedAt ? { finishedAt: row.finishedAt.toISOString() } : {}),
    ...(durationMilliseconds !== undefined ? { durationMilliseconds } : {}),
  };
}

function jobStatus(status: string): HealthJobStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "in-progress";
}

function safePhase(status: string): string | undefined {
  return ["queued", "leased", "decrypting"].includes(status) ? status : undefined;
}

function snapshotLifecycle(lifecycle: string): HealthSnapshotLifecycle {
  if (lifecycle === "completed") return "completed";
  if (lifecycle === "failed") return "failed";
  if (["pending", "ready", "snapshotted"].includes(lifecycle)) return "discovered";
  return "discovered";
}

function sanitizeFailureDiagnostics(
  jobs: readonly HealthJobPersistenceRow[],
): readonly HealthDiagnosticInput[] {
  const failed = jobs.find((job) => job.status === "failed");
  if (!failed) return [];
  return [{ code: failureCode(failed.errorClass) }];
}

function failureCode(errorClass: string | undefined): string {
  const value = (errorClass ?? "").toLowerCase();
  if (value.includes("key")) return "INVALID_KEY";
  if (value.includes("unsupported") || value.includes("schema") || value.includes("format"))
    return "UNSUPPORTED_SCHEMA";
  if (value.includes("corrupt") || value.includes("integrity")) return "CORRUPT_SOURCE";
  if (value.includes("io") || value.includes("read") || value.includes("write"))
    return "IO_FAILURE";
  return "IMPORT_FAILURE";
}

function sanitizeType(value: string): string {
  return /^[a-zA-Z0-9_.:-]{1,80}$/u.test(value) ? value : "unknown";
}

function safeCount(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER) : 0;
}
