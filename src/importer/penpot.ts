import type { Board, Fill, Gradient, Shape, Text } from "@penpot/plugin-types";
import type { AssetRef, Diagnostic, SceneDocument, SceneNode, ScenePaint } from "../shared/contracts";
import { profileNow, type ImportMetrics } from "../shared/performance";
import { ImportScheduler } from "./scheduler";
import { MediaUploads, mediaKey } from "./assets";
import { BoardPersistence, LARGE_BOARD_NODES } from "./persistence";
import { borderInsets, borderPolygons, borderWidth, hasBorder, uniformBorder } from "./borders";
import { imageGeometry } from "../shared/images";
import { svgImageGeometry } from "./svgImage";

export class ImportCancelledError extends Error {
  constructor() { super("Import cancelled."); }
}

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Penpot returned an empty error.";
}

export interface ImportOptions {
  isCancelled: () => boolean;
  onProgress: (completed: number, total: number, label: string) => void;
  onDiagnostic?: (diagnostic: Diagnostic) => void;
  onMetrics?: (metrics: ImportMetrics) => void;
}

const IMPORT_NAMESPACE = "ultimate-html-to-penpot";

interface ParsedColor {
  color: string;
  opacity: number;
}

function clampOpacity(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function cssColorWithOpacity(value: string | undefined, preserveTransparent = false): ParsedColor | undefined {
  // A transparent text run must still receive an explicit fill. Leaving its
  // fills empty makes Penpot use the host's default (normally opaque black).
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "transparent") return preserveTransparent ? { color: "#000000", opacity: 0 } : undefined;
  const hex = normalized.match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i)?.[1];
  if (hex) {
    const expanded = hex.length <= 4 ? [...hex].map((part) => part + part).join("") : hex;
    const color = `#${expanded.slice(0, 6)}`;
    const alpha = expanded.length === 8 ? Number.parseInt(expanded.slice(6), 16) / 255 : 1;
    return alpha === 0 && !preserveTransparent ? undefined : { color, opacity: alpha };
  }
  const match = normalized.match(/^(rgba?)\((.*)\)$/i);
  if (!match) return undefined;
  const content = match[2].trim();
  let channelParts: string[];
  let alphaPart: string | undefined;
  if (content.includes(",")) {
    const parts = content.split(",").map((part) => part.trim());
    if (parts.length !== 3 && parts.length !== 4 || parts.some((part) => !part)) return undefined;
    channelParts = parts.slice(0, 3);
    alphaPart = parts[3];
  } else {
    const slashParts = content.split("/");
    if (slashParts.length > 2) return undefined;
    channelParts = slashParts[0].trim().split(/\s+/).filter(Boolean);
    alphaPart = slashParts[1]?.trim();
    if (channelParts.length !== 3 || slashParts.length === 2 && !alphaPart) return undefined;
  }
  const numberToken = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
  const channel = (part: string): number | undefined => {
    const source = part.trim();
    const percent = source.endsWith("%");
    const numeric = percent ? source.slice(0, -1) : source;
    if (!numberToken.test(numeric)) return undefined;
    const parsed = Number(numeric);
    if (!Number.isFinite(parsed)) return undefined;
    return Math.round(Math.min(255, Math.max(0, percent ? parsed * 255 / 100 : parsed)));
  };
  const alpha = (part: string | undefined): number | undefined => {
    if (part === undefined) return 1;
    const source = part.trim();
    const percent = source.endsWith("%");
    const numeric = percent ? source.slice(0, -1) : source;
    if (!numberToken.test(numeric)) return undefined;
    const parsed = Number(numeric);
    return Number.isFinite(parsed) ? clampOpacity(percent ? parsed / 100 : parsed) : undefined;
  };
  const channels = channelParts.map(channel);
  const opacity = alpha(alphaPart);
  if (channels.some((part) => part === undefined) || opacity === undefined) return undefined;
  const color = `#${(channels as number[]).map((part) => part.toString(16).padStart(2, "0")).join("")}`;
  return opacity === 0 && !preserveTransparent ? undefined : { color, opacity };
}

function cssColor(value: string | undefined): string | undefined {
  return cssColorWithOpacity(value)?.color;
}

