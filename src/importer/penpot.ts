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

function cssColor(value: string | undefined): string | undefined {
  if (!value || value === "transparent" || value === "rgba(0, 0, 0, 0)") return undefined;
  if (value.startsWith("#")) return value;
  const match = value.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!match) return undefined;
  return `#${match.slice(1).map((part) => Number(part).toString(16).padStart(2, "0")).join("")}`;
}

function cssGradient(value: string | undefined): Gradient | undefined {
  if (!value || (!value.startsWith("linear-gradient") && !value.startsWith("radial-gradient"))) return undefined;
  const colors = (value.match(/(?:rgba?\([^)]*\)|#[\da-f]{3,8})/gi) || []).map(cssColor).filter((color): color is string => Boolean(color));
  if (colors.length < 2) return undefined;
  const stops = colors.map((color, index) => ({ color, offset: index / (colors.length - 1), opacity: 1 }));
  if (value.startsWith("radial-gradient")) return { type: "radial", startX: 0.5, startY: 0.5, endX: 1, endY: 0.5, width: 0.5, stops };
  const angle = value.match(/(-?\d+(?:\.\d+)?)deg/);
  const degrees = angle ? Number(angle[1]) : 180;
  const radians = (degrees - 90) * Math.PI / 180;
  return { type: "linear", startX: 0.5 - Math.cos(radians) / 2, startY: 0.5 - Math.sin(radians) / 2, endX: 0.5 + Math.cos(radians) / 2, endY: 0.5 + Math.sin(radians) / 2, width: 1, stops };
}

function applyShadow(shape: Shape, value: string | undefined): void {
  if (!value || value === "none") return;
  const color = cssColor((value.match(/rgba?\([^)]*\)|#[\da-f]{3,8}/i) || [])[0]);
  const dimensions = (value.match(/-?\d+(?:\.\d+)?px/g) || []).map((dimension) => Number.parseFloat(dimension));
  if (!color || dimensions.length < 3) return;
  shape.shadows = [{ style: value.includes("inset") ? "inner-shadow" : "drop-shadow", offsetX: dimensions[0], offsetY: dimensions[1], blur: dimensions[2], spread: dimensions[3] || 0, color: { color } }];
}

function applyPaint(shape: Shape, paint: ScenePaint): void {
  const color = cssColor(paint.backgroundColor);
  const gradient = cssGradient(paint.backgroundImage);
  const fills: Fill[] = gradient ? [{ fillColorGradient: gradient }] : color ? [{ fillColor: color, fillOpacity: paint.opacity ?? 1 }] : [];
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
    text.fontSize = String(Math.max(1, style.fontSize));
    text.fontWeight = String(style.fontWeight);
    text.fontStyle = style.fontStyle === "italic" ? "italic" : "normal";
    // Scene text styles use Penpot's unitless line-height multiplier.
    text.lineHeight = String(Math.max(0.01, style.lineHeight));
    // CSS permits negative tracking; Penpot's text API currently does not.
    text.letterSpacing = String(Math.max(0, style.letterSpacing));
    text.align = textAlign(style.textAlign);
    const textTransform = ["uppercase", "lowercase", "capitalize"].find((value) => value === style.textTransform);
    if (textTransform) text.textTransform = textTransform as Text["textTransform"];
    if (style.textDecoration.includes("line-through")) text.textDecoration = "line-through";
    else if (style.textDecoration.includes("underline")) text.textDecoration = "underline";
  }
  const color = cssColor(node.paint.color);
  if (color) text.fills = [{ fillColor: color, fillOpacity: node.paint.opacity ?? 1 }];
  return text;
}

async function mediaFor(asset: AssetRef) {
  if (asset.url?.startsWith("data:")) {
    const response = await fetch(asset.url);
    const data = new Uint8Array(await response.arrayBuffer());
    return penpot.uploadMediaData(asset.id, data, response.headers.get("content-type") || asset.mimeType || "image/png");
  }
  if (asset.url) return penpot.uploadMediaUrl(asset.id, asset.url);
  return undefined;
}

function svgTextOf(asset: AssetRef | undefined): string | undefined {
  const url = asset?.url;
  if (!url || !url.toLowerCase().startsWith("data:image/svg+xml")) return undefined;
  const comma = url.indexOf(",");
  if (comma < 0) return undefined;
  const encoded = url.slice(comma + 1);
  if (url.slice(0, comma).toLowerCase().endsWith(";base64")) {
    try { return atob(encoded); } catch { return undefined; }
  }
  try { return decodeURIComponent(encoded); } catch { return undefined; }
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

function createContainerBackdrop(node: SceneNode): Shape {
  const backdrop = penpot.createRectangle();
  // Opacity belongs to the complete container compositing group. Keeping
  // the backdrop fully opaque lets the group apply it once to both the
  // background and editable descendants.
  applyPaint(backdrop, { ...node.paint, opacity: 1 });
  return backdrop;
}

function applyContainerOpacity(shape: Shape, node: SceneNode): void {
  const opacity = node.paint.opacity;
  if (opacity === undefined || opacity === 1) return;
  shape.opacity = (shape.opacity ?? 1) * opacity;
}

function metadata(shape: Shape, node: SceneNode, viewportId: string): void {
  shape.name = node.name.slice(0, 200);
  shape.setPluginData("importer", IMPORT_NAMESPACE);
  shape.setPluginData("viewport", viewportId);
  shape.setPluginData("source", node.source);
  if (node.fallbackReason) shape.setPluginData("fallback", node.fallbackReason);
}

async function createShape(node: SceneNode, assets: Map<string, AssetRef>, media: Map<string, Awaited<ReturnType<typeof mediaFor>>>): Promise<Shape> {
  if (node.kind === "text") return createText(node);
  const asset = node.assetId ? assets.get(node.assetId) : undefined;
  const svg = svgTextOf(asset);
  if (svg) {
    try {
      const group = await penpot.createShapeFromSvgWithImages(svg);
      if (group) return group;
    } catch {
      // Keep a rectangle fallback if the SVG uses features Penpot cannot
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
  if ((node.kind === "image" || node.paint.backgroundImage?.includes("url(")) && node.assetId) {
    if (asset) {
      let uploaded = media.get(asset.id);
      if (!uploaded) {
        try { uploaded = await mediaFor(asset); media.set(asset.id, uploaded); } catch { /* A placeholder remains visible. */ }
      }
      if (uploaded) (shape as Shape & { fills: Fill[] }).fills = [{ fillImage: uploaded, fillOpacity: 1 }];
    }
  }
  return shape;
}

export async function importScenes(scenes: SceneDocument[], options: ImportOptions): Promise<Board[]> {
  const undo = penpot.history.undoBlockBegin();
  const boards: Board[] = [];
  const total = scenes.reduce((sum, scene) => sum + scene.nodes.length, 0);
  let completed = 0;
  const origin = { x: penpot.viewport.center.x, y: penpot.viewport.center.y };
  let x = origin.x;

  try {
    for (const scene of scenes) {
      if (options.isCancelled()) throw new ImportCancelledError();
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
      const media = new Map<string, Awaited<ReturnType<typeof mediaFor>>>();
      const shapes = new Map<string, Shape>();
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

          const backdrop = needsContainerBackdrop(node) ? createContainerBackdrop(node) : undefined;
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
            (shape as Text).growType = "auto-width";
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
          board.setPluginData("source", root.source);
          for (const child of childrenByParent.get(root.id) || []) await render(child, board);
          reportProgress();
        } else await render(root, board);
      }
    }
    return boards;
  } catch (error) {
    for (const board of boards) board.remove();
    throw error;
  } finally {
    penpot.history.undoBlockFinish(undo);
  }
}
