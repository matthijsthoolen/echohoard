/**
 * Process lifecycle boundary for the worker composition root.
 *
 * A termination signal starts a drain, but does not pretend that SIGKILL can
 * be handled. Jobs remain recoverable because their database lease expires and
 * the next worker calls DecryptJobRunner.recoverStaleJobs() before claiming
 * more work. Shutdown is idempotent so SIGTERM followed by SIGINT cannot run
 * cleanup twice.
 */
export type WorkerLifecycleState = "starting" | "ready" | "draining" | "stopped" | "failed";

export interface WorkerLifecycleOptions {
  readonly onStart?: () => Promise<void>;
  readonly onDrain?: (signal: NodeJS.Signals) => Promise<void>;
}

export interface SignalSource {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener?(signal: NodeJS.Signals, listener: () => void): unknown;
}

export class WorkerLifecycle {
  private currentState: WorkerLifecycleState = "starting";
  private shutdownPromise: Promise<void> | undefined;

  public constructor(private readonly options: WorkerLifecycleOptions = {}) {}

  public get state(): WorkerLifecycleState {
    return this.currentState;
  }

  public async start(): Promise<void> {
    if (this.currentState !== "starting") return;
    try {
      await this.options.onStart?.();
      this.currentState = "ready";
    } catch (error) {
      this.currentState = "failed";
      throw error;
    }
  }

  public shutdown(signal: NodeJS.Signals): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.currentState = "draining";
    this.shutdownPromise = (async () => {
      try {
        await this.options.onDrain?.(signal);
        this.currentState = "stopped";
      } catch (error) {
        this.currentState = "failed";
        throw error;
      }
    })();
    return this.shutdownPromise;
  }
}

export function installSignalHandlers(
  lifecycle: WorkerLifecycle,
  source: SignalSource = process,
  exit: (code: number) => void = process.exit,
): () => void {
  let handled = false;
  const handle = (signal: NodeJS.Signals): void => {
    if (handled) return;
    handled = true;
    void lifecycle
      .shutdown(signal)
      .then(() => exit(0))
      .catch(() => exit(1));
  };
  const onTerminate = (): void => handle("SIGTERM");
  const onInterrupt = (): void => handle("SIGINT");
  source.once("SIGTERM", onTerminate);
  source.once("SIGINT", onInterrupt);
  return () => {
    source.removeListener?.("SIGTERM", onTerminate);
    source.removeListener?.("SIGINT", onInterrupt);
  };
}