function cssFunctionArguments(value: string): string[] {
  const argumentsText = value.slice(value.indexOf("(") + 1, value.lastIndexOf(")"));
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < argumentsText.length; index += 1) {
    const character = argumentsText[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "(") { depth += 1; continue; }
    if (character === ")") { depth = Math.max(0, depth - 1); continue; }
    if (character === "," && depth === 0) {
      result.push(argumentsText.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(argumentsText.slice(start).trim());
  return result.filter(Boolean);
}

interface GradientStop {
  color: string;
  opacity: number;
  offset?: number;
}

function gradientStop(value: string): GradientStop | undefined {
  const match = value.match(/^\s*(transparent|rgba?\([^)]*\)|#[\da-f]{3,8})(?:\s+(.+))?\s*$/i);
  const parsed = cssColorWithOpacity(match?.[1], true);
  if (!parsed) return undefined;
  // Percentages map directly to Penpot's normalized stop offsets. Pixel and
  // length-based positions depend on the rendered gradient line, which is
  // not available in the scene document, so retain CSS's interpolated offset
  // for those cases rather than inventing an incorrect absolute position.
  const percentage = match?.[2]?.match(/(?:^|\s)(-?\d+(?:\.\d+)?)%/);
  const offset = percentage ? clampOpacity(Number(percentage[1]) / 100) : undefined;
  return { ...parsed, offset };
}

function resolvedGradientOffsets(stops: GradientStop[]): number[] {
  const offsets = stops.map((stop) => stop.offset);
  if (offsets[0] === undefined) offsets[0] = 0;
  if (offsets[offsets.length - 1] === undefined) offsets[offsets.length - 1] = 1;
  // CSS's color-stop fixup first clamps every explicit stop against its
  // previous explicit/effective position. Only then are runs of omitted
  // positions interpolated, so an omitted stop never creates a backwards
  // segment that gets flattened after the fact.
  let previous = 0;
  for (let index = 0; index < offsets.length; index += 1) {
    if (offsets[index] !== undefined) {
      previous = Math.max(previous, clampOpacity(offsets[index] as number));
      offsets[index] = previous;
    }
  }
  for (let index = 0; index < offsets.length; index += 1) {
    if (offsets[index] !== undefined) continue;
    let next = index + 1;
    while (next < offsets.length && offsets[next] === undefined) next += 1;
    const start = offsets[index - 1] as number;
    const end = offsets[next] as number;
    const count = next - index + 1;
    for (let fill = index; fill < next; fill += 1) offsets[fill] = start + (end - start) * (fill - index + 1) / count;
    index = next;
  }
  return offsets as number[];
}

function gradientPrelude(type: "linear" | "radial", value: string | undefined): boolean {
  const source = value?.trim().toLowerCase() || "";
  if (type === "linear") {
    return /^(?:-?(?:\d+(?:\.\d*)?|\.\d+)deg|to\s+(?:(?:left|right)(?:\s+(?:top|bottom))?|(?:top|bottom)(?:\s+(?:left|right))?))$/.test(source);
  }
  // Keep the existing radial approximation for CSS's common geometry
  // preludes, including a position on its own and explicit radius lengths.
  // This deliberately recognizes geometry syntax only; a color hint or an
  // unsupported color function cannot take this path and be silently skipped.
  const number = "-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
  const position = "(?:(?:left|center|right|top|bottom|" + number + "%)\\s*){1,2}";
  const length = number + "(?:px|em|rem|vw|vh|vmin|vmax|cm|mm|q|in|pt|pc)";
  const size = "(?:closest-side|closest-corner|farthest-side|farthest-corner|" + length + "(?:\\s+" + length + ")?)";
  return new RegExp("^(?:at\\s+" + position + "|(?:(?:circle|ellipse)(?:\\s+" + size + ")?|" + size + ")(?:\\s+at\\s+" + position + ")?)$").test(source);
}

function cssGradient(value: string | undefined): Gradient | undefined {
  const normalized = value?.trim().toLowerCase();
  const type = normalized?.startsWith("linear-gradient") ? "linear" : normalized?.startsWith("radial-gradient") ? "radial" : undefined;
  if (!type) return undefined;
  const source = value as string;
  const parts = cssFunctionArguments(source);
  // The optional first item is a direction/shape. Every remaining item must
  // be understood: filtering failed stops would silently change a gradient's
  // colors and stop interpolation.
  const stopParts = gradientStop(parts[0]) ? parts : gradientPrelude(type, parts[0]) ? parts.slice(1) : [];
  const parsedStops = stopParts.map(gradientStop);
  if (parsedStops.length < 2 || parsedStops.some((stop) => !stop)) return undefined;
  const colors = parsedStops as GradientStop[];
  const offsets = resolvedGradientOffsets(colors);
  const stops = colors.map(({ color, opacity }, index) => ({ color, opacity, offset: offsets[index] }));
  if (type === "radial") return { type: "radial", startX: 0.5, startY: 0.5, endX: 1, endY: 0.5, width: 0.5, stops };
  const angle = source.match(/(-?\d+(?:\.\d+)?)deg/);
  const degrees = angle ? Number(angle[1]) : 180;
  const radians = (degrees - 90) * Math.PI / 180;
  return { type: "linear", startX: 0.5 - Math.cos(radians) / 2, startY: 0.5 - Math.sin(radians) / 2, endX: 0.5 + Math.cos(radians) / 2, endY: 0.5 + Math.sin(radians) / 2, width: 1, stops };
}

function applyShadow(shape: Shape, value: string | undefined): void {
  if (!value || value === "none") return;
  const color = cssColorWithOpacity((value.match(/rgba?\([^)]*\)|#[\da-f]{3,8}/i) || [])[0]);
  const dimensions = (value.match(/-?\d+(?:\.\d+)?px/g) || []).map((dimension) => Number.parseFloat(dimension));
  if (!color || dimensions.length < 3) return;
  shape.shadows = [{ style: value.includes("inset") ? "inner-shadow" : "drop-shadow", offsetX: dimensions[0], offsetY: dimensions[1], blur: dimensions[2], spread: dimensions[3] || 0, color: { color: color.color, opacity: color.opacity } }];
}

/** Capture reports clipping only when both CSS axes clip; see the extractor. */
function clipsContent(paint: ScenePaint): boolean {
  return paint.overflow === "hidden" || paint.overflow === "clip";
}

function applyPaint(shape: Shape, paint: ScenePaint): void {
  const color = cssColorWithOpacity(paint.backgroundColor);
  const gradient = cssGradient(paint.backgroundImage);
  // CSS paints a background color before its image layers. Keep the element
  // opacity on the shape, otherwise a translucent color receives opacity
  // twice (once in its fill and once on its container).
  const fills: Fill[] = [
    ...(color ? [{ fillColor: color.color, fillOpacity: color.opacity }] : []),
    ...(gradient ? [{ fillColorGradient: gradient }] : [])
  ];
  if ("fills" in shape && shape.type !== "group") (shape as Shape & { fills: Fill[] }).fills = fills;
  shape.opacity = paint.opacity ?? 1;
  if (paint.radius) {
    [shape.borderRadiusTopLeft, shape.borderRadiusTopRight, shape.borderRadiusBottomRight, shape.borderRadiusBottomLeft] = paint.radius;
  }
  const border = uniformBorder(paint);
  const stroke = cssColorWithOpacity(border?.color);
  shape.strokes = [];
  if (stroke && border?.width && (border.style === "solid" || border.style === "dashed" || border.style === "dotted")) {
    // CSS borders paint inside the border box, so the stroke stays inside the
    // captured rect. A centered stroke would extend half its width outside on
    // every side and shift each bordered card's visible edges outward.
    shape.strokes = [{ strokeColor: stroke.color, strokeOpacity: stroke.opacity, strokeWidth: border.width, strokeStyle: border.style, strokeAlignment: "inner" }];
  }
  applyShadow(shape, paint.boxShadow);
  if (clipsContent(paint) && shape.type === "board") (shape as Board).clipContent = true;
}

/**
 * Top-left of the bounding box of a width × height rectangle rotated clockwise
 * by `degrees` about `origin`, which is the rectangle's own top-left corner.
 * A rotated Penpot layer is addressed by this box rather than by its corner.
 */
export function rotatedBoundsOrigin(origin: { x: number; y: number }, width: number, height: number, degrees: number): { x: number; y: number } {
  const radians = degrees * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: origin.x + Math.min(0, width * cos, -height * sin, width * cos - height * sin),
    y: origin.y + Math.min(0, width * sin, height * cos, width * sin + height * cos)
  };
}

function applyGeometry(shape: Shape, node: SceneNode, pageOrigin: { x: number; y: number }, minimumDimension = 0.1): void {
  // Penpot stores a nested shape's coordinates in page space. Set these only
  // after parentage is established; setting local DOM coordinates beforehand
  // puts children outside their clipping board.
  // Captured geometry is a fixed snapshot. Explicit top/left constraints stop
  // the host from stretching or repositioning it when a parent is resized.
  pinShapeConstraints(shape);
  const width = Math.max(minimumDimension, node.rect.width);
  const height = Math.max(minimumDimension, node.rect.height);
  const x = pageOrigin.x + node.rect.x;
  const y = pageOrigin.y + node.rect.y;
  shape.x = x;
  shape.y = y;
  shape.resize(width, height);
  if (!node.rotation) return;
  // The captured rect is the layer's own size with its top-left corner at the
  // transformed position. The host turns a layer about its center, snaps the
  // result to whole pixels, and reports x/y as the rotated bounding box, so
  // rotate after sizing and then place that box exactly.
  // Rotate in the same turn that created the layer. The host stalls the whole
  // tab when a text layer in a board is rotated after its text has been laid
  // out (observed on Penpot 2.18.1); rotation at creation time is safe.
  shape.rotation = node.rotation;
  const bounds = rotatedBoundsOrigin({ x, y }, width, height, node.rotation);
  shape.x = bounds.x;
  shape.y = bounds.y;
}

/** Position an element-local rectangle in the element's composed frame. */
function localFrame(node: SceneNode, rect: SceneNode["rect"]): SceneNode {
  const radians = (node.rotation ?? 0) * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { ...node, rect: {
    x: node.rect.x + rect.x * cos - rect.y * sin,
    y: node.rect.y + rect.x * sin + rect.y * cos,
    width: rect.width,
    height: rect.height
  } };
}

function pinShapeConstraints(shape: Shape): void {
  shape.constraintsHorizontal = "left";
  shape.constraintsVertical = "top";
}

function fixBoardSizing(board: Board): void {
  // Do not let Penpot's board sizing defaults derive a captured board's bounds
  // from its children; CSS overflow deliberately allows those bounds to differ.
  board.horizontalSizing = "fix";
  board.verticalSizing = "fix";
}

function textAlign(value: string): Text["align"] {
  return ["left", "right", "center", "justify"].includes(value) ? value as Text["align"] : "left";
}

const GENERIC_FONT_FAMILIES = new Set([
  "caption",
  "icon",
  "menu",
  "message-box",
  "small-caption",
  "status-bar",
  "-apple-system",
  "blinkmacsystemfont",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "sans-serif",
  "serif",
  "monospace",
  "cursive",
  "fantasy",
  "math"
]);

function penpotFontFamily(value: string | undefined): string {
  const family = value?.split(",")[0].replace(/["']/g, "").trim() || "Inter";
  return GENERIC_FONT_FAMILIES.has(family.toLowerCase()) ? "Inter" : family;
}

function penpotFontCandidates(value: string | undefined): string[] {
  const family = penpotFontFamily(value);
  if (family === "Inter") return [family];
  // Some webfont CSS declares the PostScript face name as the family, for
  // example `Poppins-Regular`. Penpot usually registers the family as
  // `Poppins`, so try that normalized name before falling back.
  const normalized = family.replace(/(?:[-_](?:regular|normal|italic|oblique|thin|extralight|light|medium|semibold|bold|extrabold|black)|[-_]\d{3})$/i, "");
  return normalized && normalized !== family ? [family, normalized, "Inter"] : [family, "Inter"];
}

function applyPenpotFontFamily(text: Text, value: string | undefined): void {
  for (const family of penpotFontCandidates(value)) {
    try {
      text.fontFamily = family;
      return;
    } catch {
      // Browser fonts are not necessarily installed in Penpot. Try the
      // normalized family and finally the guaranteed Inter fallback.
    }
  }
}

function textFitScale(node: SceneNode): number {
  return Math.min(1, Math.max(0.01, node.textFitScale ?? 1));
}

function applyTextSizing(text: Text, style: NonNullable<SceneNode["textStyle"]>, scale: number): void {
  const baseFontSize = Math.max(1, style.fontSize);
  const effectiveScale = Math.max(0.01, scale);
  text.fontSize = String(Math.max(1, baseFontSize * effectiveScale));
  // Scene text styles use Penpot's unitless line-height multiplier. Scale
  // the multiplier inversely so reducing width does not collapse the source
  // line box vertically.
  text.lineHeight = String(Math.max(0.01, style.lineHeight / effectiveScale));
  // CSS permits negative tracking; Penpot's text API currently does not.
  text.letterSpacing = String(Math.max(0, style.letterSpacing * effectiveScale));
}

type TrackShape = <T extends Shape>(shape: T) => T;
/** Attaches a new layer to its parent and applies its captured geometry. */
type PlaceShape = (shape: Shape) => void;

function createText(node: SceneNode, track: TrackShape): Text {
  const text = penpot.createText(node.text || "");
  if (!text) throw new Error(`Unable to create text layer: ${node.name}`);
  track(text);
  const style = node.textStyle;
  text.growType = "fixed";
  // CSS lays inline content out from the top of its line box. Make that
  // explicit because a Penpot text layer's editor default can be center.
  text.verticalAlign = "top";
  text.direction = "ltr";
  text.characters = node.text || "";
  if (style) {
    // CSS generic families (for example `system-ui`) are valid in a browser
    // but rejected by Penpot's fontFamily validator. Inter is Penpot's
    // guaranteed fallback and keeps the layer editable instead of aborting
    // the entire import.
    applyPenpotFontFamily(text, style.fontFamily);
    // Penpot's plugin API expects numeric string values, not CSS units.
    applyTextSizing(text, style, textFitScale(node));
    text.fontWeight = String(style.fontWeight);
    text.fontStyle = style.fontStyle === "italic" ? "italic" : "normal";
    // Captured line coordinates already include browser alignment offsets.
    text.align = node.textNoWrap ? "left" : textAlign(style.textAlign);
    const textTransform = ["uppercase", "lowercase", "capitalize"].find((value) => value === style.textTransform);
    if (textTransform) text.textTransform = textTransform as Text["textTransform"];
    if (style.textDecoration.includes("line-through")) text.textDecoration = "line-through";
    else if (style.textDecoration.includes("underline")) text.textDecoration = "underline";
  }
  const color = cssColorWithOpacity(node.paint.color, true);
  if (color) text.fills = [{ fillColor: color.color, fillOpacity: color.opacity }];
  text.opacity = node.paint.opacity ?? 1;
  return text;
}

function constrainTextToCapturedWidth(text: Text, node: SceneNode, maximum: number): boolean {
  const actual = text.width;
  if (!maximum || !Number.isFinite(actual) || actual <= maximum + 0.01 || !node.textStyle) return false;
  const scale = Number(text.fontSize) / Math.max(1, node.textStyle.fontSize) * (maximum - 0.5) / actual;
  applyTextSizing(text, node.textStyle, scale);
  return true;
}

function svgTextOf(asset: AssetRef | undefined): string | undefined {
  const url = asset?.dataUrl || asset?.url;
  if (!url || !url.toLowerCase().startsWith("data:image/svg+xml")) return undefined;
  const comma = url.indexOf(",");
  if (comma < 0) return undefined;
  const encoded = url.slice(comma + 1);
  if (url.slice(0, comma).toLowerCase().endsWith(";base64")) {
    try {
      const binary = atob(encoded);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      if (typeof TextDecoder === "function") {
        try { return new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim(); } catch { /* Use the binary fallback below. */ }
      }
      return binary;
    } catch { return undefined; }
  }
  try {
    const svg = decodeURIComponent(encoded).trim();
    return /<svg[\s>]/i.test(svg) ? svg : undefined;
  } catch { return undefined; }
}

/** An SVG image renders its source into the CSS object viewport. In particular,
 * object-fit:fill changes that viewport while the SVG's preserveAspectRatio
 * still applies inside it. Uploading the original viewport and stretching the
 * pixels would distort its contents. Keep that rule in a size-specific asset. */
function fittedImageAsset(node: SceneNode, asset: AssetRef | undefined, rect: SceneNode["rect"]): AssetRef | undefined {
  const svg = svgTextOf(asset);
  if (!asset || !svg || !node.image) return asset;
  const width = rect.width / (node.image.scale ?? 1);
  const height = rect.height / (node.image.scale ?? 1);
  if (Math.abs(width - node.image.intrinsicWidth) < 0.000001 && Math.abs(height - node.image.intrinsicHeight) < 0.000001) return asset;
  const viewport = svg.replace(/<svg\b((?:"[^"]*"|'[^']*'|[^'">])*)>/i, (_tag, attributes: string) => {
    let sized = attributes.replace(/\s(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    const sizingStyle = `width:${width}px!important;height:${height}px!important`;
    if (/\sstyle\s*=/i.test(sized)) {
      sized = sized.replace(/(\sstyle\s*=\s*)(["'])(.*?)\2/i, (_style, prefix: string, quote: string, value: string) => `${prefix}${quote}${value};${sizingStyle}${quote}`);
    } else sized += ` style="${sizingStyle}"`;
    return `<svg${sized} width="${width}" height="${height}">`;
  });
  return { id: asset.id, dataUrl: `data:image/svg+xml,${encodeURIComponent(viewport)}`, mimeType: "image/svg+xml" };
}

function needsContainerBackdrop(node: SceneNode): boolean {
  const paint = node.paint;
  return Boolean(
    cssColor(paint.backgroundColor) ||
    (paint.backgroundImage && paint.backgroundImage !== "none") ||
    hasBorder(paint) ||
    (paint.boxShadow && paint.boxShadow !== "none") ||
    paint.radius?.some((radius) => radius > 0)
  );
}

interface AssetFillResult {
  applied: boolean;
  failure?: string;
}

async function applyAssetFill(shape: Shape, asset: AssetRef | undefined, media: MediaUploads, keepAspectRatio?: boolean): Promise<AssetFillResult> {
  if (!asset || shape.type === "group") return { applied: false, failure: "The source asset was unavailable to this Penpot layer." };
  const cached = await media.get(asset);
  if (!cached?.media) return { applied: false, failure: cached?.failure || "Penpot did not return uploaded media." };
  const fillTarget = shape as Shape & { fills: Fill[] };
  const image = keepAspectRatio === undefined ? cached.media : { ...cached.media, keepAspectRatio };
  fillTarget.fills = [...(fillTarget.fills || []), { fillImage: image, fillOpacity: 1 }];
  return { applied: true };
}

function markAssetFallback(shape: Shape, reason: string): void {
  if (shape.type !== "group" && "fills" in shape) {
    const target = shape as Shape & { fills: Fill[] };
    if (!target.fills?.length) target.fills = [{ fillColor: "#e5e7eb", fillOpacity: 1 }];
  }
  shape.setPluginData("asset-fallback", reason);
}

async function createContainerBackdrop(node: SceneNode, assets: Map<string, AssetRef>, media: MediaUploads, track: TrackShape, place: PlaceShape): Promise<Shape> {
  const backdrop = track(penpot.createRectangle());
  // Opacity belongs to the complete container compositing group. Keeping
  // the backdrop fully opaque lets the group apply it once to both the
  // background and editable descendants.
  applyPaint(backdrop, { ...node.paint, opacity: 1 });
  place(backdrop);
  const asset = node.assetId ? assets.get(node.assetId) : undefined;
  const applied = asset ? await applyAssetFill(backdrop, asset, media) : undefined;
  if (asset && !applied?.applied) {
    markAssetFallback(backdrop, `Background image could not be loaded; ${applied?.failure || "the upload failed"}.`);
  }
  return backdrop;
}

function applyContainerOpacity(shape: Shape, node: SceneNode): void {
  const opacity = node.paint.opacity;
  if (opacity === undefined || opacity === 1) return;
  shape.opacity = (shape.opacity ?? 1) * opacity;
}

function metadata(shape: Shape, node: SceneNode, viewportId: string): void {
  let assetFallback = "";
  const getPluginData = (shape as Shape & { getPluginData?: (key: string) => string }).getPluginData;
  if (typeof getPluginData === "function") {
    try { assetFallback = getPluginData.call(shape, "asset-fallback"); } catch { /* Older hosts may not expose plugin data reads. */ }
  }
  // NBSP and other whitespace can be meaningful text content, but Penpot
  // rejects a blank layer name. Keep the characters and use a visible label.
  const capturedName = node.name.slice(0, 200);
  const name = capturedName.trim() ? capturedName : node.kind === "text" ? "Text" : "Layer";
  shape.name = assetFallback
    ? `${assetFallback.startsWith("SVG") ? "SVG fallback" : "Image unavailable"}: ${name}`.slice(0, 200)
    : name;
  shape.setPluginData("importer", IMPORT_NAMESPACE);
  shape.setPluginData("viewport", viewportId);
  shape.setPluginData("source", node.source);
  if (node.fallbackReason) shape.setPluginData("fallback", node.fallbackReason);
}

async function createShape(node: SceneNode, assets: Map<string, AssetRef>, media: MediaUploads, track: TrackShape, place: PlaceShape): Promise<Shape> {
  if (node.kind === "text") return createText(node, track);
  const asset = node.assetId ? assets.get(node.assetId) : undefined;
  const svg = svgTextOf(asset);
  let svgConversionFailed = node.kind === "svg" || Boolean(svg);
  if (svg) {
    try {
      const group = await penpot.createShapeFromSvgWithImages(svg);
      if (group) return track(group);
    } catch {
      // Try the synchronous converter for SVGs without image dependencies.
    }
    try {
      const group = penpot.createShapeFromSvg(svg);
      if (group) return track(group);
    } catch {
      // Keep an image-backed rectangle if the SVG uses features Penpot cannot
      // translate into editable vectors.
    }
  }
  const shape = track(penpot.createRectangle());
  if (node.kind === "fallback") {
    (shape as Shape & { fills: Fill[] }).fills = [{ fillColor: "#f4f4f5" }];
    shape.name = `Unsupported: ${node.name}`;
  } else {
    applyPaint(shape, node.paint);
  }
  if ((node.kind === "image" || node.kind === "svg" || node.paint.backgroundImage?.includes("url(")) && node.assetId) {
    // Place the layer before its upload: a rotation applied long after the
    // host created a layer was observed to be left unapplied.
    place(shape);
    const applied = await applyAssetFill(shape, asset, media);
    if (svgConversionFailed && applied.applied) markAssetFallback(shape, "SVG vector conversion failed; the uploaded image fallback is shown.");
    else if (!applied.applied) markAssetFallback(shape, node.kind === "svg" ? `SVG could not be converted or loaded; ${applied.failure || "the upload failed"}.` : `Image could not be loaded; ${applied.failure || "the upload failed"}.`);
  }
  return shape;
}

function assetSource(asset: AssetRef | undefined): string {
  return asset?.url || asset?.dataUrl?.slice(0, 200) || asset?.id || "unknown asset";
}

function reportAssetFallback(shape: Shape, node: SceneNode, asset: AssetRef | undefined, viewportId: string, options: ImportOptions): void {
  const getPluginData = (shape as Shape & { getPluginData?: (key: string) => string }).getPluginData;
  const reason = typeof getPluginData === "function" ? getPluginData.call(shape, "asset-fallback") : "";
  if (!reason) return;
  options.onDiagnostic?.({
    severity: "warning",
    code: "ASSET_IMPORT_FAILED",
    message: `${reason} Asset: ${assetSource(asset)}.`,
    viewportId,
    source: node.source
  });
}

export async function importScenes(scenes: SceneDocument[], options: ImportOptions): Promise<Board[]> {
  const started = profileNow();
  const scheduler = new ImportScheduler();
  const boards: Board[] = [];
  const total = scenes.reduce((sum, scene) => sum + scene.nodes.length, 0);
  const metrics: ImportMetrics = { outcome: "error", nodeCount: total, assetCount: new Set(scenes.flatMap((scene) => scene.assets.map(mediaKey))).size, uploadCount: 0, maxConcurrentUploads: 0, saveWaitCount: 0, saveWaitMs: 0, completedNodes: 0, boardCount: 0, durationMs: 0, renderMs: 0, textFitMs: 0, commitWaitMs: 0, yieldMs: 0, yieldCount: 0 };
  let phase: "renderMs" | "textFitMs" | "commitWaitMs" | undefined;
  let phaseStart = started;
  const startPhase = (next?: typeof phase) => {
    const now = profileNow();
    if (phase) metrics[phase] += now - phaseStart;
    phase = next;
    phaseStart = now;
  };
  let completed = 0;
  const origin = { x: penpot.viewport.center.x, y: penpot.viewport.center.y };
  let x = origin.x;
  // Keep one uploaded media object per source URL across responsive boards.
  // Re-uploading the same page asset for each viewport creates noisy failed
  // requests in Penpot and needlessly increases the file update payload.
  const media = new MediaUploads(options.isCancelled);
  let persistence: BoardPersistence | undefined;
  const throwIfCancelled = () => {
    if (options.isCancelled()) throw new ImportCancelledError();
  };
  const checkpoint = async () => {
    throwIfCancelled();
    const saved = persistence?.checkpoint();
    if (saved) { await saved; throwIfCancelled(); }
    const pause = scheduler.checkpoint();
    if (pause) {
      await pause;
      throwIfCancelled();
    }
  };
  const waitForHost = (milliseconds: number) => new Promise<void>((resolve, reject) => {
    // Keep one completion timer so hidden-tab timer throttling cannot stretch
    // a settle delay into a chain of waits. Poll cancellation independently.
    let cancellationTimer: ReturnType<typeof setTimeout>;
    const finish = () => {
      clearTimeout(completionTimer);
      clearTimeout(cancellationTimer);
      if (options.isCancelled()) reject(new ImportCancelledError());
      else resolve();
    };
    const poll = () => {
      if (options.isCancelled()) finish();
      else cancellationTimer = setTimeout(poll, 4);
    };
    const completionTimer = setTimeout(finish, milliseconds);
    cancellationTimer = setTimeout(poll, 4);
  });

  try {
    for (const scene of scenes) {
      throwIfCancelled();
      startPhase("renderMs");
      // Real plugin hosts expose save notifications. Small imports retain the
      // existing behavior; large boards stop feeding changes between batches
      // so the host can drain its persistence buffer without splitting undo.
      persistence = scene.nodes.length >= LARGE_BOARD_NODES && typeof penpot.on === "function" && typeof penpot.off === "function"
        ? new BoardPersistence(throwIfCancelled, () => options.onProgress(completed, total, `Saving ${scene.viewport.name}`)) : undefined;
      const undo = penpot.history.undoBlockBegin();
      const unattached = new Set<Shape>();
      const track: TrackShape = (shape) => { unattached.add(shape); persistence?.markDirty(); return shape; };
      try {
        const board = penpot.createBoard();
        boards.push(board);
        persistence?.markDirty();
        board.name = `Page — ${scene.viewport.name} ${scene.viewport.width}`;
        fixBoardSizing(board);
        board.x = x;
        board.y = origin.y;
        board.resize(scene.viewport.width, scene.documentSize.height);
        board.clipContent = true;
        board.setPluginData("importer", IMPORT_NAMESPACE);
        board.setPluginData("viewport", scene.viewport.id);
        x += scene.viewport.width + 120;

        const nodes = new Map(scene.nodes.map((node) => [node.id, node]));
        const childrenByParent = new Map<string, SceneNode[]>();
        for (const node of scene.nodes) {
          if (!node.parentId || !nodes.has(node.parentId)) continue;
          const siblings = childrenByParent.get(node.parentId) || [];
          siblings.push(node);
          childrenByParent.set(node.parentId, siblings);
        }
        // Reproduce supported CSS paint order: negative z-index ascending,
        // non-positioned in-flow content, positioned automatic/zero stacking
        // in source order, then positive z-index ascending. Sorting stays
        // within each parent's children with a stable source-order tie break,
        // so nested stacking contexts keep their contents isolated instead of
        // being globally re-sorted against unrelated layers.
        // Siblings are appended topmost-first: under Penpot's default plugin
        // flags, appendChild inserts each child at index 0, behind the
        // children already present (see app.plugins.shape in penpot/penpot),
        // so appending in descending paint order leaves the parent's shapes
        // in browser back-to-front order.
        const domOrder = new Map(scene.nodes.map((node, index) => [node.id, index]));
        const positioned = (node: SceneNode): boolean => Boolean(node.layout.positioned || node.layout.absolute);
        const paintRank = (node: SceneNode): [number, number] => {
          if (node.zIndex < 0) return [0, node.zIndex];
          if (node.zIndex > 0) return [3, node.zIndex];
          return [positioned(node) ? 2 : 1, 0];
        };
        const byPaintOrder = (a: SceneNode, b: SceneNode): number => {
          const [rankA, zA] = paintRank(a);
          const [rankB, zB] = paintRank(b);
          return rankB - rankA || zB - zA || (domOrder.get(b.id) ?? 0) - (domOrder.get(a.id) ?? 0);
        };
        for (const siblings of childrenByParent.values()) siblings.sort(byPaintOrder);
        const assets = new Map(scene.assets.map((asset) => [asset.id, asset]));
        // Prefetch referenced media for this board, excluding SVG leaves that
        // first try editable conversion. Their raster fallback uploads remain
        // on demand. Unused scene assets and later boards are not uploaded.
        media.prefetch(scene.nodes.flatMap((node) => {
          const asset = node.assetId ? assets.get(node.assetId) : undefined;
          if (!asset || node.kind === "text") return [];
          const fitted = node.kind === "image" ? imageGeometry(node) : undefined;
          if (fitted && (!fitted.object.width || !fitted.object.height)) return [];
          if (node.kind === "container") return [asset];
          if (svgTextOf(asset)) return [];
          return node.kind === "image" || node.kind === "svg" || node.paint.backgroundImage?.includes("url(") ? [asset] : [];
        }));
        const shapes = new Map<string, Shape>();
        const textLines: { text: Text; node: SceneNode; maximum: number }[] = [];
        const roots = scene.nodes.filter((node) => !node.parentId || !nodes.has(node.parentId)).sort(byPaintOrder);

        const append = (parentShape: Board | Shape, shape: Shape) => {
          if (parentShape.type === "board") (parentShape as Board).appendChild(shape);
          else (parentShape as Shape & { appendChild?: (child: Shape) => void }).appendChild?.(shape);
          unattached.delete(shape);
          persistence?.markDirty();
        };

        const createBorders = (node: SceneNode, parentShape: Board | Shape): Shape[] => {
          const borders: Shape[] = [];
          for (const polygon of borderPolygons(node.paint, node.rect.width, node.rect.height)) {
            const color = cssColorWithOpacity(polygon.border.color);
            if (!color) continue;
            throwIfCancelled();
            const path = track(penpot.createPath());
            path.d = polygon.d;
            path.fills = [{ fillColor: color.color, fillOpacity: color.opacity }];
            path.strokes = [];
            path.opacity = 1;
            append(parentShape, path);
            // A side's local corner travels with the element's own frame.
            // Rotate the path at creation, before any asynchronous host work.
            applyGeometry(path, localFrame(node, polygon.rect), { x: board.x, y: board.y }, 0);
            metadata(path, node, scene.viewport.id);
            path.name = `${path.name.slice(0, 170)} ${polygon.side} border`;
            path.setPluginData("border-side", polygon.side);
            borders.push(path);
          }
          return borders;
        };

        const reportProgress = () => {
          completed += 1;
          if (completed % 25 === 0 || completed === total) {
            options.onProgress(completed, total, `Creating ${scene.viewport.name}`);
          }
        };

        const render = async (node: SceneNode, parentShape: Board | Shape): Promise<Shape | undefined> => {
          await checkpoint();
          const fitted = node.kind === "image" ? imageGeometry(node) : undefined;
          if (fitted) {
            // A fixed board keeps the element's border box independent of an
            // oversized fitted image. Element opacity composites its background,
            // border and image once; the inner board clips at the content box.
            const frame = track(penpot.createBoard());
            fixBoardSizing(frame);
            frame.clipContent = true;
            applyPaint(frame, node.paint);
            append(parentShape, frame);
            applyGeometry(frame, node, { x: board.x, y: board.y }, node.rect.width > 0 && node.rect.height > 0 ? 0 : 0.1);
            frame.setPluginData("image-clip", "true");
            metadata(frame, node, scene.viewport.id);
            // Create side fills first: the host inserts the content board behind
            // these siblings, keeping the border above the image.
            createBorders(node, frame);
            if (fitted.object.width > 0 && fitted.object.height > 0) {
              const content = track(penpot.createBoard());
              fixBoardSizing(content);
              content.clipContent = true;
              content.fills = [];
              content.strokes = [];
              content.opacity = 1;
              if (node.paint.radius?.some((radius) => radius > 0)) {
                const insets = [fitted.content.y, node.rect.width - fitted.content.x - fitted.content.width,
                  node.rect.height - fitted.content.y - fitted.content.height, fitted.content.x];
                if (insets.every((inset) => Math.abs(inset - insets[0]) < 0.000001)) {
                  const radius = node.paint.radius.map((value) => Math.max(0, value - insets[0]));
                  applyPaint(content, { radius: radius as [number, number, number, number], opacity: 1 });
                } else {
                  options.onDiagnostic?.({ severity: "warning", code: "UNSUPPORTED_IMAGE_RADIUS",
                    message: "Rounded image content with unequal border/padding insets needs elliptical inner corners; the imported image retains its outer rounded clip and a square content clip.",
                    viewportId: scene.viewport.id, source: node.source });
                }
              }
              append(frame, content);
              applyGeometry(content, localFrame(node, fitted.content), { x: board.x, y: board.y }, 0);
              metadata(content, node, scene.viewport.id);
              content.name = `${content.name.slice(0, 175)} content clip`;
              content.setPluginData("image-content-clip", "true");
              const asset = node.assetId ? assets.get(node.assetId) : undefined;
              const svg = svgTextOf(asset);
              const svgFrame = svg ? svgImageGeometry(svg, fitted.object, node.image?.scale) : undefined;
              let image: Shape | undefined;
              if (svg && svgFrame) {
                let vector: Shape | null | undefined;
                try { vector = await penpot.createShapeFromSvgWithImages(svg); } catch { /* Try the synchronous converter. */ }
                if (!vector) {
                  try { vector = penpot.createShapeFromSvg(svg); } catch { /* Use an image fill below. */ }
                }
                if (vector) {
                  track(vector);
                  if (vector.width > 0 && vector.height > 0 && Math.abs(vector.width - svgFrame.viewBox.width) < 0.01 && Math.abs(vector.height - svgFrame.viewBox.height) < 0.01) {
                    const viewport = track(penpot.createBoard());
                    fixBoardSizing(viewport);
                    viewport.clipContent = true;
                    viewport.fills = [];
                    viewport.strokes = [];
                    append(content, viewport);
                    applyGeometry(viewport, localFrame(node, fitted.object), { x: board.x, y: board.y }, 0);
                    metadata(viewport, node, scene.viewport.id);
                    viewport.name = `${viewport.name.slice(0, 175)} SVG viewport`;
                    viewport.setPluginData("image-svg-viewport", "true");
                    image = vector;
                    append(viewport, image);
                    applyGeometry(image, localFrame(node, svgFrame.rect), { x: board.x, y: board.y }, 0);
                    image.setPluginData("image-svg-vector", "true");
                  } else {
                    // Tight bounds that differ from the source viewBox cannot
                    // be resized without moving its crop. Discard this attempt.
                    vector.remove();
                    unattached.delete(vector);
                    persistence?.markDirty();
                  }
                }
                throwIfCancelled();
              }
              if (!image) {
                const raster = track(penpot.createRectangle());
                raster.fills = [];
                raster.strokes = [];
                raster.opacity = 1;
                append(content, raster);
                applyGeometry(raster, localFrame(node, fitted.object), { x: board.x, y: board.y }, 0);
                // Geometry already resolved fit. Disable the native aspect
                // rule in the initial fill write so it cannot crop again.
                const applied = await applyAssetFill(raster, fittedImageAsset(node, asset, fitted.object), media, false);
                throwIfCancelled();
                let reason: string | undefined;
                if (!applied.applied) {
                  reason = `Image could not be loaded; ${applied.failure || "the upload failed"}.`;
                  content.fills = [{ fillColor: "#e5e7eb", fillOpacity: 1 }];
                } else {
                  if (svg) reason = "SVG vector conversion could not retain the source viewport; the uploaded SVG image fallback is shown.";
                  else if (asset?.mimeType?.includes("svg") || /\.svg(?:[?#]|$)/i.test(asset?.url || "")) {
                    options.onDiagnostic?.({ severity: "warning", code: "UNSUPPORTED_SVG_VIEWPORT",
                      message: "The SVG source was not inlined; its internal viewport/aspect rule could not be resolved. The uploaded image uses the captured object frame.",
                      viewportId: scene.viewport.id, source: node.source });
                  }
                }
                if (reason) {
                  markAssetFallback(raster, reason);
                  frame.setPluginData("asset-fallback", reason);
                  metadata(frame, node, scene.viewport.id);
                  reportAssetFallback(frame, node, asset, scene.viewport.id, options);
                }
                image = raster;
              }
              metadata(image, node, scene.viewport.id);
              image.name = `${image.name.slice(0, 180)} image`;
              image.setPluginData("image-content", "true");
            }
            shapes.set(node.id, frame);
            reportProgress();
            return frame;
          }
          if (node.kind === "container" && clipsContent(node.paint)) {
            // A Penpot board is the clipping-capable container. Unlike a
            // group, its bounds stay at the captured element's box instead of
            // growing to enclose its descendants, so an oversized child is
            // hidden rather than resizing the container. The board also paints
            // the element's own decoration, which keeps the clip and the
            // rounded corners on one surface.
            const clip = track(penpot.createBoard());
            fixBoardSizing(clip);
            clip.clipContent = true;
            applyPaint(clip, node.paint);
            // Establish parentage and the container's own bounds before its
            // children: applyGeometry writes page-space coordinates, and the
            // children are positioned against the same page origin. Do it
            // before any background upload, which can take long enough for the
            // host to leave a late rotation unapplied.
            append(parentShape, clip);
            applyGeometry(clip, node, { x: board.x, y: board.y });
            const clipAsset = node.assetId ? assets.get(node.assetId) : undefined;
            const clipApplied = clipAsset ? await applyAssetFill(clip, clipAsset, media) : undefined;
            throwIfCancelled();
            if (clipAsset && !clipApplied?.applied) {
              markAssetFallback(clip, `Background image could not be loaded; ${clipApplied?.failure || "the upload failed"}.`);
            }
            metadata(clip, node, scene.viewport.id);
            reportAssetFallback(clip, node, clipAsset, scene.viewport.id, options);
            shapes.set(node.id, clip);
            let contentClip = clip;
            if (node.paint.borders && hasBorder(node.paint) && !uniformBorder(node.paint) && !node.paint.radius?.some((radius) => radius > 0)) {
              // CSS clips overflow at the padding box. A board clips at its
              // outer bounds, so inset a transparent content board to keep
              // oversized children out of the border, including alpha sides.
              const [top, right, bottom, left] = borderInsets(node.paint, node.rect.width, node.rect.height);
              contentClip = track(penpot.createBoard());
              fixBoardSizing(contentClip);
              contentClip.clipContent = true;
              contentClip.fills = [];
              contentClip.strokes = [];
              contentClip.opacity = 1;
              append(clip, contentClip);
              applyGeometry(contentClip, localFrame(node, { x: left, y: top, width: node.rect.width - left - right, height: node.rect.height - top - bottom }), { x: board.x, y: board.y });
              metadata(contentClip, node, scene.viewport.id);
              contentClip.name = `${contentClip.name.slice(0, 180)} content clip`;
              contentClip.setPluginData("border-content-clip", "true");
            }
            for (const child of childrenByParent.get(node.id) || []) await render(child, contentClip);
            // Append after descendants: the host inserts these at the back,
            // above the board background and below CSS child content.
            createBorders(node, clip);
            reportProgress();
            return clip;
          }
          if (node.kind === "container") {
            const children: Shape[] = [];
            for (const child of childrenByParent.get(node.id) || []) {
              const childShape = await render(child, parentShape);
              if (childShape) children.push(childShape);
            }

            // The host preserves existing sibling order when grouping.
            // Append borders before the backdrop so its index-zero insertion
            // puts the background behind the side fills and descendants.
            const borders = createBorders(node, parentShape);
            const backdrop = needsContainerBackdrop(node) ? await createContainerBackdrop(node, assets, media, track, (value) => {
              append(parentShape, value);
              applyGeometry(value, node, { x: board.x, y: board.y });
            }) : undefined;
            throwIfCancelled();
            if (backdrop) {
              metadata(backdrop, node, scene.viewport.id);
              reportAssetFallback(backdrop, node, node.assetId ? assets.get(node.assetId) : undefined, scene.viewport.id, options);
              children.unshift(backdrop);
            }

            if (!children.length) {
              reportProgress();
              return undefined;
            }
            // An undecorated wrapper with a single child collapses onto that
            // child: the child's shape is reused as the compositing group so
            // no extra layer is created. The child's own name and source must
            // survive that collapse; overwriting them with the wrapper's would
            // rename the layer (which may be a clipping board) after whatever
            // happened to wrap it. Only the wrapper's compositing opacity is
            // still applied.
            const collapsed = children.length === 1 && !backdrop;
            // Rendered children arrive topmost-first (see the sibling sort
            // above), but a group's shapes vector is back-to-front, so group
            // members run in the opposite order with the backdrop behind.
            const rendered = backdrop ? children.slice(1) : children;
            const members = rendered.slice().reverse();
            members.unshift(...borders);
            if (backdrop) members.unshift(backdrop);
            const shape = collapsed ? children[0] : penpot.group(members);
            if (!collapsed || node.paint.opacity !== undefined && node.paint.opacity !== 1) persistence?.markDirty();
            if (!shape) {
              if (borders.length) throw new Error("Penpot could not group the container and its side borders.");
              reportProgress();
              return children[0];
            }
            if (!collapsed) {
              // Penpot's group operation resets its direct members to
              // scale/scale. Restore snapshot constraints after grouping so
              // nested boards and positioned layers cannot reflow with the
              // group's bounds.
              members.forEach(pinShapeConstraints);
              pinShapeConstraints(shape);
            }
            applyContainerOpacity(shape, node);
            if (!collapsed) metadata(shape, node, scene.viewport.id);
            shapes.set(node.id, shape);
            reportProgress();
            return shape;
          }

          let shape: Shape;
          let placed = false;
          // Append the decoration before placing the base surface; the host
          // inserts that surface behind the existing borders.
          const borders = createBorders(node, parentShape);
          const place: PlaceShape = (value) => {
            placed = true;
            append(parentShape, value);
            applyGeometry(value, node, { x: board.x, y: board.y });
          };
          try {
            shape = await createShape(node, assets, media, track, place);
          } catch (error) {
            throw new Error(`Unable to create ${scene.viewport.name} layer "${node.name}" (${node.kind}) from ${node.source}: ${errorDetail(error)}`);
          }
          throwIfCancelled();
          try {
            metadata(shape, node, scene.viewport.id);
            reportAssetFallback(shape, node, node.assetId ? assets.get(node.assetId) : undefined, scene.viewport.id, options);
            if (!placed) place(shape);
            if (borders.length) {
              // The background/image and side colors share the element's
              // compositing opacity; apply it once to the complete group.
              const background = shape;
              background.opacity = 1;
              const members = [background, ...borders];
              const group = penpot.group(members);
              if (!group) throw new Error("Penpot could not group the element and its side borders.");
              members.forEach(pinShapeConstraints);
              pinShapeConstraints(group);
              group.opacity = node.paint.opacity ?? 1;
              const reason = background.getPluginData("asset-fallback");
              if (reason) group.setPluginData("asset-fallback", reason);
              metadata(group, node, scene.viewport.id);
              shape = group;
              persistence?.markDirty();
            }
            shapes.set(node.id, shape);
            // Keep short inline controls on the same line as in the source
            // browser. Apply this after geometry because resize() can reset a
            // text layer's grow mode. Wrapped source text is split into one
            // non-wrapping layer per browser line by the extractor, so each
            // imported line remains readable without relying on auto-height.
            if (shape.type === "text" && node.textNoWrap && !node.text?.includes("\n")) {
              const text = shape as Text;
              text.growType = "auto-width";
              // Bound old captures too, and include enclosing cards: inline
              // elements can themselves have a bounding box wider than a card.
              let maximum = node.textMaxWidth ?? node.rect.width;
              // Comparing edges only makes sense between axis-aligned frames.
              let ancestor = node.parentId && !node.rotation ? nodes.get(node.parentId) : undefined;
              const visited = new Set<string>();
              while (ancestor && !visited.has(ancestor.id)) {
                visited.add(ancestor.id);
                const right = ancestor.rect.x + ancestor.rect.width
                  - (ancestor.layout.padding?.[1] ?? 0) - borderWidth(ancestor.paint, "right");
                if (!ancestor.rotation && right > node.rect.x) maximum = Math.min(maximum, right - node.rect.x);
                ancestor = ancestor.parentId ? nodes.get(ancestor.parentId) : undefined;
              }
              textLines.push({ text, node, maximum: Math.max(1, maximum) });
            }
          } catch (error) {
            throw new Error(`Unable to place ${scene.viewport.name} layer "${node.name}" (${node.kind}) from ${node.source}: ${errorDetail(error)}`);
          }
          reportProgress();
          return shape;
        };
        for (const root of roots) {
          // The top-level Penpot board already represents <body>. Importing it
          // again creates an offset nested board and makes its size misleading.
          if (root.kind === "container") {
            await checkpoint();
            persistence?.markDirty();
            applyPaint(board, root.paint);
            const rootAsset = root.assetId ? assets.get(root.assetId) : undefined;
            const rootApplied = rootAsset ? await applyAssetFill(board, rootAsset, media) : undefined;
            throwIfCancelled();
            if (rootAsset && !rootApplied?.applied) {
              board.setPluginData("asset-fallback", `Page background image could not be loaded; ${rootApplied?.failure || "the upload failed"}.`);
            }
            persistence?.markDirty();
            board.setPluginData("source", root.source);
            reportAssetFallback(board, root, rootAsset, scene.viewport.id, options);
            for (const child of childrenByParent.get(root.id) || []) await render(child, board);
            createBorders(root, board);
            reportProgress();
          } else await render(root, board);
        }
        // Font loading and host text layout are asynchronous. A zero-delay
        // check immediately after creation can still see the source width.
        // Fit all lines together, then remeasure the result of each adjustment.
        startPhase("textFitMs");
        for (let pass = 0; textLines.length && pass < 4; pass += 1) {
          await waitForHost(pass === 0 ? 250 : 100);
          throwIfCancelled();
          for (const { text, node, maximum } of textLines) {
            if (!constrainTextToCapturedWidth(text, node, maximum)) continue;
            persistence?.markDirty();
            const saved = persistence?.checkpoint();
            if (saved) await saved;
            throwIfCancelled();
          }
        }
        // Fitting resizes auto-width text about its center, which moves the start
        // of a rotated line. Put the line start back where the browser had it.
        for (const { text, node } of textLines) {
          if (!node.rotation) continue;
          const bounds = rotatedBoundsOrigin({ x: board.x + node.rect.x, y: board.y + node.rect.y }, text.width, text.height, node.rotation);
          text.x = bounds.x;
          text.y = bounds.y;
          persistence?.markDirty();
        }
        await persistence?.flush();
        throwIfCancelled();
      } catch (error) {
        // A layer awaiting an upload/conversion may still be on the page root.
        // Removing the partial board alone would leave that layer behind.
        for (const shape of unattached) shape.remove();
        throw error;
      } finally {
        // Undo blocks group history. Penpot batches save requests separately;
        // ending this block does not force or acknowledge a backend save.
        try { penpot.history.undoBlockFinish(undo); }
        finally {
          if (persistence) {
            metrics.saveWaitCount += persistence.waitCount;
            metrics.saveWaitMs += persistence.waitMs;
            persistence.close();
            persistence = undefined;
          }
        }
      }
      // Give the host time to settle before the next board. This delay is not
      // a save barrier and does not bound an individual persistence payload.
      startPhase("commitWaitMs");
      await waitForHost(250);
      throwIfCancelled();
      startPhase();
    }
    metrics.outcome = "complete";
    return boards;
  } catch (error) {
    metrics.outcome = error instanceof ImportCancelledError ? "cancelled" : "error";
    media.stop();
    for (const board of boards) board.remove();
    throw error;
  } finally {
    startPhase();
    persistence?.close();
    media.stop();
    await media.drain();
    metrics.uploadCount = media.uploadCount;
    metrics.maxConcurrentUploads = media.peakConcurrency;
    metrics.completedNodes = completed;
    metrics.boardCount = metrics.outcome === "complete" ? boards.length : 0;
    metrics.durationMs = profileNow() - started;
    metrics.yieldCount = scheduler.yieldCount;
    metrics.yieldMs = scheduler.yieldMs;
    // Profiling must not change rollback or the result of a successful import.
    try { options.onMetrics?.(metrics); } catch { /* Ignore a profiling observer failure. */ }
  }
}
