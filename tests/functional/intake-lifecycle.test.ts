import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ImmutableSnapshotCreator,
  type ImportJob,
  type JobFailureClass,
  type JobStorePort,
  type LeaseId,
  type LeasePort,
  type SnapshotPathPort,
  type SnapshotStorePort,
  StableBatchClaimer,
  DecryptJobRunner,
} from "../../src/application/index.js";
import { decryptCrypt15 } from "../../src/infrastructure/crypto/wa-crypt-tools.js";
import {
  LocalInbox,
  LocalJobWork,
  LocalSnapshotStore,
} from "../../src/infrastructure/files/index.js";

const now = new Date("2026-01-01T00:00:00.000Z");
const cleanupRoots: string[] = [];

afterEach(async () => {
  for (const root of cleanupRoots) await rm(root, { recursive: true, force: true });
  cleanupRoots.length = 0;
});

type Scenario = {
  root: string;
  inbox: string;
  snapshots: string;
  work: string;
  secret: string;
  encrypted: string;
  executable: string;
  claimer: StableBatchClaimer;
  creator: ImmutableSnapshotCreator;
  runner: DecryptJobRunner;
  jobs: MemoryJobs;
  lease: MemoryLease;
  snapshotPath: string;
};

class MemoryJobs implements JobStorePort {
  public readonly events: string[] = [];
  public job: ImportJob = {
    id: "job-1",
    snapshotId: "snapshot-1",
    status: "queued",
    updatedAt: now,
  };

  public async get(): Promise<ImportJob> {
    return this.job;
  }
  public async markLeased(_id: string, lease: LeaseId): Promise<void> {
    this.events.push("leased");
    this.job = { ...this.job, status: "leased", lease };
  }
  public async markDecrypting(): Promise<void> {
    this.events.push("decrypting");
    this.job = { ...this.job, status: "decrypting" };
  }
  public async markCompleted(): Promise<void> {
    this.events.push("completed");
    this.job = { ...this.job, status: "completed" };
  }
  public async markFailed(
    _id: string,
    failure: { class: JobFailureClass; retryable: boolean },
  ): Promise<void> {
    this.events.push(`${failure.retryable ? "retryable" : "terminal"}:${failure.class}`);
    this.job = { ...this.job, status: "failed" };
  }
  public async requeue(): Promise<void> {
    this.events.push("requeued");
    this.job = { ...this.job, status: "queued", lease: undefined };
  }
}

class MemoryLease implements LeasePort {
  public available = true;
  public stale: string[] = [];
  public async acquire(): Promise<LeaseId | null> {
    if (!this.available) return null;
    this.available = false;
    return "lease-1";
  }
  public async renew(): Promise<boolean> {
    return true;
  }
  public async release(): Promise<void> {
    this.available = true;
  }
  public async recoverExpired(): Promise<readonly string[]> {
    const result = this.stale;
    this.stale = [];
    return result;
  }
}

async function scenario(
  output: "sqlite" | "unsupported" | "failure" = "sqlite",
): Promise<Scenario> {
  const root = await mkdtemp(join(tmpdir(), "echohoard-lifecycle-"));
  cleanupRoots.push(root);
  const inbox = join(root, "inbox");
  const snapshots = join(root, "snapshots");
  const work = join(root, "work");
  const delivery = join(inbox, "delivery-1");
  const encrypted = join(delivery, "msgstore.db.crypt15");
  const secret = join(root, "secret");
  const executable = join(root, "wadecrypt-fixture.sh");
  await mkdir(delivery, { recursive: true });
  await mkdir(work, { recursive: true });
  await writeFile(encrypted, "immutable encrypted fixture");
  await writeFile(secret, "sentinel-key");
  const payload =
    output === "sqlite"
      ? "printf 'SQLite format 3\\000synthetic\\n' > \"$3\""
      : output === "unsupported"
        ? "printf 'not sqlite' > \"$3\""
        : "printf 'invalid key' >&2; exit 1";
  await writeFile(executable, `#!/bin/sh\n${payload}\n`);
  await chmod(executable, 0o755);

  const clock = { now: () => now, sleep: async () => {} };
  const inboxPort = new LocalInbox();
  const claimer = new StableBatchClaimer(inboxPort, clock, { quietPeriodMilliseconds: 0 });
  const store: SnapshotStorePort = new LocalSnapshotStore(snapshots);
  const creator = new ImmutableSnapshotCreator(
    {
      sha256: async (path) =>
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
    },
    store,
    clock,
    () => "snapshot-1",
  );
  const jobs = new MemoryJobs();
  const lease = new MemoryLease();
  const jobWork = new LocalJobWork(work);
  const snapshotPath: SnapshotPathPort = {
    path: async () => join(snapshots, "snapshot-1", "msgstore.db.crypt15"),
  };
  const runner = new DecryptJobRunner(
    jobs,
    lease,
    jobWork,
    snapshotPath,
    {
      decrypt: (snapshotPath, workPath, timeout) =>
        decryptCrypt15(snapshotPath, join(workPath, "msgstore.db"), secret, {
          executable,
          timeoutMs: timeout,
        }),
    },
    clock,
    {
      owner: "functional-worker",
      leaseDurationMilliseconds: 10_000,
      heartbeatMilliseconds: 1_000,
      decryptTimeoutMilliseconds: 5_000,
    },
  );
  return {
    root,
    inbox,
    snapshots,
    work,
    secret,
    encrypted,
    executable,
    claimer,
    creator,
    runner,
    jobs,
    lease,
    snapshotPath,
  };
}

