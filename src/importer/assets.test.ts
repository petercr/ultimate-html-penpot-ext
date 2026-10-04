import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaUploads } from "./assets";

const asset = (index: number) => ({ id: `asset-${index}`, url: `https://example.test/${index}.png` });
function deferredUploads() {
  const finish: Array<(value: unknown) => void> = [];
  const upload = vi.fn(() => new Promise((resolve) => finish.push(resolve)));
  vi.stubGlobal("penpot", { uploadMediaUrl: upload });
  return { upload, finish };
}

afterEach(() => vi.unstubAllGlobals());

describe("bounded media uploads", () => {
  it("uploads shared base64 bytes without relying on the host fetch response", async () => {
    const upload = vi.fn().mockResolvedValue({ id: "image" });
    vi.stubGlobal("penpot", { uploadMediaData: upload });
    vi.stubGlobal("fetch", undefined);
    const pool = new MediaUploads(() => false);
    const dataUrl = "data:image/png;base64,%2FwA%2B\n";
    const first = pool.get({ id: "inline", dataUrl });
    expect(pool.get({ id: "shared", url: dataUrl })).toBe(first);
    await expect(first).resolves.toMatchObject({ media: { id: "image" } });
    expect(upload).toHaveBeenCalledExactlyOnceWith("inline", new Uint8Array([255, 0, 62]), "image/png");
  });

  it("preserves percent-encoded binary bytes and UTF-8 without TextEncoder", async () => {
    const upload = vi.fn().mockResolvedValue({ id: "image" });
    vi.stubGlobal("penpot", { uploadMediaData: upload });
    vi.stubGlobal("TextEncoder", undefined);
    const pool = new MediaUploads(() => false);
    await pool.get({ id: "binary", dataUrl: "data:image/png,%00%FF%89+" });
    expect(upload).toHaveBeenCalledWith("binary", new Uint8Array([0, 255, 137, 43]), "image/png");
    await pool.get({ id: "unicode", dataUrl: "data:image/svg+xml;charset=UTF-8,%3Csvg%3Eé👩%3C%2Fsvg%3E" });
    expect(upload).toHaveBeenCalledWith("unicode", new Uint8Array([60, 115, 118, 103, 62, 195, 169, 240, 159, 145, 169, 60, 47, 115, 118, 103, 62]), "image/svg+xml");
  });

  it("caches malformed inline media failures without blocking unrelated uploads", async () => {
    const upload = vi.fn().mockResolvedValue({ id: "valid" });
    vi.stubGlobal("penpot", { uploadMediaData: upload });
    const pool = new MediaUploads(() => false);
    const invalid = { id: "invalid", dataUrl: "data:image/png;base64,?" };
    const result = pool.get(invalid);
    expect(pool.get(invalid)).toBe(result);
    await expect(result).resolves.toHaveProperty("failure");
    await expect(pool.get({ id: "valid", dataUrl: "data:image/png;base64,AQID" })).resolves.toMatchObject({ media: { id: "valid" } });
    expect(upload).toHaveBeenCalledOnce();
  });

  it("starts at most three uploads and shares in-flight, successful, and failed results", async () => {
    const { upload, finish } = deferredUploads();
    const pool = new MediaUploads(() => false);
    pool.prefetch(Array.from({ length: 6 }, (_, index) => asset(index)));
    expect(upload).toHaveBeenCalledTimes(3);
    const first = pool.get(asset(0));
    expect(pool.get({ ...asset(0), id: "another-id" })).toBe(first);
    finish[2]({ id: "third" });
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(4));
    finish[0]({ id: "first" });
    await expect(first).resolves.toMatchObject({ media: { id: "first" } });
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(5));
    finish[1](undefined);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(6));
    for (const resolve of finish.slice(3)) resolve({});
    await pool.drain();
    expect(pool.get(asset(0))).toBe(first);
    await expect(pool.get(asset(1))).resolves.toMatchObject({ failure: "Penpot did not return uploaded media." });
    expect(upload).toHaveBeenCalledTimes(6);
    expect(pool.peakConcurrency).toBe(3);
  });

  it("caches upload exceptions and continues unrelated queued work", async () => {
    const upload = vi.fn().mockRejectedValueOnce(new Error("controlled failure")).mockResolvedValue({ id: "ok" });
    vi.stubGlobal("penpot", { uploadMediaUrl: upload });
    const pool = new MediaUploads(() => false);
    pool.prefetch([asset(0), asset(1), asset(2), asset(3)]);
    await expect(pool.get(asset(0))).resolves.toEqual({ failure: "controlled failure" });
    await expect(pool.get(asset(3))).resolves.toMatchObject({ media: { id: "ok" } });
    await pool.drain();
    await expect(pool.get({ ...asset(0), id: "shared-failure" })).resolves.toEqual({ failure: "controlled failure" });
    expect(upload).toHaveBeenCalledTimes(4);
  });

  it("drops queued uploads after cancellation and waits for active host calls to settle", async () => {
    const { upload, finish } = deferredUploads();
    let cancelled = false;
    const pool = new MediaUploads(() => cancelled);
    pool.prefetch(Array.from({ length: 8 }, (_, index) => asset(index)));
    let drained = false;
    cancelled = true;
    pool.stop();
    const pending = pool.drain().then(() => { drained = true; });
    await expect(pool.get(asset(7))).resolves.toEqual({});
    finish[0]({});
    await vi.waitFor(() => expect(pool.get(asset(0))).resolves.toMatchObject({ media: {} }));
    expect(drained).toBe(false);
    expect(upload).toHaveBeenCalledTimes(3);
    finish[1]({});
    finish[2]({});
    await pending;
    expect(drained).toBe(true);
    expect(upload).toHaveBeenCalledTimes(3);
  });
});
