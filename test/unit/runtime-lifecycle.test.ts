import { describe, expect, it, vi } from "vitest";
import { startLocalRuntimeWorkers } from "../../src/mastra/runtime/local-runtime";
import { startAfterStorageReady } from "../../src/mastra/runtime/storage-lifecycle";

describe("local runtime lifecycle", () => {
  it("waits for an active sweep and prevents any later sweep after stop", async () => {
    let release!: () => void;
    let entered!: () => void;
    const active = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const sweep = vi.fn(async () => {
      entered();
      await active;
    });
    const stop = startLocalRuntimeWorkers({} as never, undefined, {
      initialDelayMs: 0,
      intervalMs: 2,
      runSweep: sweep,
    });
    await started;
    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);
    expect(sweep).toHaveBeenCalledTimes(1);
    release();
    await stopping;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("observes storage startup rejection on the same lifecycle chain", async () => {
    const failure = new Error("synthetic storage startup failure");
    const onFailure = vi.fn();
    const lifecycle = startAfterStorageReady(
      Promise.reject(failure),
      () => undefined,
      onFailure,
    );
    await expect(lifecycle).rejects.toBe(failure);
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith(failure));
  });
});
