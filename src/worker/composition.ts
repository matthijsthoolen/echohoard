import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parseEnv, type EchohoardEnv } from "../config/env.js";
import { DecryptJobRunner } from "../application/intake.js";
import { decryptCrypt15 } from "../infrastructure/crypto/wa-crypt-tools.js";
import {
  PrismaDecryptJobStore,
  PrismaImportJobLeases,
} from "../infrastructure/db/worker-persistence.js";
import { PrismaLiveEventNormalizer } from "../infrastructure/db/prisma-persistence.js";
import { PrismaSnapshotPath } from "../infrastructure/db/worker-snapshot-path.js";
import { LocalJobWork } from "../infrastructure/files/index.js";
import { PrismaTextSnapshotImporter } from "../infrastructure/db/text-import.js";
import type { ClockPort } from "../application/echohoard.js";
import type { JobStorePort } from "../application/intake.js";
import { parseWacliWebhookEvent, type WacliWebhookEvent } from "../adapters/wacli/contract.js";
import { normalizeWacliEvent } from "../adapters/wacli/normalize.js";
import {
  PythonSqliteDatabaseReader,
  WhatsAppSnapshotAdapter,
} from "../adapters/whatsapp/sqlite-adapter.js";

export interface WorkerErrorSink {
  (message: string): void;
}

/** Small sequential queue loop for the single worker role. The database lease
 * remains authoritative, so an overlapping worker or interrupted process can
 * never make this loop's local view authoritative. */
export class DecryptQueueLoop {
  private stopping = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private current = Promise.resolve();

  public constructor(
    private readonly jobs: JobStorePort,
    private readonly runner: DecryptJobRunner,
    private readonly pollMilliseconds: number,
    private readonly batchSize: number,
    private readonly onError: WorkerErrorSink = () => undefined,
  ) {}

  public async start(): Promise<void> {
    if (this.stopping) return;
    await this.runner.recoverStaleJobs();
    this.current = this.pump();
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.current;
  }

  private async pump(): Promise<void> {
    try {
      await this.processBatch();
    } catch {
      this.onError("worker queue iteration failed");
    } finally {
      if (!this.stopping) {
        this.timer = setTimeout(() => {
          this.current = this.pump();
        }, this.pollMilliseconds);
      }
    }
  }

  private async processBatch(): Promise<void> {
    const listEligible = this.jobs.listEligible;
    if (!listEligible) throw new Error("worker job store does not support queue listing");
    const jobIds = await listEligible.call(this.jobs, this.batchSize);
    for (const jobId of jobIds) {
      if (this.stopping) return;
      try {
        await this.runner.run(jobId);
      } catch {
        // Runner failures are intentionally not surfaced: diagnostics belong
        // in the sanitized job classification, never in process logs.
        this.onError("worker job iteration failed");
      }
    }
  }
}

export class LiveEventNormalizationLoop {
  private stopping = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private current = Promise.resolve();

  public constructor(
    private readonly normalizer: PrismaLiveEventNormalizer,
    private readonly pollMilliseconds: number,
    private readonly batchSize: number,
    private readonly onError: WorkerErrorSink = () => undefined,
  ) {}

  public async start(): Promise<void> {
    if (this.stopping) return;
    this.current = this.pump();
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.current;
  }

  private async pump(): Promise<void> {
    try {
      const now = new Date();
      const receipts = await this.normalizer.claimPending({
        limit: this.batchSize,
        workerId: randomUUID(),
        now,
        claimExpiresAt: new Date(now.getTime() + 60_000),
      });
      for (const receipt of receipts) {
        if (this.stopping) return;
        try {
          await this.normalizer.normalize(receipt);
        } catch (error) {
          await this.normalizer.failClaim({
            ...receipt,
            retryable:
              error instanceof Error && "retryable" in error
                ? (error as Error & { readonly retryable: boolean }).retryable
                : true,
            errorClass:
              error instanceof Error && "errorClass" in error
                ? (error as Error & { readonly errorClass: string }).errorClass
                : "normalization-failure",
            now: new Date(),
          });
          this.onError("live event normalization failed");
        }
      }
    } catch {
      this.onError("live event normalization loop failed");
    } finally {
      if (!this.stopping)
        this.timer = setTimeout(() => {
          this.current = this.pump();
        }, this.pollMilliseconds);
    }
  }
}

export class ProductionWorker {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly queue: DecryptQueueLoop,
    private readonly liveQueue: LiveEventNormalizationLoop,
  ) {}

  public async start(): Promise<void> {
    await this.queue.start();
    await this.liveQueue.start();
  }

  public async stop(): Promise<void> {
    await this.queue.stop();
    await this.liveQueue.stop();
    await this.prisma.$disconnect();
  }
}

