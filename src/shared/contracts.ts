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
  radius?: [number, number, number, number];
  opacity?: number;
  boxShadow?: string;
  /** Effective clipping, set only when both axes clip; Penpot containers cannot clip one axis alone. */
  overflow?: "visible" | "hidden" | "clip";
  /** Computed per-axis CSS overflow, retained so single-axis clipping can be diagnosed rather than guessed at. */
  overflowX?: string;
  overflowY?: string;
  transform?: string;
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
}

export interface AssetRef {
  id: string;
  url?: string;
  dataUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
}

export interface SceneNode {
  id: string;
  parentId?: string;
  children: string[];
  kind: SceneKind;
  name: string;
  source: string;
  rect: Rect;
  zIndex: number;
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
  | { type: "IMPORT"; protocolVersion: typeof PROTOCOL_VERSION; scenes: SceneDocument[] }
  | { type: "CANCEL"; protocolVersion: typeof PROTOCOL_VERSION };

export type PluginToUiMessage =
  | { type: "PROGRESS"; completed: number; total: number; label: string }
  | { type: "COMPLETE"; boards: number }
  | { type: "ERROR"; message: string };

export const SCENE_LIMITS = {
  warningLayers: 5_000,
  warningHeight: 30_000,
  maxLayers: 20_000,
  maxHeight: 100_000,
  maxMessageBytes: 25 * 1024 * 1024
} as const;
