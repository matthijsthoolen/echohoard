import { describe, expect, it, vi } from "vitest";
import type { ImportJobId } from "../application/echohoard.js";
import type { DecryptJobRunner, JobStorePort } from "../application/intake.js";
import { DecryptQueueLoop, LiveEventNormalizationLoop } from "./composition.js";

const jobId = "00000000-0000-0000-0000-000000000001" as ImportJobId;

function fakeRunner() {
  return {
    recoverStaleJobs: vi.fn(async () => [jobId]),
    run: vi.fn(async () => true),
  } as unknown as DecryptJobRunner & {
    recoverStaleJobs: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
  };
}

describe("production decrypt queue composition", () => {
  it("recovers stale leases at startup and processes a queued job once", async () => {
    let listed = true;
    const jobs: JobStorePort = {
      get: async () => null,
      listEligible: async () => {
        if (!listed) return [];
        listed = false;
        return [jobId];
      },
      markLeased: async () => {},
      markDecrypting: async () => {},
      markCompleted: async () => {},
      markFailed: async () => {},
      requeue: async () => {},
    };
    const runner = fakeRunner();
    const queue = new DecryptQueueLoop(jobs, runner, 60_000, 4);
    await queue.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await queue.stop();

    expect(runner.recoverStaleJobs).toHaveBeenCalledOnce();
    expect(runner.run).toHaveBeenCalledOnce();
    expect(runner.run).toHaveBeenCalledWith(jobId);
  });

  it("contains queue iteration failures in sanitized diagnostics", async () => {
    const errors: string[] = [];
    const jobs: JobStorePort = {
      get: async () => null,
      listEligible: async () => {
        throw new Error("secret-key /private/source");
      },
      markLeased: async () => {},
      markDecrypting: async () => {},
      markCompleted: async () => {},
      markFailed: async () => {},
      requeue: async () => {},
    };
    const runner = fakeRunner();
    const queue = new DecryptQueueLoop(jobs, runner, 60_000, 4, (message) => errors.push(message));
    await queue.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await queue.stop();

    expect(errors).toEqual(["worker queue iteration failed"]);
    expect(errors.join(" ")).not.toMatch(/secret-key|private\/source/);
  });
});

describe("production live normalization composition", () => {
  it("retries failed normalization without finalizing the receipt", async () => {
    const normalize = vi
      .fn()
      .mockRejectedValueOnce(new Error("synthetic adaptation failure"))
      .mockResolvedValueOnce({ imported: 1, status: "normalized" });
    let pending = true;
    const normalizer = {
      listPending: vi.fn(async () =>
        pending ? [{ archiveId: "archive", ownedAccountId: "account", receiptId: "receipt" }] : [],
      ),
      normalize: vi.fn(
        async (receipt: { archiveId: string; ownedAccountId: string; receiptId: string }) => {
          await normalize(receipt);
          pending = false;
        },
      ),
    };
    const errors: string[] = [];
    const loop = new LiveEventNormalizationLoop(normalizer as never, 60_000, 1, (message) =>
      errors.push(message),
    );

    await loop.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await loop.stop();

    expect(normalizer.normalize).toHaveBeenCalledOnce();
    expect(errors).toEqual(["live event normalization failed"]);
    expect(pending).toBe(true);
  });
});
