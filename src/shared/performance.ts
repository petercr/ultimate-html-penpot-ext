/** Optional local profiling hooks. Timings never enter the scene payload. */
export function profileNow(): number {
  // Penpot's plugin compartment does not expose every browser global.
  return typeof performance === "undefined" || typeof performance.now !== "function" ? Date.now() : performance.now();
}

export interface SourceMetrics {
  durationMs: number;
  fetchMs: number;
  stylesheetsMs: number;
  imagesMs: number;
  fontsMs: number;
  svgMs: number;
}

export interface CaptureMetrics {
  viewportId: string;
  nodeCount: number;
  assetCount: number;
  durationMs: number;
  preparationMs: number;
  settleMs: number;
  extractionMs: number;
  /** Included in extractionMs, rather than an additional phase. */
  textMeasurementMs: number;
  styleReads: number;
  geometryReads: number;
  textRangeReads: number;
}

export interface ImportMetrics {
  outcome: "complete" | "cancelled" | "error";
  nodeCount: number;
  assetCount: number;
  /** Actual uploads, after sharing repeated and in-flight media. */
  uploadCount: number;
  maxConcurrentUploads: number;
  /** Included in rendering/text fitting; backend save notifications for large boards. */
  saveWaitCount: number;
  saveWaitMs: number;
  completedNodes: number;
  boardCount: number;
  durationMs: number;
  renderMs: number;
  textFitMs: number;
  commitWaitMs: number;
  /** Scheduler waits are included in renderMs. */
  yieldMs: number;
  yieldCount: number;
}
