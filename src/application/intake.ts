import type {
  ClockPort,
  DecryptPort,
  ImportJob,
  ImportJobId,
  LeaseId,
  LeasePort,
} from "./echohoard.js";

export type JobFailureClass =
  | "io"
  | "invalid-key"
  | "corrupt-source"
  | "unsupported-format"
  | "timeout"
  | "internal";

export interface JobStorePort {
  get(jobId: ImportJobId): Promise<ImportJob | null>;
  markLeased(jobId: ImportJobId, lease: LeaseId, updatedAt: Date): Promise<void>;
  markDecrypting(jobId: ImportJobId, updatedAt: Date): Promise<void>;
  markCompleted(jobId: ImportJobId, updatedAt: Date): Promise<void>;
  markFailed(
    jobId: ImportJobId,
    failure: {
      readonly class: JobFailureClass;
      readonly retryable: boolean;
      readonly diagnostic: string;
    },
    updatedAt: Date,
  ): Promise<void>;
  requeue(jobId: ImportJobId, updatedAt: Date): Promise<void>;
}

export interface JobWorkPort {
  /** Creates an isolated directory. Implementations may remove an abandoned
   * directory and recreate it, but must never return another job's path. */
  prepare(jobId: ImportJobId): Promise<{ readonly path: string; readonly restarted: boolean }>;
  cleanup(jobId: ImportJobId, path: string): Promise<void>;
  cleanupStale(jobId: ImportJobId): Promise<void>;
}

export interface SnapshotPathPort {
  path(snapshotId: string): Promise<string>;
}

export interface DecryptJobRunnerOptions {
  readonly leaseDurationMilliseconds: number;
  readonly heartbeatMilliseconds: number;
  readonly decryptTimeoutMilliseconds: number;
  readonly owner: string;
}

export class DecryptJobRunner {
  public constructor(
    private readonly jobs: JobStorePort,
    private readonly leases: LeasePort,
    private readonly work: JobWorkPort,
    private readonly snapshots: SnapshotPathPort,
    private readonly decrypt: DecryptPort,
    private readonly clock: ClockPort,
    private readonly options: DecryptJobRunnerOptions,
  ) {}

  /** Requeues only jobs whose database lease has expired, cleaning their work
   * first. The database lease operation remains the source of truth. */
  public async recoverStaleJobs(): Promise<readonly ImportJobId[]> {
    const stale = await this.leases.recoverExpired(this.clock.now());
    for (const jobId of stale) {
      await this.work.cleanupStale(jobId);
      await this.jobs.requeue(jobId, this.clock.now());
    }
    return stale;
  }

  public async run(jobId: ImportJobId): Promise<boolean> {
    const job = await this.jobs.get(jobId);
    if (!job || (job.status !== "queued" && job.status !== "failed")) return false;
    const expiresAt = this.expiry();
    const lease = await this.leases.acquire(jobId, this.options.owner, expiresAt);
    if (!lease) return false;
    await this.jobs.markLeased(jobId, lease, this.clock.now());
    let workPath = "";
    const heartbeat = setInterval(() => {
      void this.leases.renew(lease, this.expiry());
    }, this.options.heartbeatMilliseconds);
    try {
      const prepared = await this.work.prepare(jobId);
      workPath = prepared.path;
      await this.jobs.markDecrypting(jobId, this.clock.now());
      if (!job.snapshotId) throw new Error("decryption job has no snapshot");
      await this.decrypt.decrypt(
        await this.snapshots.path(job.snapshotId),
        workPath,
        this.options.decryptTimeoutMilliseconds,
      );
      await this.jobs.markCompleted(jobId, this.clock.now());
      return true;
    } catch (error) {
      const failure = toFailure(error);
      await this.jobs.markFailed(jobId, failure, this.clock.now());
      return false;
    } finally {
      clearInterval(heartbeat);
      if (workPath) await this.work.cleanup(jobId, workPath);
      await this.leases.release(lease);
    }
  }

  private expiry(): Date {
    return new Date(this.clock.now().getTime() + this.options.leaseDurationMilliseconds);
  }
}

function toFailure(error: unknown): {
  readonly class: JobFailureClass;
  readonly retryable: boolean;
  readonly diagnostic: string;
} {
  const kind =
    typeof error === "object" && error !== null && "kind" in error && typeof error.kind === "string"
      ? error.kind
      : "internal";
  const valid: JobFailureClass[] = [
    "io",
    "invalid-key",
    "corrupt-source",
    "unsupported-format",
    "timeout",
    "internal",
  ];
  const failureClass = valid.includes(kind as JobFailureClass)
    ? (kind as JobFailureClass)
    : "internal";
  const retryable =
    failureClass === "io" || failureClass === "timeout" || failureClass === "internal";
  return {
    class: failureClass,
    retryable,
    diagnostic: `decryption ${retryable ? "retryable" : "terminal"} failure (${failureClass})`,
  };
}
