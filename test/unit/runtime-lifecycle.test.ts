import { afterEach, describe, expect, it, vi } from "vitest";
import { startLocalRuntimeWorkers } from "../../src/mastra/runtime/local-runtime";
import { startAfterStorageReady } from "../../src/mastra/runtime/storage-lifecycle";

describe("local runtime lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores interval ticks during an active sweep and drains it on stop", async () => {
    vi.useFakeTimers();
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
    await vi.advanceTimersByTimeAsync(0);
    await started;
    await vi.advanceTimersByTimeAsync(10);
    expect(sweep).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    expect(stopped).toBe(false);
    expect(sweep).toHaveBeenCalledTimes(1);
    release();
    await stopping;
    await vi.advanceTimersByTimeAsync(10);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("starts a later interval sweep after the active sweep completes", async () => {
    vi.useFakeTimers();
    const sweep = vi.fn(async () => undefined);
    const stop = startLocalRuntimeWorkers({} as never, undefined, {
      initialDelayMs: 0,
      intervalMs: 2,
      runSweep: sweep,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(sweep).toHaveBeenCalledTimes(2);
    await stop();
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
