import { env } from "../config/env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { installSignalHandlers, WorkerLifecycle } from "./lifecycle.js";

if (env.ECHOHOARD_ROLE !== "worker") throw new Error("ECHOHOARD_ROLE must be worker");

const statusFile = process.env.ECHOHOARD_WORKER_STATUS_FILE ?? "/work/worker.status";
const writeStatus = async (status: "ready" | "draining" | "stopped"): Promise<void> => {
  await mkdir(dirname(statusFile), { recursive: true });
  await writeFile(statusFile, `${status}\n`, { mode: 0o600 });
};

const lifecycle = new WorkerLifecycle({
  onStart: () => writeStatus("ready"),
  onDrain: async () => {
    await writeStatus("draining");
    // The queue runner is intentionally not force-killed here. Its database
    // lease heartbeat stops with the process and the next worker requeues it.
    await writeStatus("stopped");
  },
});

async function main(): Promise<void> {
  installSignalHandlers(lifecycle);
  await lifecycle.start();
  console.log("EchoHoard worker ready");
}

main().catch(() => {
  process.exitCode = 1;
});