async function ingest(fixture: Scenario): Promise<void> {
  const claimed = await fixture.claimer.settleAndClaim(fixture.inbox, "delivery-1");
  expect(claimed).not.toBeNull();
  const files = await new LocalInbox().inspect(claimed!);
  await fixture.creator.create({
    deliveryId: "delivery-1",
    claimedPath: claimed!,
    files,
    discoveredAt: now,
    claimedAt: now,
  });
}

describe("complete intake and decryption lifecycle", () => {
  it("claims, snapshots, decrypts validated SQLite exactly once and cleans plaintext", async () => {
    const fixture = await scenario();
    await ingest(fixture);
    const snapshotEncrypted = join(fixture.snapshots, "snapshot-1", "msgstore.db.crypt15");
    const sourceBefore = await readFile(snapshotEncrypted);
    await expect(fixture.runner.run("job-1")).resolves.toBe(true);
    expect(fixture.jobs.job.status).toBe("completed");
    expect(await readFile(snapshotEncrypted)).toEqual(sourceBefore);
    expect(await readdir(fixture.work)).toEqual([]);
    await expect(fixture.runner.run("job-1")).resolves.toBe(false);
    expect(fixture.jobs.events.filter((event) => event === "completed")).toHaveLength(1);
  });

  it("converges duplicate delivery to one immutable snapshot", async () => {
    const fixture = await scenario();
    await ingest(fixture);
    const duplicatePath = join(fixture.snapshots, "snapshot-1");
    const duplicateDetails = await stat(join(duplicatePath, "msgstore.db.crypt15"));
    const duplicateFiles = [
      {
        name: "msgstore.db.crypt15",
        size: duplicateDetails.size,
        modifiedAt: duplicateDetails.mtime,
      },
    ];
    const duplicate = await fixture.creator.create({
      deliveryId: "delivery-duplicate",
      claimedPath: duplicatePath,
      files: duplicateFiles,
      discoveredAt: now,
      claimedAt: now,
    });
    expect(duplicate.duplicate).toBe(true);
  });

  it("records retryable failure, then succeeds on retry with immutable input", async () => {
    const fixture = await scenario("failure");
    await ingest(fixture);
    await expect(fixture.runner.run("job-1")).resolves.toBe(false);
    expect(fixture.jobs.job.status).toBe("failed");
    expect(fixture.jobs.events).toContain("terminal:invalid-key");
    expect(await readdir(fixture.work)).toEqual([]);
    await writeFile(fixture.executable, "#!/bin/sh\nprintf 'SQLite format 3\\000retry' > \"$3\"\n");
    await chmod(fixture.executable, 0o755);
    fixture.jobs.job = { ...fixture.jobs.job, status: "failed" };
    await expect(fixture.runner.run("job-1")).resolves.toBe(true);
    expect(fixture.jobs.job.status).toBe("completed");
  });

  it("recovers stale work before requeue and never completes unsupported output", async () => {
    const fixture = await scenario("unsupported");
    await ingest(fixture);
    await fixture.runner.run("job-1");
    expect(fixture.jobs.events).toContain("terminal:unsupported-format");
    expect(await readdir(fixture.work)).toEqual([]);
    fixture.lease.stale = ["job-1"];
    await expect(fixture.runner.recoverStaleJobs()).resolves.toEqual(["job-1"]);
    expect(fixture.jobs.events.at(-1)).toBe("requeued");
  });
});
