import type { Board, Fill, Gradient, Shape, Text } from "@penpot/plugin-types";
import type { AssetRef, SceneDocument, SceneNode, ScenePaint } from "../shared/contracts";

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
}

const IMPORT_NAMESPACE = "ultimate-html-to-penpot";

interface ParsedColor {
  color: string;
  opacity: number;
}

function clampOpacity(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function cssColorWithOpacity(value: string | undefined): ParsedColor | undefined {
  if (!value || value === "transparent" || value === "rgba(0, 0, 0, 0)") return undefined;
  const hex = value.match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i)?.[1];
  if (hex) {
    const expanded = hex.length <= 4 ? [...hex].map((part) => part + part).join("") : hex;
    const color = `#${expanded.slice(0, 6)}`;
    const alpha = expanded.length === 8 ? Number.parseInt(expanded.slice(6), 16) / 255 : 1;
    return { color, opacity: alpha };
  }
  const match = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (!match) return undefined;
  const channels = match.slice(1, 4).map((part) => Math.round(Number(part)));
  if (channels.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) return undefined;
  return {
    color: `#${channels.map((part) => part.toString(16).padStart(2, "0")).join("")}`,
    opacity: clampOpacity(match[4] === undefined ? 1 : Number(match[4]))
  };
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
  const match = value.match(/^\s*(rgba?\([^)]*\)|#[\da-f]{3,8})(?:\s+(.+))?\s*$/i);
  const parsed = cssColorWithOpacity(match?.[1]);
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
  let previous = 0;
  for (let index = 0; index < offsets.length; index += 1) {
    if (offsets[index] !== undefined) {
      previous = offsets[index] as number;
      continue;
    }
    let next = index + 1;
    while (next < offsets.length && offsets[next] === undefined) next += 1;
    const end = offsets[next] ?? 1;
    const count = next - index + 1;
    for (let fill = index; fill < next; fill += 1) offsets[fill] = previous + (end - previous) * (fill - index + 1) / count;
    index = next - 1;
    previous = offsets[index] as number;
  }
  // CSS clamps a stop that would move backwards to its preceding position.
  return offsets.map((offset, index) => Math.max(index ? offsets[index - 1] as number : 0, clampOpacity(offset as number)));
}

function cssGradient(value: string | undefined): Gradient | undefined {
  if (!value || (!value.startsWith("linear-gradient") && !value.startsWith("radial-gradient"))) return undefined;
  const parts = cssFunctionArguments(value);
  const colors = parts.map(gradientStop).filter((stop): stop is GradientStop => Boolean(stop));
  if (colors.length < 2) return undefined;
  const offsets = resolvedGradientOffsets(colors);
  const stops = colors.map(({ color, opacity }, index) => ({ color, opacity, offset: offsets[index] }));
  if (value.startsWith("radial-gradient")) return { type: "radial", startX: 0.5, startY: 0.5, endX: 1, endY: 0.5, width: 0.5, stops };
  const angle = value.match(/(-?\d+(?:\.\d+)?)deg/);
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
  const stroke = cssColor(paint.borderColor);
  if (stroke && paint.borderWidth && paint.borderStyle !== "none") {
    shape.strokes = [{ strokeColor: stroke, strokeWidth: paint.borderWidth, strokeStyle: "solid", strokeAlignment: "center" }];
  }
  applyShadow(shape, paint.boxShadow);
  const matrix = paint.transform?.match(/^matrix\(([^)]+)\)$/);
  if (matrix) {
    const values = matrix[1].split(",").map(Number);
    if (values.length >= 2) shape.rotation = Math.atan2(values[1], values[0]) * 180 / Math.PI;
  }
  if (paint.overflow === "hidden" || paint.overflow === "clip") {
    if (shape.type === "board") (shape as Board).clipContent = true;
  }
}

