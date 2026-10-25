import type { Rect, SceneDocument, SceneNode } from "../shared/contracts";
import { borderWidth, uniformBorder } from "./borders";

/** Largest difference, in pixels, between the browser's box and the model. */
export const FLEX_TOLERANCE = 1;

export type FlexDirection = "row" | "row-reverse" | "column" | "column-reverse";
export type FlexJustify = "start" | "center" | "end" | "space-between" | "space-around" | "space-evenly";
export type FlexAlign = "start" | "center" | "end";
export type FlexAlignContent = "start" | "center" | "end" | "space-between" | "space-around" | "space-evenly" | "stretch";
/** Top, right, bottom, left. */
export type Sides = [number, number, number, number];

export interface FlexLayoutModel {
  dir: FlexDirection;
  wrap: boolean;
  /** Gap between items along the main axis. */
  gap: number;
  /** Gap between lines of a wrapping container. */
  crossGap: number;
  /** Measured from the board edge: CSS padding plus border. */
  padding: Sides;
  justify: FlexJustify;
  align: FlexAlign;
  /** Placement of the lines of a wrapping container. */
  alignContent: FlexAlignContent;
}

export interface FlexPlan extends FlexLayoutModel {
  /** In-flow children, in source order. */
  flow: SceneNode[];
  /** Space around each flow layer inside its flex item: a text layer's glyph
   * line sits inside its element's box. */
  margins: Sides[];
  /** Flow layers that grow along the main axis (Penpot `fill` sizing). */
  fill: boolean[];
  /** Positioned children that sit outside the flow, topmost first. */
  absolute: SceneNode[];
}

export interface FlexItem {
  width: number;
  height: number;
  margin?: Sides;
  /** Share the line's free main-axis space equally with the other fill items. */
  fill?: boolean;
}

export type FlexDecision = { plan: FlexPlan } | { reason: string };

const JUSTIFY: Record<string, FlexJustify> = {
  normal: "start", "flex-start": "start", start: "start", center: "center", "flex-end": "end", end: "end",
  "space-between": "space-between", "space-around": "space-around", "space-evenly": "space-evenly"
};
// The browser's default (normal/stretch) already gives each child its stretched
// size in the snapshot, so top-aligning fixed-size children reproduces it.
const ALIGN: Record<string, FlexAlign> = {
  normal: "start", stretch: "start", "flex-start": "start", start: "start", "self-start": "start",
  center: "center", "flex-end": "end", end: "end", "self-end": "end"
};
const ALIGN_CONTENT: Record<string, FlexAlignContent> = {
  normal: "stretch", stretch: "stretch", "flex-start": "start", start: "start", center: "center", "flex-end": "end", end: "end",
  "space-between": "space-between", "space-around": "space-around", "space-evenly": "space-evenly"
};
// `start` and `end` follow the writing mode, not the flex direction, so in a
// reversed container they are the opposite ends of the main axis.
const REVERSED_KEYWORD: Record<string, string> = { start: "flex-end", end: "flex-start" };
const NO_MARGIN: Sides = [0, 0, 0, 0];

const positioned = (node: SceneNode): boolean => Boolean(node.layout.positioned || node.layout.absolute);
const rankOf = (node: SceneNode): string => node.zIndex < 0 ? `n${node.zIndex}` : node.zIndex > 0 ? `p${node.zIndex}` : positioned(node) ? "positioned" : "flow";

/** Leading offset and extra spacing that distribute `free` space among `count` slots. */
function distribute(mode: FlexJustify | FlexAlignContent, free: number, count: number): { offset: number; spacing: number } {
  if (mode === "center") return { offset: free / 2, spacing: 0 };
  if (mode === "end") return { offset: free, spacing: 0 };
  if (mode === "space-between") return { offset: 0, spacing: count > 1 ? free / (count - 1) : 0 };
  if (mode === "space-around") return { offset: free / count / 2, spacing: free / count };
  if (mode === "space-evenly") return { offset: free / (count + 1), spacing: free / (count + 1) };
  return { offset: 0, spacing: 0 };
}

