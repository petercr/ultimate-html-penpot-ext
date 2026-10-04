import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardPersistence, PERSISTENCE_BATCH_NODES } from "./persistence";

describe("large-board persistence checkpoints", () => {
  let saved: () => void;
  let off: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    off = vi.fn();
    vi.stubGlobal("penpot", { on: vi.fn((_event, callback) => { saved = callback; return Symbol.for("save-listener"); }), off });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("waits after a bounded batch and only accepts saves following its latest write", async () => {
    const onWait = vi.fn();
    const batches = new BoardPersistence(() => undefined, onWait);
    batches.markDirty();
    saved();
    // An earlier save does not acknowledge a new write.
    batches.markDirty();
    for (let index = 0; index < PERSISTENCE_BATCH_NODES - 1; index++) expect(batches.checkpoint()).toBeUndefined();
    const pending = batches.checkpoint();
    expect(pending).toBeInstanceOf(Promise);
    let complete = false;
    pending!.then(() => { complete = true; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(complete).toBe(false);
    saved();
    await pending;
    expect(complete).toBe(true);
    expect(onWait).toHaveBeenCalledOnce();
    expect(batches.waitCount).toBe(1);
    expect(batches.waitMs).toBe(1000);
    expect(vi.getTimerCount()).toBe(0);
    batches.close();
    expect(off).toHaveBeenCalledWith(Symbol.for("save-listener"));
  });

  it("does not wait for batches without mutations or for an already acknowledged write", () => {
    const onWait = vi.fn();
    const batches = new BoardPersistence(() => undefined, onWait);
    for (let index = 0; index < PERSISTENCE_BATCH_NODES * 2; index++) expect(batches.checkpoint()).toBeUndefined();
    batches.markDirty();
    saved();
    expect(batches.flush()).toBeUndefined();
    expect(batches.waitCount).toBe(0);
    expect(onWait).not.toHaveBeenCalled();
    batches.close();
  });

  it("rejects promptly on cancellation and clears all waiting timers", async () => {
    let cancelled = false;
    const cancellation = new Error("cancelled");
    const batches = new BoardPersistence(() => { if (cancelled) throw cancellation; }, () => undefined);
    batches.markDirty();
    const rejection = expect(batches.flush()).rejects.toBe(cancellation);
    cancelled = true;
    await vi.advanceTimersByTimeAsync(4);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
    batches.close();
  });

  it("fails clearly instead of reporting success when the host never confirms a save", async () => {
    const batches = new BoardPersistence(() => undefined, () => undefined);
    batches.markDirty();
    const rejection = expect(batches.flush()).rejects.toThrow("Penpot did not confirm saving this board within 30 seconds");
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
    batches.close();
  });
});
