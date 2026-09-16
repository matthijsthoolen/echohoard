import { describe, expect, it } from "vitest";
import type { ImportJob } from "./echohoard.js";
import {
  DecryptJobRunner,
  type JobStorePort,
  type JobWorkPort,
  type SnapshotAdapterPort,
} from "./intake.js";
import type { ImportRecord, TextSnapshotImporter } from "./text-import.js";

const now = new Date("2026-01-01T00:00:00Z");
const job: ImportJob = { id: "job", snapshotId: "snapshot", status: "queued", updatedAt: now };

function setup(decrypt: (path: string) => Promise<void> = async () => {}) {
  const events: string[] = [];
  let stored: ImportJob = job;
  const jobs: JobStorePort = {
    get: async () => stored,
    markLeased: async () => events.push("leased"),
    markDecrypting: async () => events.push("decrypting"),
    markAdapting: async () => events.push("adapting"),
    markImporting: async () => events.push("importing"),
    markFinalizing: async () => events.push("finalizing"),
    markCompleted: async () => {
      events.push("completed");
      stored = { ...stored, status: "completed" };
    },
    markFailed: async (_id, _lease, failure) => {
      events.push(`${failure.retryable ? "retryable" : "terminal"}:${failure.class}`);
      stored = { ...stored, status: "failed" };
    },
  };
  const work: JobWorkPort = {
    prepare: async () => {
      events.push("prepare");
      return { path: "/data/work/job", restarted: true };
    },
    cleanup: async (_id, _lease, path) => events.push(`cleanup:${path}`),
    cleanupStale: async () => events.push("cleanup-stale"),
  };
  const leases = {
    acquire: async () => "lease",
    renew: async () => true,
    release: async () => events.push("release"),
    recoverExpired: async () => [],
  };
  const runner = new DecryptJobRunner(
    jobs,
    leases,
    work,
    { path: async () => "/data/snapshots/snapshot/db.crypt15" },
    { decrypt: async (path) => decrypt(path).then(() => ({ outputPath: `${path}/db` })) },
    { now: () => now, sleep: async () => {} },
    {
      owner: "worker-a",
      leaseDurationMilliseconds: 10_000,
      heartbeatMilliseconds: 1_000,
      decryptTimeoutMilliseconds: 5_000,
    },
  );
  const snapshotPath = { path: async () => "/data/snapshots/snapshot/db.crypt15" };
  return {
    events,
    jobs,
    work,
    runner,
    snapshotPath,
    setJob: (value: ImportJob) => (stored = value),
  };
}

