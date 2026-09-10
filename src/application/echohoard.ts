/** Contracts for snapshot intake and decryption.  These types intentionally
 * contain no ORM, SQLite, subprocess, or secret/key details. */

export type DeliveryId = string;
export type SnapshotId = string;
export type ImportJobId = string;
export type LeaseId = string;
export type Sha256 = string;

export interface DeliveryFile {
  readonly name: string;
  readonly size: number;
  readonly modifiedAt: Date;
}

export interface Delivery {
  readonly id: DeliveryId;
  readonly path: string;
  readonly files: readonly DeliveryFile[];
  readonly discoveredAt: Date;
  readonly status: DeliveryStatus;
}

export type DeliveryStatus = "discovered" | "settling" | "claimed" | "completed" | "failed";
export type SnapshotStatus = "pending" | "ready" | "failed";
export type ImportJobStatus = "queued" | "leased" | "decrypting" | "completed" | "failed";

export interface Snapshot {
  readonly id: SnapshotId;
  readonly deliveryId: DeliveryId;
  readonly sourceHash: Sha256;
  readonly path: string;
  readonly createdAt: Date;
  readonly status: SnapshotStatus;
}

export interface ImportJob {
  readonly id: ImportJobId;
  readonly snapshotId: SnapshotId;
  readonly status: ImportJobStatus;
  readonly lease?: LeaseId;
  readonly updatedAt: Date;
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly entity: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Invalid ${entity} transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

const deliveryTransitions: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  discovered: ["settling", "failed"],
  settling: ["discovered", "claimed", "failed"],
  claimed: ["completed", "failed"],
  completed: [],
  failed: ["settling", "claimed"],
};
const snapshotTransitions: Record<SnapshotStatus, readonly SnapshotStatus[]> = {
  pending: ["ready", "failed"],
  ready: [],
  failed: ["pending"],
};
const jobTransitions: Record<ImportJobStatus, readonly ImportJobStatus[]> = {
  queued: ["leased", "failed"],
  leased: ["decrypting", "queued", "failed"],
  decrypting: ["completed", "failed"],
  completed: [],
  failed: ["queued", "leased"],
};

export function transitionDelivery(delivery: Delivery, status: DeliveryStatus): Delivery {
  if (!deliveryTransitions[delivery.status].includes(status))
    throw new InvalidTransitionError("delivery", delivery.status, status);
  return { ...delivery, status };
}
export function transitionSnapshot(snapshot: Snapshot, status: SnapshotStatus): Snapshot {
  if (!snapshotTransitions[snapshot.status].includes(status))
    throw new InvalidTransitionError("snapshot", snapshot.status, status);
  return { ...snapshot, status };
}
export function transitionImportJob(job: ImportJob, status: ImportJobStatus): ImportJob {
  if (!jobTransitions[job.status].includes(status))
    throw new InvalidTransitionError("import job", job.status, status);
  return { ...job, status, lease: status === "queued" ? undefined : job.lease };
}

export interface FileSystemPort {
  list(path: string): Promise<readonly DeliveryFile[]>;
  copy(source: string, destination: string): Promise<void>;
  createDirectory(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** Operations owned by intake; implementations must make claim atomic. */
export interface InboxPort {
  listDeliveries(inboxPath: string): Promise<readonly string[]>;
  inspect(deliveryPath: string): Promise<readonly DeliveryFile[]>;
  claim(deliveryPath: string, deliveryId: DeliveryId): Promise<string | null>;
}

export interface StableBatchOptions {
  readonly quietPeriodMilliseconds: number;
}

export class StableBatchClaimer {
  public constructor(
    private readonly inbox: InboxPort,
    private readonly clock: ClockPort,
    private readonly options: StableBatchOptions,
  ) {}

  /** Returns a claimed path only when metadata is identical across the quiet period. */
  public async settleAndClaim(inboxPath: string, deliveryId: DeliveryId): Promise<string | null> {
    const deliveryPath = `${inboxPath}/${deliveryId}`;
    const before = await this.inbox.inspect(deliveryPath);
    if (before.length === 0) return null;
    await this.clock.sleep(this.options.quietPeriodMilliseconds);
    const after = await this.inbox.inspect(deliveryPath);
    if (!sameFiles(before, after)) return null;
    return this.inbox.claim(deliveryPath, deliveryId);
  }
}

const sameFiles = (left: readonly DeliveryFile[], right: readonly DeliveryFile[]): boolean =>
  left.length === right.length && left.every((file, index) => {
    const other = right[index];
    return other?.name === file.name && other.size === file.size && other.modifiedAt.getTime() === file.modifiedAt.getTime();
  });
export interface ClockPort {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
}
export interface HashingPort {
  sha256(path: string): Promise<Sha256>;
}
export interface LeasePort {
  acquire(jobId: ImportJobId, owner: string, expiresAt: Date): Promise<LeaseId | null>;
  renew(leaseId: LeaseId, expiresAt: Date): Promise<boolean>;
  release(leaseId: LeaseId): Promise<void>;
  recoverExpired(now: Date): Promise<readonly ImportJobId[]>;
}
export interface DecryptPort {
  decrypt(
    snapshotPath: string,
    workPath: string,
    timeoutMilliseconds: number,
  ): Promise<{ readonly outputPath: string }>;
}