export interface ProductionWorkerComposition {
  readonly worker: ProductionWorker;
  readonly queue: DecryptQueueLoop;
  readonly runner: DecryptJobRunner;
  readonly jobs: PrismaDecryptJobStore;
  readonly clock: ClockPort;
  readonly liveNormalizer: PrismaLiveEventNormalizer;
  readonly liveQueue: LiveEventNormalizationLoop;
}

export function createProductionWorker(
  settings: EchohoardEnv = parseEnv(),
  prisma: PrismaClient = new PrismaClient(),
  onError: WorkerErrorSink = () => undefined,
): ProductionWorkerComposition {
  const dataRoot = settings.ECHOHOARD_DATA_DIR;
  const workRoot = settings.ECHOHOARD_WORK_DIR;
  const secretFile =
    settings.ECHOHOARD_WORKER_KEY_FILE ?? join(settings.ECHOHOARD_SECRET_DIR, "worker.key");
  const clock: ClockPort = {
    now: () => new Date(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  };
  const jobs = new PrismaDecryptJobStore(prisma);
  const liveNormalizer = new PrismaLiveEventNormalizer(
    prisma,
    (payload, accountKey) => parseWacliWebhookEvent(payload, accountKey),
    (event, accountScope) => normalizeWacliEvent(asWacliEvent(event), accountScope),
  );
  const runner = new DecryptJobRunner(
    jobs,
    new PrismaImportJobLeases(prisma),
    new LocalJobWork(workRoot),
    new PrismaSnapshotPath(prisma, join(dataRoot, "snapshots")),
    {
      decrypt: (snapshotPath, workPath, timeoutMilliseconds) =>
        decryptCrypt15(snapshotPath, join(workPath, "msgstore.db"), secretFile, {
          executable: settings.ECHOHOARD_WADECRYPT_EXECUTABLE,
          timeoutMs: timeoutMilliseconds,
        }),
    },
    clock,
    {
      owner: settings.ECHOHOARD_WORKER_OWNER,
      leaseDurationMilliseconds: settings.ECHOHOARD_WORKER_LEASE_MS,
      heartbeatMilliseconds: settings.ECHOHOARD_WORKER_HEARTBEAT_MS,
      decryptTimeoutMilliseconds: settings.ECHOHOARD_WORKER_DECRYPT_TIMEOUT_MS,
    },
    new WhatsAppSnapshotAdapter(
      new PythonSqliteDatabaseReader("python3", {
        timeoutMs: settings.ECHOHOARD_WORKER_SQLITE_TIMEOUT_MS,
        maxRowBytes: settings.ECHOHOARD_WORKER_SQLITE_MAX_ROW_BYTES,
        maxRows: settings.ECHOHOARD_WORKER_SQLITE_MAX_ROWS,
        maxOutputBytes: settings.ECHOHOARD_WORKER_SQLITE_MAX_OUTPUT_BYTES,
      }),
      { maxSpoolBytes: settings.ECHOHOARD_WORKER_IMPORT_SPOOL_MAX_BYTES },
    ),
    new PrismaTextSnapshotImporter(prisma, {
      transactionTimeoutMilliseconds: settings.ECHOHOARD_WORKER_IMPORT_TRANSACTION_TIMEOUT_MS,
    }),
  );
  const queue = new DecryptQueueLoop(
    jobs,
    runner,
    settings.ECHOHOARD_WORKER_POLL_MS,
    settings.ECHOHOARD_WORKER_BATCH_SIZE,
    onError,
  );
  const liveQueue = new LiveEventNormalizationLoop(
    liveNormalizer,
    settings.ECHOHOARD_WORKER_POLL_MS,
    settings.ECHOHOARD_WORKER_BATCH_SIZE,
    onError,
  );
  return {
    worker: new ProductionWorker(prisma, queue, liveQueue),
    queue,
    runner,
    jobs,
    clock,
    liveNormalizer,
    liveQueue,
  };
}

function asWacliEvent(event: unknown): WacliWebhookEvent {
  if (!event || typeof event !== "object" || Array.isArray(event))
    throw new Error("live event adaptation produced an invalid event");
  const kind = (event as { readonly kind?: unknown }).kind;
  if (kind !== "message" && kind !== "receipt" && kind !== "chat_presence")
    throw new Error("live event adaptation produced an unsupported event");
  return event as WacliWebhookEvent;
}
