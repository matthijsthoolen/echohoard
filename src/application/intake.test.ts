import { describe, expect, it } from "vitest";
import type { ImportJob } from "./echohoard.js";
import { DecryptJobRunner, type JobStorePort, type JobWorkPort } from "./intake.js";

const now = new Date("2026-01-01T00:00:00Z");
const job: ImportJob = { id: "job", snapshotId: "snapshot", status: "queued", updatedAt: now };

function setup(decrypt: (path: string) => Promise<void> = async () => {}) {
  const events: string[] = [];
  let stored: ImportJob = job;
  const jobs: JobStorePort = {
    get: async () => stored,
    markLeased: async () => events.push("leased"),
    markDecrypting: async () => events.push("decrypting"),
    markCompleted: async () => {
      events.push("completed");
      stored = { ...stored, status: "completed" };
    },
    markFailed: async (_id, failure) => {
      events.push(`${failure.retryable ? "retryable" : "terminal"}:${failure.class}`);
      stored = { ...stored, status: "failed" };
    },
    requeue: async () => {
      events.push("requeued");
      stored = { ...stored, status: "queued" };
    },
  };
  const work: JobWorkPort = {
    prepare: async () => {
      events.push("prepare");
      return { path: "/data/work/job", restarted: true };
    },
    cleanup: async (_id, path) => events.push(`cleanup:${path}`),
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
  return { events, jobs, runner, setJob: (value: ImportJob) => (stored = value) };
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

  it("requeues expired leases only after cleaning stale work", async () => {
    const fixture = setup();
    const leases = {
      acquire: async () => "lease",
      renew: async () => true,
      release: async () => {},
      recoverExpired: async () => ["job"],
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
    expect(fixture.events).toEqual(["cleanup-stale", "requeued"]);
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
});