/** Indices of the items on each line; a line breaks before an item whose outer size no longer fits. */
function breakLines(outer: number[], gap: number, innerMain: number, wrap: boolean): number[][] {
  const lines: number[][] = [];
  let used = 0;
  outer.forEach((size, index) => {
    const line = lines[lines.length - 1];
    if (line && (!wrap || used + gap + size <= innerMain + 0.05)) { line.push(index); used += gap + size; }
    else { lines.push([index]); used = size; }
  });
  return lines;
}

/**
 * Predict where a flex container of the supported subset places its children.
 * Items keep their size unless they fill; a margin is the space between the
 * layer and its item's edge. Positions are the layers' own rects, relative to
 * the container's top-left corner. The same model checks the browser snapshot
 * before conversion and the host layout after.
 */
export function predictFlex(plan: FlexLayoutModel, size: { width: number; height: number }, children: FlexItem[]): Rect[] {
  const [top, right, bottom, left] = plan.padding;
  const row = plan.dir === "row" || plan.dir === "row-reverse";
  const reverse = plan.dir.endsWith("-reverse");
  const innerMain = row ? size.width - left - right : size.height - top - bottom;
  const innerCross = row ? size.height - top - bottom : size.width - left - right;
  const items = children.map((child) => {
    const [mt, mr, mb, ml] = child.margin ?? NO_MARGIN;
    // A reversed axis starts at the far edge, so the far margin leads.
    const [lead, trail] = row ? (reverse ? [mr, ml] : [ml, mr]) : (reverse ? [mb, mt] : [mt, mb]);
    const [crossLead, crossTrail] = row ? [mt, mb] : [ml, mr];
    return { child, main: row ? child.width : child.height, cross: row ? child.height : child.width, lead, trail, crossLead, crossTrail };
  });
  const lines = breakLines(items.map((item) => item.lead + item.main + item.trail), plan.gap, innerMain, plan.wrap).map((line) => line.map((index) => items[index]));
  const crossSizes = lines.map((line) => plan.wrap ? Math.max(...line.map((item) => item.crossLead + item.cross + item.crossTrail)) : innerCross);
  const freeCross = innerCross - crossSizes.reduce((sum, value) => sum + value, 0) - plan.crossGap * (lines.length - 1);
  let crossCursor = 0;
  let crossSpacing = plan.crossGap;
  if (plan.wrap && plan.alignContent === "stretch") {
    if (freeCross > 0) crossSizes.forEach((_, index) => { crossSizes[index] += freeCross / lines.length; });
  } else if (plan.wrap) {
    const placed = distribute(plan.alignContent, freeCross, lines.length);
    crossCursor = placed.offset;
    crossSpacing += placed.spacing;
  }
  const rects = new Map<FlexItem, Rect>();
  lines.forEach((line, lineIndex) => {
    const fills = line.filter((item) => item.child.fill);
    const fixed = line.reduce((sum, item) => sum + item.lead + item.trail + (item.child.fill ? 0 : item.main), 0) + plan.gap * (line.length - 1);
    const fillSize = fills.length ? Math.max(0, (innerMain - fixed) / fills.length) : 0;
    const mains = line.map((item) => item.child.fill ? fillSize : item.main);
    const free = innerMain - fixed - fillSize * fills.length;
    const { offset, spacing } = distribute(plan.justify, free, line.length);
    let cursor = offset;
    line.forEach((item, index) => {
      const main = mains[index];
      // Lay the line out forwards, then mirror a reversed axis.
      const start = reverse ? innerMain - (cursor + item.lead) - main : cursor + item.lead;
      cursor += item.lead + main + item.trail + plan.gap + spacing;
      const room = crossSizes[lineIndex] - item.crossLead - item.cross - item.crossTrail;
      const crossStart = crossCursor + item.crossLead + (plan.align === "center" ? room / 2 : plan.align === "end" ? room : 0);
      const width = row ? main : item.child.width;
      const height = row ? item.child.height : main;
      rects.set(item.child, row
        ? { x: left + start, y: top + crossStart, width, height }
        : { x: left + crossStart, y: top + start, width, height });
    });
    crossCursor += crossSizes[lineIndex] + crossSpacing;
  });
  return children.map((child) => rects.get(child)!);
}

