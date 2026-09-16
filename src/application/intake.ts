import type {
  ClockPort,
  DecryptPort,
  ImportJob,
  ImportJobId,
  LeaseId,
  LeasePort,
} from "./echohoard.js";
import type { ImportRecord, TextSnapshotImportInput, TextSnapshotImporter } from "./text-import.js";

export type JobFailureClass =
  | "io"
  | "invalid-key"
  | "corrupt-source"
  | "unsupported-format"
  | "timeout"
  | "internal";

export interface JobStorePort {
  get(jobId: ImportJobId): Promise<ImportJob | null>;
  /** Return a bounded batch of jobs which may be attempted by this worker. */
  listEligible?(limit: number): Promise<readonly ImportJobId[]>;
  markLeased(jobId: ImportJobId, lease: LeaseId, updatedAt: Date): Promise<void>;
  markDecrypting(jobId: ImportJobId, updatedAt: Date): Promise<void>;
  markAdapting(jobId: ImportJobId, updatedAt: Date): Promise<void>;
  markImporting(jobId: ImportJobId, adapterVersion: string, updatedAt: Date): Promise<void>;
  markFinalizing(jobId: ImportJobId, updatedAt: Date): Promise<void>;
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

export interface SnapshotAdapterPort {
  adapt(input: {
    readonly decryptedPath: string;
    readonly snapshotId: string;
    readonly accountScope: string;
  }): Promise<{
    readonly adapterVersion: string;
    readonly records: readonly ImportRecord[];
  }>;
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
    private readonly adapter?: SnapshotAdapterPort,
    private readonly importer?: TextSnapshotImporter,
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
    if (!job || (job.status !== "queued" && (job.status !== "failed" || job.retryable === false)))
      return false;
    const expiresAt = this.expiry();
    const lease = await this.leases.acquire(jobId, this.options.owner, expiresAt);
    if (!lease) return false;
    let workPath = "";
    let phase: "decryption" | "adaptation" | "import" | "finalization" = "decryption";
    const heartbeat = setInterval(() => {
      void this.leases.renew(lease, this.expiry());
    }, this.options.heartbeatMilliseconds);
    try {
      await this.jobs.markLeased(jobId, lease, this.clock.now());
      const prepared = await this.work.prepare(jobId);
      workPath = prepared.path;
      await this.jobs.markDecrypting(jobId, this.clock.now());
      if (!job.snapshotId) throw new Error("decryption job has no snapshot");
      const decrypted = await this.decrypt.decrypt(
        await this.snapshots.path(job.snapshotId),
        workPath,
        this.options.decryptTimeoutMilliseconds,
      );
      if (!this.adapter || !this.importer) {
        if (this.adapter || this.importer) throw new Error("worker import pipeline is incomplete");
        await this.jobs.markCompleted(jobId, this.clock.now());
        return true;
      }
      phase = "adaptation";
      await this.jobs.markAdapting(jobId, this.clock.now());
      if (!job.ownedAccountId) throw new Error("import job has no owned account");
      const adapted = await this.adapter.adapt({
        decryptedPath: decrypted.outputPath,
        snapshotId: job.snapshotId,
        accountScope: job.ownedAccountId,
      });
      phase = "import";
      await this.jobs.markImporting(jobId, adapted.adapterVersion, this.clock.now());
      phase = "finalization";
      await this.jobs.markFinalizing(jobId, this.clock.now());
      phase = "import";
      if (!job.archiveId || !job.sourceId)
        throw new Error("import job has incomplete archive scope");
      const input: TextSnapshotImportInput = {
        archiveId: job.archiveId,
        ownedAccountId: job.ownedAccountId,
        snapshotId: job.snapshotId,
        importJobId: job.id,
        observedAt: job.observedAt ?? this.clock.now(),
        records: adapted.records,
      };
      await this.importer.import(input);
      return true;
    } catch (error) {
      const failure = toFailure(error, phase);
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

function toFailure(
  error: unknown,
  phase: "decryption" | "adaptation" | "import" | "finalization",
): {
  readonly class: JobFailureClass;
  readonly retryable: boolean;
  readonly diagnostic: string;
} {
  const kind =
    typeof error === "object" && error !== null && "kind" in error && typeof error.kind === "string"
      ? error.kind
      : "internal";
  const reportedPhase =
    typeof error === "object" &&
    error !== null &&
    "phase" in error &&
    (error.phase === "decryption" ||
      error.phase === "adaptation" ||
      error.phase === "import" ||
      error.phase === "finalization")
      ? error.phase
      : phase;
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
    diagnostic: `${reportedPhase} ${retryable ? "retryable" : "terminal"} failure (${failureClass})`,
  };
}
