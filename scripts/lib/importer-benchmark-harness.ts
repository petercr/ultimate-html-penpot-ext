import { resolveSource } from "../../src/capture/source";
import { capturePage } from "../../src/capture/sandbox";
import { importScenes, ImportCancelledError } from "../../src/importer/penpot";
import { DEFAULT_VIEWPORTS, PROTOCOL_VERSION } from "../../src/shared/contracts";
import { validateScenes } from "../../src/shared/validation";
import type { CaptureMetrics, ImportMetrics, SourceMetrics } from "../../src/shared/performance";
import { assetScenes, singleBoardScene } from "./importer-workloads";

/** Measures our importer and scheduling in Chrome, not Penpot persistence or rendering. */
function mockHost(uploadDelay = false) {
  const boards: MockShape[] = [];
  const uploads = { count: 0, active: 0, peak: 0 };
  const upload = async (name: string) => {
    uploads.count += 1;
    uploads.active += 1;
    uploads.peak = Math.max(uploads.peak, uploads.active);
    const index = Number(name.replace("asset-", "")) || 0;
    if (uploadDelay) await new Promise((resolve) => setTimeout(resolve, [100, 20, 60][index % 3]));
    uploads.active -= 1;
    if (uploadDelay && index % 7 === 0) throw new Error("Controlled upload failure.");
    return { id: name, width: 1, height: 1 };
  };
  const shape = (type: string): MockShape => ({
    type, x: 0, y: 0, width: 0, height: 0, opacity: 1, fills: [], children: [], data: {}, removed: false,
    resize(width: number, height: number) { this.width = width; this.height = height; },
    setPluginData(key: string, value: string) { this.data[key] = value; },
    getPluginData(key: string) { return this.data[key] || ""; },
    appendChild(child: MockShape) { this.children.unshift(child); },
    remove() { this.removed = true; this.children.forEach((child) => child.remove()); }
  });
  const host = {
    viewport: { center: { x: 0, y: 0 } },
    history: { undoBlockBegin: () => Symbol(), undoBlockFinish: () => undefined },
    createBoard: () => { const board = shape("board"); boards.push(board); return board; },
    createRectangle: () => shape("rectangle"),
    createText: () => shape("text"),
    group: (children: MockShape[]) => Object.assign(shape("group"), { children }),
    uploadMediaData: upload,
    uploadMediaUrl: async (name: string) => {
      if (!uploadDelay) throw new Error("Benchmark assets must be inlined.");
      return upload(name);
    },
    createShapeFromSvgWithImages: async () => shape("group"),
    createShapeFromSvg: () => shape("group")
  };
  (globalThis as unknown as { penpot: unknown }).penpot = host;
  return { boards, uploads };
}

interface MockShape {
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  fills: unknown[];
  children: MockShape[];
  data: Record<string, string>;
  removed: boolean;
  resize(width: number, height: number): void;
  setPluginData(key: string, value: string): void;
  getPluginData(key: string): string;
  appendChild(child: MockShape): void;
  remove(): void;
}

export async function runBenchmark(html: string, baseUrl: string) {
  const started = performance.now();
  let source: SourceMetrics | undefined;
  const resolved = await resolveSource(html, baseUrl, undefined, (metrics) => { source = metrics; });
  const capture: CaptureMetrics[] = [];
  const scenes = await capturePage({ protocolVersion: PROTOCOL_VERSION, html: resolved.html, baseUrl: resolved.baseUrl, viewports: DEFAULT_VIEWPORTS, scriptPolicy: "off", settleDelayMs: 0 }, undefined, { deadline: Date.now() + 30_000, onMetrics: (metrics) => capture.push(metrics) });
  validateScenes(scenes);
  const sceneBytes = new TextEncoder().encode(JSON.stringify(scenes));
  const digest = await crypto.subtle.digest("SHA-256", sceneBytes);
  const sceneSha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  let importer: ImportMetrics | undefined;
  const { boards } = mockHost();
  let lastHeartbeat = performance.now();
  let maxHeartbeatGapMs = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, now - lastHeartbeat);
    lastHeartbeat = now;
  }, 16);
  let importedBoards = 0;
  try {
    importedBoards = (await importScenes(scenes, { isCancelled: () => false, onProgress: () => undefined, onMetrics: (metrics) => { importer = metrics; } })).length;
  } finally { clearInterval(heartbeat); }
  if (importedBoards !== DEFAULT_VIEWPORTS.length || boards.some((board) => board.removed)) throw new Error("Benchmark import did not produce all boards.");
  if (document.querySelector("iframe")) throw new Error("Benchmark capture left an iframe behind.");

  // Exercise cancellation separately so its rollback cannot affect the timed import.
  const { boards: cancelledBoards } = mockHost();
  let cancelled = false;
  let cancellationRequestedAt = 0;
  const cancellationTimer = setTimeout(() => { cancellationRequestedAt = performance.now(); cancelled = true; }, 20);
  let cancellationLatencyMs: number | undefined;
  try {
    await importScenes(scenes, { isCancelled: () => cancelled, onProgress: () => undefined });
    throw new Error("Benchmark cancellation was ignored.");
  } catch (error) {
    if (!(error instanceof ImportCancelledError)) throw error;
    cancellationLatencyMs = performance.now() - cancellationRequestedAt;
    if (cancellationLatencyMs > 50) throw new Error(`Cancellation took ${cancellationLatencyMs.toFixed(1)}ms in the mock host.`);
    if (!cancelledBoards.length || cancelledBoards.some((board) => !board.removed)) throw new Error("Cancellation left a partial board behind.");
  } finally { clearTimeout(cancellationTimer); }
  return { source, capture, importer, sceneSha256, sceneBytes: sceneBytes.byteLength, maxHeartbeatGapMs, cancellationLatencyMs, durationMs: performance.now() - started };
}

export async function runWorkload(mode: "assets" | "single-board", size: number) {
  const scenes = mode === "assets" ? assetScenes(size) : [singleBoardScene(size)];
  validateScenes(scenes);
  const { boards, uploads } = mockHost(mode === "assets");
  let importer: ImportMetrics | undefined;
  const diagnostics: unknown[] = [];
  await importScenes(scenes, { isCancelled: () => false, onProgress: () => undefined, onDiagnostic: (item) => diagnostics.push(item), onMetrics: (metrics) => { importer = metrics; } });
  if (boards.length !== scenes.length || boards.some((board) => board.removed)) throw new Error("Workload did not produce the expected boards.");
  if (mode === "single-board" && boards[0].children.length !== size - 1) throw new Error("Single-board workload lost layers.");
  if (mode === "assets" && (uploads.count !== size || uploads.active !== 0)) throw new Error("Asset workload retried or left an active upload.");
  const serialized = JSON.stringify({ boards, diagnostics });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  return { importer, uploads, outputSha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""), sceneBytes: new TextEncoder().encode(JSON.stringify(scenes)).byteLength };
}
