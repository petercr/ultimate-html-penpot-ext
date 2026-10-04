import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImportScheduler } from "./scheduler";

describe("import scheduling", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }));
  afterEach(() => vi.useRealTimers());

  it("batches inexpensive layers but releases the event loop at the unit limit", async () => {
    const scheduler = new ImportScheduler(8, 100);
    for (let index = 0; index < 99; index += 1) expect(scheduler.checkpoint()).toBeUndefined();
    const pause = scheduler.checkpoint();
    expect(pause).toBeInstanceOf(Promise);
    expect(scheduler.yieldCount).toBe(1);
    await vi.runAllTimersAsync();
    await pause;
    expect(scheduler.checkpoint()).toBeUndefined();
  });

  it("yields after expensive work even before the unit limit and resets the time budget", async () => {
    const scheduler = new ImportScheduler();
    vi.advanceTimersByTime(4);
    const pause = scheduler.checkpoint();
    expect(pause).toBeInstanceOf(Promise);
    await vi.runAllTimersAsync();
    await pause;
    expect(scheduler.checkpoint()).toBeUndefined();
    expect(scheduler.yieldCount).toBe(1);
  });
});