function applyGeometry(shape: Shape, node: SceneNode, pageOrigin: { x: number; y: number }): void {
  // Penpot stores a nested shape's coordinates in page space. Set these only
  // after parentage is established; setting local DOM coordinates beforehand
  // puts children outside their clipping board.
  shape.x = pageOrigin.x + node.rect.x;
  shape.y = pageOrigin.y + node.rect.y;
  shape.resize(Math.max(0.1, node.rect.width), Math.max(0.1, node.rect.height));
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

function createText(node: SceneNode): Text {
  const text = penpot.createText(node.text || "");
  if (!text) throw new Error(`Unable to create text layer: ${node.name}`);
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
  const color = cssColorWithOpacity(node.paint.color);
  if (color) text.fills = [{ fillColor: color.color, fillOpacity: color.opacity }];
  text.opacity = node.paint.opacity ?? 1;
  return text;
}

function constrainTextToCapturedWidth(text: Text, node: SceneNode, maximum: number): void {
  const actual = text.width;
  if (!maximum || !Number.isFinite(actual) || actual <= maximum + 0.01 || !node.textStyle) return;
  const scale = Number(text.fontSize) / Math.max(1, node.textStyle.fontSize) * (maximum - 0.5) / actual;
  applyTextSizing(text, node.textStyle, scale);
}

async function mediaFor(asset: AssetRef) {
  const dataUrl = asset.dataUrl || (asset.url?.startsWith("data:") ? asset.url : undefined);
  if (dataUrl) {
    const response = await fetch(dataUrl);
    const data = new Uint8Array(await response.arrayBuffer());
    return penpot.uploadMediaData(asset.id, data, response.headers.get("content-type") || asset.mimeType || "image/png");
  }
  if (asset.url) return penpot.uploadMediaUrl(asset.id, asset.url);
  return undefined;
}

function mediaKey(asset: AssetRef): string {
  return asset.dataUrl || asset.url || asset.id;
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

function needsContainerBackdrop(node: SceneNode): boolean {
  const paint = node.paint;
  return Boolean(
    cssColor(paint.backgroundColor) ||
    (paint.backgroundImage && paint.backgroundImage !== "none") ||
    (paint.borderWidth && paint.borderWidth > 0 && paint.borderStyle !== "none") ||
    (paint.boxShadow && paint.boxShadow !== "none") ||
    paint.radius?.some((radius) => radius > 0) ||
    paint.overflow === "hidden" ||
    paint.overflow === "clip"
  );
}

type Media = Awaited<ReturnType<typeof mediaFor>>;
type MediaCache = Map<string, Media | null>;

async function applyAssetFill(shape: Shape, asset: AssetRef | undefined, media: MediaCache): Promise<boolean> {
  if (!asset || shape.type === "group") return false;
  const key = mediaKey(asset);
  let uploaded = media.has(key) ? media.get(key) || undefined : undefined;
  if (!media.has(key)) {
    try {
      uploaded = await mediaFor(asset);
      media.set(key, uploaded || null);
    } catch {
      // Cache failures as well as successes so repeated responsive boards do
      // not retry an unavailable asset for every viewport.
      media.set(key, null);
      return false;
    }
  }
  if (!uploaded) return false;
  const fillTarget = shape as Shape & { fills: Fill[] };
  fillTarget.fills = [...(fillTarget.fills || []), { fillImage: uploaded, fillOpacity: 1 }];
  return true;
}

function markAssetFallback(shape: Shape, reason: string): void {
  if (shape.type !== "group" && "fills" in shape) {
    const target = shape as Shape & { fills: Fill[] };
    if (!target.fills?.length) target.fills = [{ fillColor: "#e5e7eb", fillOpacity: 1 }];
  }
  shape.setPluginData("asset-fallback", reason);
}

async function createContainerBackdrop(node: SceneNode, assets: Map<string, AssetRef>, media: MediaCache): Promise<Shape> {
  const backdrop = penpot.createRectangle();
  // Opacity belongs to the complete container compositing group. Keeping
  // the backdrop fully opaque lets the group apply it once to both the
  // background and editable descendants.
  applyPaint(backdrop, { ...node.paint, opacity: 1 });
  const asset = node.assetId ? assets.get(node.assetId) : undefined;
  if (asset && !(await applyAssetFill(backdrop, asset, media))) {
    markAssetFallback(backdrop, "Background image could not be loaded; a placeholder is shown.");
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
  shape.name = assetFallback
    ? `${assetFallback.startsWith("SVG") ? "SVG fallback" : "Image unavailable"}: ${node.name}`.slice(0, 200)
    : node.name.slice(0, 200);
  shape.setPluginData("importer", IMPORT_NAMESPACE);
  shape.setPluginData("viewport", viewportId);
  shape.setPluginData("source", node.source);
  if (node.fallbackReason) shape.setPluginData("fallback", node.fallbackReason);
}

async function createShape(node: SceneNode, assets: Map<string, AssetRef>, media: MediaCache): Promise<Shape> {
  if (node.kind === "text") return createText(node);
  const asset = node.assetId ? assets.get(node.assetId) : undefined;
  const svg = svgTextOf(asset);
  let svgConversionFailed = node.kind === "svg" || Boolean(svg);
  if (svg) {
    try {
      const group = await penpot.createShapeFromSvgWithImages(svg);
      if (group) return group;
    } catch {
      // Try the synchronous converter for SVGs without image dependencies.
    }
    try {
      const group = penpot.createShapeFromSvg(svg);
      if (group) return group;
    } catch {
      // Keep an image-backed rectangle if the SVG uses features Penpot cannot
      // translate into editable vectors.
    }
  }
  const shape = penpot.createRectangle();
  if (node.kind === "fallback") {
    (shape as Shape & { fills: Fill[] }).fills = [{ fillColor: "#f4f4f5" }];
    shape.name = `Unsupported: ${node.name}`;
  } else {
    applyPaint(shape, node.paint);
  }
  if ((node.kind === "image" || node.kind === "svg" || node.paint.backgroundImage?.includes("url(")) && node.assetId) {
    const applied = await applyAssetFill(shape, asset, media);
    if (svgConversionFailed && applied) markAssetFallback(shape, "SVG vector conversion failed; the uploaded image fallback is shown.");
    else if (!applied) markAssetFallback(shape, node.kind === "svg" ? "SVG could not be converted or loaded; an image placeholder is shown." : "Image could not be loaded; an image placeholder is shown.");
  }
  return shape;
}

export async function importScenes(scenes: SceneDocument[], options: ImportOptions): Promise<Board[]> {
  const boards: Board[] = [];
  const total = scenes.reduce((sum, scene) => sum + scene.nodes.length, 0);
  let completed = 0;
  const origin = { x: penpot.viewport.center.x, y: penpot.viewport.center.y };
  let x = origin.x;
  // Keep one uploaded media object per source URL across responsive boards.
  // Re-uploading the same page asset for each viewport creates noisy failed
  // requests in Penpot and needlessly increases the file update payload.
  const media: MediaCache = new Map();

  try {
    for (const scene of scenes) {
      if (options.isCancelled()) throw new ImportCancelledError();
      const undo = penpot.history.undoBlockBegin();
      try {
        const board = penpot.createBoard();
        boards.push(board);
        board.name = `Page — ${scene.viewport.name} ${scene.viewport.width}`;
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
        const assets = new Map(scene.assets.map((asset) => [asset.id, asset]));
        const shapes = new Map<string, Shape>();
        const textLines: { text: Text; node: SceneNode; maximum: number }[] = [];
        const roots = scene.nodes.filter((node) => !node.parentId || !nodes.has(node.parentId));

        const append = (parentShape: Board | Shape, shape: Shape) => {
          if (parentShape.type === "board") (parentShape as Board).appendChild(shape);
          else (parentShape as Shape & { appendChild?: (child: Shape) => void }).appendChild?.(shape);
        };

        const reportProgress = () => {
          completed += 1;
          if (completed % 25 === 0 || completed === total) {
            options.onProgress(completed, total, `Creating ${scene.viewport.name}`);
          }
        };

        const render = async (node: SceneNode, parentShape: Board | Shape): Promise<Shape | undefined> => {
          if (options.isCancelled()) throw new ImportCancelledError();
          if (node.kind === "container") {
            const children: Shape[] = [];
            for (const child of childrenByParent.get(node.id) || []) {
              const childShape = await render(child, parentShape);
              if (childShape) children.push(childShape);
            }

            const backdrop = needsContainerBackdrop(node) ? await createContainerBackdrop(node, assets, media) : undefined;
            if (backdrop) {
              metadata(backdrop, node, scene.viewport.id);
              append(parentShape, backdrop);
              applyGeometry(backdrop, node, { x: board.x, y: board.y });
              children.unshift(backdrop);
            }

            if (!children.length) {
              reportProgress();
              return undefined;
            }
            const shape = children.length === 1 ? children[0] : penpot.group(children);
            if (!shape) {
              reportProgress();
              return children[0];
            }
            applyContainerOpacity(shape, node);
            metadata(shape, node, scene.viewport.id);
            shapes.set(node.id, shape);
            reportProgress();
            return shape;
          }

          let shape: Shape;
          try {
            shape = await createShape(node, assets, media);
          } catch (error) {
            throw new Error(`Unable to create ${scene.viewport.name} layer "${node.name}" (${node.kind}) from ${node.source}: ${errorDetail(error)}`);
          }
          try {
            metadata(shape, node, scene.viewport.id);
            shapes.set(node.id, shape);
            append(parentShape, shape);
            applyGeometry(shape, node, { x: board.x, y: board.y });
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
              let ancestor = node.parentId ? nodes.get(node.parentId) : undefined;
              const visited = new Set<string>();
              while (ancestor && !visited.has(ancestor.id)) {
                visited.add(ancestor.id);
                const right = ancestor.rect.x + ancestor.rect.width
                  - (ancestor.layout.padding?.[1] ?? 0) - (ancestor.paint.borderWidth ?? 0);
                if (right > node.rect.x) maximum = Math.min(maximum, right - node.rect.x);
                ancestor = ancestor.parentId ? nodes.get(ancestor.parentId) : undefined;
              }
              textLines.push({ text, node, maximum: Math.max(1, maximum) });
            }
          } catch (error) {
            throw new Error(`Unable to place ${scene.viewport.name} layer "${node.name}" (${node.kind}) from ${node.source}: ${errorDetail(error)}`);
          }
          reportProgress();
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          return shape;
        };
        for (const root of roots) {
          // The top-level Penpot board already represents <body>. Importing it
          // again creates an offset nested board and makes its size misleading.
          if (root.kind === "container") {
            applyPaint(board, root.paint);
            const rootAsset = root.assetId ? assets.get(root.assetId) : undefined;
            if (rootAsset && !(await applyAssetFill(board, rootAsset, media))) {
              board.setPluginData("asset-fallback", "Page background image could not be loaded; the configured background color remains.");
            }
            board.setPluginData("source", root.source);
            for (const child of childrenByParent.get(root.id) || []) await render(child, board);
            reportProgress();
          } else await render(root, board);
        }
        // Font loading and host text layout are asynchronous. A zero-delay
        // check immediately after creation can still see the source width.
        // Fit all lines together, then remeasure the result of each adjustment.
        for (let pass = 0; textLines.length && pass < 4; pass += 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, pass === 0 ? 250 : 100));
          if (options.isCancelled()) throw new ImportCancelledError();
          for (const { text, node, maximum } of textLines) constrainTextToCapturedWidth(text, node, maximum);
        }
      } finally {
        // Each responsive board gets its own persistence-sized transaction.
        // A single 662-layer undo block generated a ~6.3 MB update-file
        // request, which Penpot could not persist.
        penpot.history.undoBlockFinish(undo);
      }
      // Let the Penpot host flush the completed transaction before starting
      // the next board. This keeps network requests and undo history bounded.
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    return boards;
  } catch (error) {
    for (const board of boards) board.remove();
    throw error;
  }
}
