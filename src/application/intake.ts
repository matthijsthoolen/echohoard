import { LeaseFenceError } from "./echohoard.js";
import type {
  ClockPort,
  DecryptPort,
  ImportJob,
  ImportJobId,
  LeaseId,
  LeasePort,
} from "./echohoard.js";
import type {
  ImportRecordSource,
  TextSnapshotImportInput,
  TextSnapshotImporter,
} from "./text-import.js";

export type JobFailureClass =
  | "io"
  | "invalid-key"
  | "corrupt-source"
  | "unsupported-format"
  | "timeout"
  | "resource-limit"
  | "internal";

export interface JobStorePort {
  get(jobId: ImportJobId): Promise<ImportJob | null>;
  /** Return a bounded batch of jobs which may be attempted by this worker. */
  listEligible?(limit: number): Promise<readonly ImportJobId[]>;
  markLeased(jobId: ImportJobId, lease: LeaseId, updatedAt: Date): Promise<void>;
  markDecrypting(jobId: ImportJobId, lease: LeaseId, updatedAt: Date): Promise<void>;
  markAdapting(jobId: ImportJobId, lease: LeaseId, updatedAt: Date): Promise<void>;
  markImporting(
    jobId: ImportJobId,
    lease: LeaseId,
    adapterVersion: string,
    updatedAt: Date,
  ): Promise<void>;
  markFinalizing(jobId: ImportJobId, lease: LeaseId, updatedAt: Date): Promise<void>;
  markCompleted(jobId: ImportJobId, lease: LeaseId, updatedAt: Date): Promise<void>;
  markFailed(
    jobId: ImportJobId,
    lease: LeaseId,
    failure: {
      readonly class: JobFailureClass;
      readonly retryable: boolean;
      readonly diagnostic: string;
    },
    updatedAt: Date,
  ): Promise<void>;
}

export interface JobWorkPort {
  /** Creates an isolated directory for this lease. A replacement lease must
   * never reuse a stale runner's work path. */
  prepare(
    jobId: ImportJobId,
    lease: LeaseId,
  ): Promise<{ readonly path: string; readonly restarted: boolean }>;
  cleanup(jobId: ImportJobId, lease: LeaseId, path: string): Promise<void>;
  cleanupStale(jobId: ImportJobId, lease: LeaseId): Promise<void>;
}

export interface SnapshotPathPort {
  path(snapshotId: string): Promise<string>;
}

export interface SnapshotAdapterPort {
  adapt(input: {
    readonly decryptedPath: string;
    /** Disposable lease-owned storage for bounded adapter spooling. */
    readonly workPath?: string;
    readonly snapshotId: string;
    readonly accountScope: string;
  }): Promise<{
    readonly adapterVersion: string;
    readonly records: ImportRecordSource;
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
  ) {
    if (options.heartbeatMilliseconds >= options.leaseDurationMilliseconds)
      throw new Error("worker heartbeat must be shorter than its lease duration");
  }

