import { env } from "../config/env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { installSignalHandlers, WorkerLifecycle } from "./lifecycle.js";
import { createProductionWorker } from "./composition.js";

if (env.ECHOHOARD_ROLE !== "worker") throw new Error("ECHOHOARD_ROLE must be worker");

const statusFile = process.env.ECHOHOARD_WORKER_STATUS_FILE ?? "/work/worker.status";
const writeStatus = async (status: "ready" | "draining" | "stopped"): Promise<void> => {
  await mkdir(dirname(statusFile), { recursive: true });
  await writeFile(statusFile, `${status}\n`, { mode: 0o600 });
};

const production = createProductionWorker(env, undefined, (message) => {
  console.error(`EchoHoard ${message}`);
});

const lifecycle = new WorkerLifecycle({
  onStart: async () => {
    await production.worker.start();
    await writeStatus("ready");
  },
  onDrain: async () => {
    await writeStatus("draining");
    await production.worker.stop();
    await writeStatus("stopped");
  },
});

async function main(): Promise<void> {
  installSignalHandlers(lifecycle);
  await lifecycle.start();
  console.log("EchoHoard worker ready");
}

main().catch(() => {
  // Do not include the caught error: subprocess diagnostics can contain keys,
  // decrypted content, source paths, or other hostile archive data.
  console.error("EchoHoard worker failed");
  process.exitCode = 1;
});
