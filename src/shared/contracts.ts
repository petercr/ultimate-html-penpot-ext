export const PROTOCOL_VERSION = 1 as const;

export type ScriptPolicy = "off" | "trusted";
export type Severity = "info" | "warning" | "error";
export type SceneKind = "container" | "box" | "text" | "image" | "svg" | "fallback";
export type LayoutKind = "none" | "flex" | "grid";

export interface ViewportSpec {
  id: string;
  name: string;
  width: number;
  height: number;
}

export const DEFAULT_VIEWPORTS: ViewportSpec[] = [
  { id: "desktop", name: "Desktop", width: 1440, height: 900 },
  { id: "tablet", name: "Tablet", width: 768, height: 1024 },
  { id: "mobile", name: "Mobile", width: 390, height: 844 }
];

export interface CaptureRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  html: string;
  baseUrl?: string;
  viewports: ViewportSpec[];
  scriptPolicy: ScriptPolicy;
  settleDelayMs: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SceneBorder {
  color: string;
  width: number;
  style: string;
}

export interface SceneBorders {
  top: SceneBorder;
  right: SceneBorder;
  bottom: SceneBorder;
  left: SceneBorder;
}

export interface ScenePaint {
  backgroundColor?: string;
  backgroundImage?: string;
  /** Computed CSS background placement retained for asset materialization and diagnostics. */
  backgroundRepeat?: string;
  backgroundRepeatX?: string;
  backgroundRepeatY?: string;
  backgroundSize?: string;
  backgroundPosition?: string;
  backgroundPositionX?: string;
  backgroundPositionY?: string;
  color?: string;
  borderColor?: string;
  borderWidth?: number;
  borderStyle?: string;
  /** All computed sides when their color, width, or style differs. Uniform
   * borders keep the legacy borderColor/borderWidth/borderStyle fields. */
  borders?: SceneBorders;
  radius?: [number, number, number, number];
  opacity?: number;
  boxShadow?: string;
  /** Effective clipping, set only when both axes clip; Penpot containers cannot clip one axis alone. */
  overflow?: "visible" | "hidden" | "clip";
  /** Computed per-axis CSS overflow, retained so single-axis clipping can be diagnosed rather than guessed at. */
  overflowX?: string;
  overflowY?: string;
}

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: string;
  /** Unitless line-height multiplier used by Penpot (for example, 1.35). */
  lineHeight: number;
  letterSpacing: number;
  textAlign: string;
  textDecoration: string;
  textTransform: string;
}

export interface SceneLayout {
  kind: LayoutKind;
  direction?: "row" | "row-reverse" | "column" | "column-reverse";
  wrap?: "wrap" | "nowrap";
  justifyContent?: string;
  alignItems?: string;
  rowGap?: number;
  columnGap?: number;
  padding?: [number, number, number, number];
  absolute?: boolean;
  /** True when CSS position is not static. Positioned elements with an
   * automatic or zero z-index paint above non-positioned in-flow content. */
  positioned?: boolean;
}

export interface AssetRef {
  id: string;
  url?: string;
  dataUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
}

export interface SceneImagePositionAxis {
  /** Fraction of the space remaining after sizing the image; 0.5 centers it.
   * CSS positions outside the 0..1 interval are valid. */
  percentage: number;
  /** Additional offset in captured page pixels, after any uniform transform. */
  offset: number;
}

export interface SceneImageFit {
  fit: "fill" | "contain" | "cover" | "none" | "scale-down";
  position: { x: SceneImagePositionAxis; y: SceneImagePositionAxis };
  /** Browser natural dimensions in CSS pixels, including srcset density
   * correction. These remain unchanged by CSS transforms. */
  intrinsicWidth: number;
  intrinsicHeight: number;
  /** Uniform CSS transform scale. Defaults to 1 for older scene producers. */
  scale?: number;
}

export interface SceneNode {
  id: string;
  parentId?: string;
  children: string[];
  kind: SceneKind;
  name: string;
  source: string;
  /** Captured box in page pixels. For a transformed layer this is the layer's
   * own (scaled) size plus the position of its top-left corner after every
   * CSS transform; see `rotation`. */
  rect: Rect;
  /** Clockwise rotation in degrees (the CSS convention) about the top-left
   * corner of `rect`. Absent when no transform rotates the layer. */
  rotation?: number;
  /** Effective integer z-index. `z-index: auto` is stored as 0 (its paint
   * position for positioned elements) with `zIndexAuto` set, so explicit
   * numeric zero stays distinct from automatic stacking. */
  zIndex: number;
  /** True when the computed CSS z-index is `auto` rather than numeric. */
  zIndexAuto?: boolean;
  paint: ScenePaint;
  layout: SceneLayout;
  text?: string;
  /** Keep a captured source line on one line when imported. */
  textNoWrap?: boolean;
  /** Horizontal fit scale for a captured line that exceeds its source bounds. */
  textFitScale?: number;
  /** Right-edge space available to a non-wrapping captured text line. */
  textMaxWidth?: number;
  textStyle?: TextStyle;
  assetId?: string;
  /** Replaced image sizing inside the content box (border and padding excluded).
   * Absent for legacy scenes or images without usable natural dimensions. */
  image?: SceneImageFit;
  fallbackReason?: string;
}

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  viewportId?: string;
  source?: string;
}

export interface SceneDocument {
  protocolVersion: typeof PROTOCOL_VERSION;
  viewport: ViewportSpec;
  documentSize: { width: number; height: number };
  nodes: SceneNode[];
  assets: AssetRef[];
  diagnostics: Diagnostic[];
}

export type UiToPluginMessage =
  | { type: "IMPORT"; protocolVersion: typeof PROTOCOL_VERSION; runId: string; scenes: SceneDocument[]; /** Opt in to native Penpot flex layouts; absent or false keeps the fixed snapshot. */ nativeLayout?: boolean }
  | { type: "CANCEL"; protocolVersion: typeof PROTOCOL_VERSION; runId: string };

export type PluginToUiMessage =
  | { type: "PROGRESS"; runId: string; completed: number; total: number; label: string }
  | { type: "DIAGNOSTIC"; runId: string; diagnostic: Diagnostic }
  | { type: "COMPLETE"; runId: string; boards: number }
  | { type: "ERROR"; runId: string; message: string };

export const SCENE_LIMITS = {
  warningLayers: 5_000,
  warningHeight: 30_000,
  maxScenes: 24,
  maxLayers: 20_000,
  maxTotalLayers: 50_000,
  maxDimension: 100_000,
  maxHeight: 100_000,
  maxMessageBytes: 25 * 1024 * 1024
} as const;