/** True when every rect matches its prediction within the tolerance. */
export function matchesPrediction(actual: Rect[], expected: Rect[], tolerance = FLEX_TOLERANCE): boolean {
  return actual.length === expected.length && actual.every((rect, index) => (["x", "y", "width", "height"] as const).every((key) => Math.abs(rect[key] - expected[index][key]) <= tolerance));
}

/** The flex item a scene child stands for: a text layer's item is its element's box. */
function itemOf(child: SceneNode): { margin: Sides } | { reason: string } {
  const box = child.kind === "text" ? child.box : undefined;
  if (!box) return { margin: NO_MARGIN };
  const { rect } = child;
  const margin: Sides = [rect.y - box.y, box.x + box.width - rect.x - rect.width, box.y + box.height - rect.y - rect.height, rect.x - box.x];
  if (margin.some((value) => value < -FLEX_TOLERANCE)) return { reason: "A text line overflows its element's box." };
  return { margin: margin.map((value) => Math.max(0, Math.round(value * 100) / 100)) as Sides };
}

/**
 * Decide whether a container's captured layout maps to a native Penpot flex
 * layout without changing its initial appearance. `children` are the
 * container's scene children in source order.
 */
export function planFlex(container: SceneNode, children: SceneNode[]): FlexDecision {
  const layout = container.layout;
  if (container.kind !== "container" || layout.kind !== "flex") return { reason: "It is not a flex container." };
  if (container.rotation) return { reason: "The container is rotated." };
  const dir = layout.direction;
  if (dir !== "row" && dir !== "column" && dir !== "row-reverse" && dir !== "column-reverse") return { reason: `flex-direction ${dir ?? "unknown"} is not supported.` };
  if (layout.wrap === "wrap-reverse") return { reason: "flex-wrap: wrap-reverse is not supported." };
  const wrap = layout.wrap === "wrap";
  const reverse = dir.endsWith("-reverse");
  // Penpot reverses the whole sequence and then breaks lines, so its lines hold
  // different items from the browser's, which breaks them in source order.
  if (wrap && reverse) return { reason: "Wrapping reversed containers break their lines differently in Penpot." };
  const justifyKeyword = layout.justifyContent ?? "normal";
  const justify = JUSTIFY[reverse ? REVERSED_KEYWORD[justifyKeyword] ?? justifyKeyword : justifyKeyword];
  if (!justify) return { reason: `justify-content ${layout.justifyContent} is not supported.` };
  const align = ALIGN[layout.alignItems ?? "normal"];
  if (!align) return { reason: `align-items ${layout.alignItems} is not supported.` };
  const alignContent = wrap ? ALIGN_CONTENT[layout.alignContent ?? "normal"] : "stretch";
  if (!alignContent) return { reason: `align-content ${layout.alignContent} is not supported.` };
  if (container.paint.borders && !uniformBorder(container.paint)) return { reason: "Per-side borders are drawn as separate paths." };
  if (children.some((child) => child.rotation)) return { reason: "A child is rotated." };
  const absolute = children.filter((child) => child.layout.absolute);
  if (absolute.some((child) => child.zIndex < 0)) return { reason: "An absolutely positioned child paints behind the container's content." };
  const flow = children.filter((child) => !child.layout.absolute);
  if (!flow.length) return { reason: "It has no in-flow children." };
  // Penpot lays children out in layer order, so the browser's paint order must
  // match source order among them; a z-index or positioned sibling would not.
  if (new Set(flow.map(rankOf)).size > 1) return { reason: "In-flow children differ in stacking, so their paint order is not their source order." };
  if (absolute.length && rankOf(flow[0]) !== "flow") return { reason: "Positioned or stacked in-flow children can paint above or below the absolutely positioned ones." };
  const margins: Sides[] = [];
  for (const child of flow) {
    const item = itemOf(child);
    if ("reason" in item) return item;
    margins.push(item.margin);
  }
  const border = borderWidth(container.paint, "top");
  const [top, right, bottom, left] = layout.padding ?? [0, 0, 0, 0];
  const row = dir === "row" || dir === "row-reverse";
  const model: FlexLayoutModel = {
    dir, wrap, gap: (row ? layout.columnGap : layout.rowGap) ?? 0, crossGap: (row ? layout.rowGap : layout.columnGap) ?? 0,
    padding: [top + border, right + border, bottom + border, left + border], justify, align, alignContent
  };
  const innerMain = row ? container.rect.width - model.padding[1] - model.padding[3] : container.rect.height - model.padding[0] - model.padding[2];
  const innerCross = row ? container.rect.height - model.padding[0] - model.padding[2] : container.rect.width - model.padding[1] - model.padding[3];
  const outer = flow.map((child, index) => {
    const [mt, mr, mb, ml] = margins[index];
    return row ? { main: ml + child.rect.width + mr, cross: mt + child.rect.height + mb } : { main: mt + child.rect.height + mb, cross: ml + child.rect.width + mr };
  });
  if (justify !== "start") {
    const overflow = wrap ? outer.some((item) => item.main > innerMain + FLEX_TOLERANCE)
      : innerMain - outer.reduce((sum, item) => sum + item.main, 0) - model.gap * (flow.length - 1) < -FLEX_TOLERANCE;
    if (overflow) return { reason: "The children overflow the container, which the native layout positions differently." };
  }
  const actual = flow.map((child) => ({ x: child.rect.x - container.rect.x, y: child.rect.y - container.rect.y, width: child.rect.width, height: child.rect.height }));
  const items = (fill: boolean[]): FlexItem[] => flow.map((child, index) => ({ width: child.rect.width, height: child.rect.height, margin: margins[index], fill: fill[index] }));
  const fixed = flow.map(() => false);
  if (wrap && alignContent !== "start" && alignContent !== "stretch") {
    const lines = breakLines(outer.map((item) => item.main), model.gap, innerMain, true);
    const used = lines.reduce((sum, line) => sum + Math.max(...line.map((index) => outer[index].cross)), 0) + model.crossGap * (lines.length - 1);
    if (innerCross - used < -FLEX_TOLERANCE) return { reason: "The lines overflow the container, which the native layout positions differently." };
  }
  // A growing item fills its line in Penpot. Try that first so the board stays
  // responsive; when the browser sized it otherwise (unequal growth, a basis,
  // or a min or max size), the captured size still reproduces it as fixed.
  // Text keeps its fitted width, and growth in a wrapping line is not modelled.
  const fill = flow.map((child) => !wrap && child.kind !== "text" && (child.layout.flexGrow ?? 0) > 0);
  if (fill.some(Boolean) && matchesPrediction(actual, predictFlex(model, container.rect, items(fill)))) return { plan: { ...model, flow, margins, fill, absolute: sortAbsolute(absolute) } };
  if (!matchesPrediction(actual, predictFlex(model, container.rect, items(fixed)))) return { reason: "The captured child positions do not match the supported flex model (margins, order, or auto margins)." };
  return { plan: { ...model, flow, margins, fill: fixed, absolute: sortAbsolute(absolute) } };
}

const sortAbsolute = (absolute: SceneNode[]): SceneNode[] => absolute.slice().reverse().sort((a, b) => b.zIndex - a.zIndex);

/**
 * The native layout decision for every flex container of a scene, in source
 * order. The scene root is left out: it becomes the viewport board itself.
 */
export function planSceneFlex(scene: SceneDocument): { node: SceneNode; decision: FlexDecision }[] {
  const ids = new Set(scene.nodes.map((node) => node.id));
  const children = new Map<string, SceneNode[]>();
  for (const node of scene.nodes) {
    if (!node.parentId || !ids.has(node.parentId)) continue;
    children.set(node.parentId, [...(children.get(node.parentId) || []), node]);
  }
  return scene.nodes
    .filter((node) => node.kind === "container" && node.layout.kind === "flex" && node.parentId && ids.has(node.parentId))
    .map((node) => ({ node, decision: planFlex(node, children.get(node.id) || []) }));
}