describe("decrypt job recovery", () => {
  it("cleans plaintext and releases the lease after success", async () => {
    const { events, runner } = setup();
    await expect(runner.run("job")).resolves.toBe(true);
    expect(events).toEqual([
      "leased",
      "prepare",
      "decrypting",
      "completed",
      "cleanup:/data/work/job",
      "release",
    ]);
  });

  it("maps handled timeout failures to retryable and still cleans work", async () => {
    const { events, runner } = setup(async () => {
      const error = new Error("secret-key should never be logged");
      Object.assign(error, { kind: "timeout" });
      throw error;
    });
    await expect(runner.run("job")).resolves.toBe(false);
    expect(events).toContain("retryable:timeout");
    expect(events).toContain("cleanup:/data/work/job");
    expect(events.join(" ")).not.toContain("secret-key");
  });

  it("maps invalid keys to terminal without exposing the error", async () => {
    const { events, runner } = setup(async () => {
      const error = new Error("key=sentinel");
      Object.assign(error, { kind: "invalid-key" });
      throw error;
    });
    await runner.run("job");
    expect(events).toContain("terminal:invalid-key");
    expect(events.join(" ")).not.toContain("sentinel");
  });

  it("maps configured extraction limits to terminal failures", async () => {
    const fixture = setup();
    fixture.setJob({
      ...job,
      archiveId: "archive",
      ownedAccountId: "account",
      sourceId: "source",
    });
    const runner = new DecryptJobRunner(
      fixture.jobs,
      {
        acquire: async () => "lease",
        renew: async () => true,
        release: async () => fixture.events.push("release"),
        recoverExpired: async () => [],
      },
      fixture.work,
      fixture.snapshotPath,
      { decrypt: async () => ({ outputPath: "/data/work/job/db" }) },
      { now: () => now, sleep: async () => {} },
      {
        owner: "worker-a",
        leaseDurationMilliseconds: 10_000,
        heartbeatMilliseconds: 1_000,
        decryptTimeoutMilliseconds: 5_000,
      },
      {
        adapt: async () => {
          throw Object.assign(new Error("row limit"), { kind: "resource-limit" });
        },
      },
      { import: async () => ({ imported: 0 }) },
    );
    await expect(runner.run("job")).resolves.toBe(false);
    expect(fixture.events).toContain("terminal:resource-limit");
  });

  it("requeues expired leases only after cleaning stale work", async () => {
    const fixture = setup();
    const leases = {
      acquire: async () => "lease",
      renew: async () => true,
      release: async () => {},
      recoverExpired: async () => [{ jobId: "job", leaseId: "lease" }],
    };
    const runner = new DecryptJobRunner(
      fixture.jobs,
      leases,
      {
        prepare: async () => ({ path: "/data/work/job", restarted: true }),
        cleanup: async () => {},
        cleanupStale: async () => fixture.events.push("cleanup-stale"),
      },
      { path: async () => "/data/snapshots/snapshot/db.crypt15" },
      { decrypt: async () => ({ outputPath: "/data/work/job/db" }) },
      { now: () => now, sleep: async () => {} },
      {
        owner: "worker-a",
        leaseDurationMilliseconds: 10_000,
        heartbeatMilliseconds: 1_000,
        decryptTimeoutMilliseconds: 5_000,
      },
    );
    await expect(runner.recoverStaleJobs()).resolves.toEqual(["job"]);
    expect(fixture.events).toEqual(["cleanup-stale"]);
  });

  it("does not run jobs without an available lease", async () => {
    const fixture = setup();
    const leases = {
      acquire: async () => null,
      renew: async () => false,
      release: async () => {},
      recoverExpired: async () => [],
    };
    const runner = new DecryptJobRunner(
      fixture.jobs,
      leases,
      {
        prepare: async () => ({ path: "/data/work/job", restarted: false }),
        cleanup: async () => {},
        cleanupStale: async () => {},
      },
      { path: async () => "/data/snapshots/snapshot/db.crypt15" },
      { decrypt: async () => ({ outputPath: "/data/work/job/db" }) },
      { now: () => now, sleep: async () => {} },
      {
        owner: "worker-a",
        leaseDurationMilliseconds: 10_000,
        heartbeatMilliseconds: 1_000,
        decryptTimeoutMilliseconds: 5_000,
      },
    );
    await expect(runner.run("job")).resolves.toBe(false);
    expect(fixture.events).toEqual([]);
  });

  it("aborts the current phase when renewal is rejected and never enters the next phase", async () => {
    let releaseDecrypt: (() => void) | undefined;
    let decryptStarted = false;
    const events: string[] = [];
    const jobs: JobStorePort = {
      get: async () => ({
        ...job,
        archiveId: "archive",
        ownedAccountId: "account",
        sourceId: "source",
      }),
      markLeased: async () => events.push("leased"),
      markDecrypting: async () => events.push("decrypting"),
      markAdapting: async () => events.push("adapting"),
      markImporting: async () => events.push("importing"),
      markFinalizing: async () => events.push("finalizing"),
      markCompleted: async () => events.push("completed"),
      markFailed: async () => events.push("failed"),
    };
    const runner = new DecryptJobRunner(
      jobs,
      {
        acquire: async () => "lease",
        renew: async () => decryptStarted === false,
        release: async () => events.push("release"),
        recoverExpired: async () => [],
      },
      {
        prepare: async () => ({ path: "/work/job/lease", restarted: false }),
        cleanup: async () => events.push("cleanup"),
        cleanupStale: async () => {},
      },
      { path: async () => "/snapshots/snapshot.db" },
      {
        decrypt: async () => {
          decryptStarted = true;
          await new Promise<void>((resolve) => {
            releaseDecrypt = resolve;
          });
          return { outputPath: "/work/job/lease/msgstore.db" };
        },
      },
      { now: () => now, sleep: async () => {} },
      {
        owner: "worker-a",
        leaseDurationMilliseconds: 10_000,
        heartbeatMilliseconds: 1,
        decryptTimeoutMilliseconds: 5_000,
      },
      { adapt: async () => ({ adapterVersion: "unused", records: [] }) },
      { import: async () => ({ imported: 0 }) },
    );

    const running = runner.run(job.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(decryptStarted).toBe(true);
    releaseDecrypt?.();
    await expect(running).resolves.toBe(false);
    expect(events).not.toContain("adapting");
    expect(events).not.toContain("failed");
    expect(events).toContain("cleanup");
  });

  it("runs adaptation, transactional import, and finalization before completion", async () => {
    const events: string[] = [];
    let stored: ImportJob = {
      ...job,
      archiveId: "archive",
      ownedAccountId: "account",
      sourceId: "source",
      observedAt: now,
    };
    const jobs: JobStorePort = {
      get: async () => stored,
      markLeased: async () => events.push("leased"),
      markDecrypting: async () => events.push("decrypting"),
      markAdapting: async () => {
        events.push("adapting");
        stored = { ...stored, status: "adapting" };
      },
      markImporting: async (_id, _lease, version) => {
        events.push(`importing:${version}`);
        stored = { ...stored, status: "importing" };
      },
      markFinalizing: async () => {
        events.push("finalizing");
        stored = { ...stored, status: "finalizing" };
      },
      markCompleted: async () => {},
      markFailed: async () => {
        stored = { ...stored, status: "failed" };
      },
    };
    const work: JobWorkPort = {
      prepare: async () => ({ path: "/work/job", restarted: false }),
      cleanup: async (_id, _lease, path) => events.push(`cleanup:${path}`),
      cleanupStale: async () => {},
    };
    const records: readonly ImportRecord[] = [{ kind: "person", stableKey: "person" }];
    const adapter: SnapshotAdapterPort = {
      adapt: async (input) => {
        events.push(`adapt:${input.decryptedPath}`);
        return { adapterVersion: "synthetic-adapter.v1", records };
      },
    };
    const importer: TextSnapshotImporter = {
      import: async (input) => {
        events.push(`import:${input.records.length}`);
        return { imported: input.records.length };
      },
    };
    const runner = new DecryptJobRunner(
      jobs,
      {
        acquire: async () => "lease",
        renew: async () => true,
        release: async () => {},
        recoverExpired: async () => [],
      },
      work,
      { path: async () => "/snapshots/snapshot.db" },
      { decrypt: async () => ({ outputPath: "/work/job/msgstore.db" }) },
      { now: () => now, sleep: async () => {} },
      {
        owner: "worker-a",
        leaseDurationMilliseconds: 10_000,
        heartbeatMilliseconds: 1_000,
        decryptTimeoutMilliseconds: 5_000,
      },
      adapter,
      importer,
    );

    await expect(runner.run(job.id)).resolves.toBe(true);
    expect(events).toEqual([
      "leased",
      "decrypting",
      "adapting",
      "adapt:/work/job/msgstore.db",
      "importing:synthetic-adapter.v1",
      "finalizing",
      "import:1",
      "cleanup:/work/job",
    ]);
  });

  it.each([
    ["adaptation", "unsupported-format", false],
    ["import", "internal", true],
    ["finalization", "internal", true],
  ] as const)(
    "classifies %s failure and always cleans plaintext",
    async (phase, kind, retryable) => {
      const fixture = setup();
      fixture.setJob({
        ...job,
        archiveId: "archive",
        ownedAccountId: "account",
        sourceId: "source",
        observedAt: now,
      });
      const adapter: SnapshotAdapterPort = {
        adapt: async () => {
          fixture.events.push("adapter-called");
          if (phase === "adaptation") throw Object.assign(new Error("source details"), { kind });
          return { adapterVersion: "synthetic-adapter.v1", records: [] };
        },
      };
      const importer: TextSnapshotImporter = {
        import: async () => {
          if (phase === "import") throw Object.assign(new Error("database details"), { kind });
          return { imported: 0 };
        },
      };
      const jobs = fixture.jobs;
      jobs.markAdapting = async () => {};
      jobs.markImporting = async () => {};
      jobs.markFinalizing = async () => {
        if (phase === "finalization")
          throw Object.assign(new Error("finalization details"), { kind });
      };
      const runner = new DecryptJobRunner(
        jobs,
        {
          acquire: async () => "lease",
          renew: async () => true,
          release: async () => {},
          recoverExpired: async () => [],
        },
        fixture.work,
        fixture.snapshotPath,
        { decrypt: async () => ({ outputPath: "/data/work/job/db" }) },
        { now: () => now, sleep: async () => {} },
        {
          owner: "worker-a",
          leaseDurationMilliseconds: 10_000,
          heartbeatMilliseconds: 1_000,
          decryptTimeoutMilliseconds: 5_000,
        },
        adapter,
        importer,
      );
      await expect(runner.run("job")).resolves.toBe(false);
      expect(fixture.events).toContain(`${retryable ? "retryable" : "terminal"}:${kind}`);
      expect(fixture.events).toContain("cleanup:/data/work/job");
    },
  );
});
