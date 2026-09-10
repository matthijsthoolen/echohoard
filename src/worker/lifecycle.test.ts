import { describe, expect, it, vi } from "vitest";
import { installSignalHandlers, WorkerLifecycle, type SignalSource } from "./lifecycle";

class FakeSignals implements SignalSource {
  private readonly listeners = new Map<string, () => void>();

  public once(signal: NodeJS.Signals, listener: () => void): void {
    this.listeners.set(signal, listener);
  }

  public removeListener(signal: NodeJS.Signals): void {
    this.listeners.delete(signal);
  }

  public emit(signal: NodeJS.Signals): void {
    this.listeners.get(signal)?.();
  }
}

describe("worker lifecycle", () => {
  it("becomes ready only after startup and drains exactly once", async () => {
    const drain = vi.fn(async () => {});
    const lifecycle = new WorkerLifecycle({ onDrain: drain });
    expect(lifecycle.state).toBe("starting");
    await lifecycle.start();
    expect(lifecycle.state).toBe("ready");
    await Promise.all([lifecycle.shutdown("SIGTERM"), lifecycle.shutdown("SIGINT")]);
    expect(lifecycle.state).toBe("stopped");
    expect(drain).toHaveBeenCalledOnce();
    expect(drain).toHaveBeenCalledWith("SIGTERM");
  });

  it("marks startup failures and reports drain failures", async () => {
    const lifecycle = new WorkerLifecycle({
      onStart: async () => {
        throw new Error("startup");
      },
    });
    await expect(lifecycle.start()).rejects.toThrow("startup");
    expect(lifecycle.state).toBe("failed");

    const failedDrain = new WorkerLifecycle({
      onDrain: async () => {
        throw new Error("drain");
      },
    });
    await failedDrain.start();
    await expect(failedDrain.shutdown("SIGTERM")).rejects.toThrow("drain");
    expect(failedDrain.state).toBe("failed");
  });

  it("installs removable, single-shot signal handlers", async () => {
    const source = new FakeSignals();
    const exit = vi.fn();
    const lifecycle = new WorkerLifecycle();
    await lifecycle.start();
    const remove = installSignalHandlers(lifecycle, source, exit);
    source.emit("SIGTERM");
    source.emit("SIGINT");
    await new Promise((resolve) => setImmediate(resolve));
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
    remove();
  });
});