  /** Atomically requeues expired jobs, then removes only the expired lease's
   * work directory. The database lease operation remains authoritative. */
  public async recoverStaleJobs(): Promise<readonly ImportJobId[]> {
    const stale = await this.leases.recoverExpired(this.clock.now());
    for (const recovered of stale) {
      await this.work.cleanupStale(recovered.jobId, recovered.leaseId);
    }
    return stale.map(({ jobId }) => jobId);
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
    const monitor = new LeaseMonitor(this.leases, lease, this.clock, () => this.expiry());
    const heartbeat = setInterval(() => void monitor.renew(), this.options.heartbeatMilliseconds);
    try {
      await monitor.run(() => this.jobs.markLeased(jobId, lease, this.clock.now()));
      const prepared = await monitor.run(() => this.work.prepare(jobId, lease));
      workPath = prepared.path;
      await monitor.run(() => this.jobs.markDecrypting(jobId, lease, this.clock.now()));
      if (!job.snapshotId) throw new Error("decryption job has no snapshot");
      const decrypted = await monitor.run(async () =>
        this.decrypt.decrypt(
          await this.snapshots.path(job.snapshotId as string),
          workPath,
          this.options.decryptTimeoutMilliseconds,
        ),
      );
      if (!this.adapter || !this.importer) {
        if (this.adapter || this.importer) throw new Error("worker import pipeline is incomplete");
        await monitor.run(() => this.jobs.markCompleted(jobId, lease, this.clock.now()));
        return true;
      }
      phase = "adaptation";
      await monitor.run(() => this.jobs.markAdapting(jobId, lease, this.clock.now()));
      if (!job.ownedAccountId) throw new Error("import job has no owned account");
      const adapted = await monitor.run(
        () =>
          this.adapter?.adapt({
            decryptedPath: decrypted.outputPath,
            workPath,
            snapshotId: job.snapshotId as string,
            accountScope: job.ownedAccountId as string,
          }) ?? Promise.reject(new Error("worker import pipeline is incomplete")),
      );
      phase = "import";
      await monitor.run(() =>
        this.jobs.markImporting(jobId, lease, adapted.adapterVersion, this.clock.now()),
      );
      phase = "finalization";
      await monitor.run(() => this.jobs.markFinalizing(jobId, lease, this.clock.now()));
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
        leaseId: lease,
      };
      await monitor.run(
        () =>
          this.importer?.import(input) ??
          Promise.reject(new Error("worker import pipeline is incomplete")),
      );
      return true;
    } catch (error) {
      if (monitor.isLost || error instanceof LeaseFenceError) return false;
      const failure = toFailure(error, phase);
      try {
        await monitor.run(() => this.jobs.markFailed(jobId, lease, failure, this.clock.now()));
      } catch (failureError) {
        if (!(failureError instanceof LeaseFenceError)) throw failureError;
      }
      return false;
    } finally {
      clearInterval(heartbeat);
      try {
        if (workPath) await this.work.cleanup(jobId, lease, workPath);
        else if (monitor.isLost) await this.work.cleanupStale(jobId, lease);
      } finally {
        await this.leases.release(lease, this.clock.now());
      }
    }
  }

  private expiry(): Date {
    return new Date(this.clock.now().getTime() + this.options.leaseDurationMilliseconds);
  }
}

class LeaseMonitor {
  private lostError: LeaseFenceError | undefined;
  private renewal: Promise<void> | undefined;
  private readonly rejectLost: (error: LeaseFenceError) => void;
  public readonly lost: Promise<never>;

  public constructor(
    private readonly leases: LeasePort,
    private readonly lease: LeaseId,
    private readonly clock: ClockPort,
    private readonly expiry: () => Date,
  ) {
    let rejectLost: (error: LeaseFenceError) => void = () => undefined;
    this.lost = new Promise<never>((_, reject) => {
      rejectLost = reject;
    });
    this.rejectLost = (error) => rejectLost(error);
  }

  public get isLost(): boolean {
    return this.lostError !== undefined;
  }

  public async renew(): Promise<void> {
    if (this.lostError || this.renewal) return this.renewal ?? Promise.resolve();
    this.renewal = (async () => {
      try {
        const renewed = await this.leases.renew(this.lease, this.expiry(), this.clock.now());
        if (!renewed) this.lose();
      } catch {
        this.lose();
      } finally {
        this.renewal = undefined;
      }
    })();
    return this.renewal;
  }

  public async run<T>(operation: () => Promise<T>): Promise<T> {
    this.assert();
    return Promise.race([operation(), this.lost]);
  }

  private assert(): void {
    if (this.lostError) throw this.lostError;
  }

  private lose(): void {
    if (this.lostError) return;
    this.lostError = new LeaseFenceError();
    this.rejectLost(this.lostError);
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
    "resource-limit",
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
