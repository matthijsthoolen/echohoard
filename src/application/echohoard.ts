import { createHash, randomUUID } from "node:crypto";

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

export interface SnapshotManifestEntry {
  readonly filename: string;
  readonly size: number;
  readonly sha256: Sha256;
}

export interface SnapshotManifest {
  readonly snapshotId: SnapshotId;
  readonly deliveryId: DeliveryId;
  readonly sourceHash: Sha256;
  readonly files: readonly SnapshotManifestEntry[];
  readonly discoveredAt: string;
  readonly claimedAt: string;
  readonly capturedAt: string;
  readonly adapterVersion?: string;
  readonly outcome?: Readonly<Record<string, string | number | boolean>>;
}

/** Storage boundary for immutable snapshot publication. Implementations must
 * make publish atomic: readers only discover a directory after it is ready. */
export interface SnapshotStorePort {
  createStaging(snapshotId: SnapshotId): Promise<string>;
  copy(source: string, destination: string): Promise<void>;
  writeManifest(stagingPath: string, manifest: SnapshotManifest): Promise<void>;
  publish(stagingPath: string, snapshotId: SnapshotId): Promise<string>;
  findReadyBySourceHash(sourceHash: Sha256): Promise<Snapshot | null>;
}

export interface SnapshotCreateInput {
  readonly deliveryId: DeliveryId;
  readonly claimedPath: string;
  readonly files: readonly DeliveryFile[];
  readonly discoveredAt: Date;
  readonly claimedAt: Date;
  readonly adapterVersion?: string;
}

export type SnapshotCreateResult = { readonly snapshot: Snapshot; readonly duplicate: boolean };

export class ImmutableSnapshotCreator {
  public constructor(
    private readonly hashes: HashingPort,
    private readonly store: SnapshotStorePort,
    private readonly clock: ClockPort,
    private readonly id: () => SnapshotId = () => cryptoRandomId(),
  ) {}

  public async create(input: SnapshotCreateInput): Promise<SnapshotCreateResult> {
    const files = [...input.files].sort((a, b) => a.name.localeCompare(b.name));
    const entries: SnapshotManifestEntry[] = [];
    for (const file of files) {
      entries.push({
        filename: file.name,
        size: file.size,
        sha256: await this.hashes.sha256(`${input.claimedPath}/${file.name}`),
      });
    }
    const sourceHash = stableSourceHash(entries);
    const existing = await this.store.findReadyBySourceHash(sourceHash);
    if (existing) return { snapshot: existing, duplicate: true };
    const snapshotId = this.id();
    const staging = await this.store.createStaging(snapshotId);
    try {
      for (const file of files) {
        await this.store.copy(`${input.claimedPath}/${file.name}`, `${staging}/${file.name}`);
        const copiedHash = await this.hashes.sha256(`${staging}/${file.name}`);
        if (copiedHash !== entries.find((entry) => entry.filename === file.name)?.sha256)
          throw new Error(`Snapshot hash mismatch for ${file.name}`);
      }
      const capturedAt = this.clock.now();
      await this.store.writeManifest(staging, {
        snapshotId,
        deliveryId: input.deliveryId,
        sourceHash,
        files: entries,
        discoveredAt: input.discoveredAt.toISOString(),
        claimedAt: input.claimedAt.toISOString(),
        capturedAt: capturedAt.toISOString(),
        ...(input.adapterVersion ? { adapterVersion: input.adapterVersion } : {}),
      });
      let path: string;
      try {
        path = await this.store.publish(staging, snapshotId);
      } catch (error) {
        const duplicate = await this.store.findReadyBySourceHash(sourceHash);
        if (duplicate) return { snapshot: duplicate, duplicate: true };
        throw error;
      }
      return {
        snapshot: {
          id: snapshotId,
          deliveryId: input.deliveryId,
          sourceHash,
          path,
          createdAt: capturedAt,
          status: "ready",
        },
        duplicate: false,
      };
    } catch (error) {
      throw error;
    }
  }
}

function stableSourceHash(entries: readonly SnapshotManifestEntry[]): Sha256 {
  const data = entries
    .map((entry) => `${entry.filename}\0${entry.size}\0${entry.sha256}`)
    .join("\n");
  return createHash("sha256").update(data).digest("hex");
}
function cryptoRandomId(): string {
  return randomUUID();
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
  left.length === right.length &&
  left.every((file, index) => {
    const other = right[index];
    return (
      other?.name === file.name &&
      other.size === file.size &&
      other.modifiedAt.getTime() === file.modifiedAt.getTime()
    );
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
