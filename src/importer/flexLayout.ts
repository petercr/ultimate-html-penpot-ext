import type { Rect, SceneNode } from "../shared/contracts";
import { borderWidth, uniformBorder } from "./borders";

/** Largest difference, in pixels, between the browser's box and the model. */
export const FLEX_TOLERANCE = 1;

export type FlexJustify = "start" | "center" | "end" | "space-between" | "space-around" | "space-evenly";
export type FlexAlign = "start" | "center" | "end";

export interface FlexPlan {
  dir: "row" | "column";
  gap: number;
  /** Top, right, bottom, left, measured from the board edge: CSS padding plus border. */
  padding: [number, number, number, number];
  justify: FlexJustify;
  align: FlexAlign;
  /** In-flow children, in source order. */
  flow: SceneNode[];
  /** Positioned children that sit outside the flow, topmost first. */
  absolute: SceneNode[];
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

const positioned = (node: SceneNode): boolean => Boolean(node.layout.positioned || node.layout.absolute);
const rankOf = (node: SceneNode): string => node.zIndex < 0 ? `n${node.zIndex}` : node.zIndex > 0 ? `p${node.zIndex}` : positioned(node) ? "positioned" : "flow";

/**
 * Predict where a flex container of the supported subset places fixed-size
 * children. Positions are relative to the container's top-left corner. The same
 * model checks the browser snapshot before conversion and the host layout after.
 */
export function predictFlex(plan: Pick<FlexPlan, "dir" | "gap" | "padding" | "justify" | "align">, size: { width: number; height: number }, children: { width: number; height: number }[]): Rect[] {
  const [top, right, bottom, left] = plan.padding;
  const row = plan.dir === "row";
  const innerMain = (row ? size.width - left - right : size.height - top - bottom);
  const innerCross = (row ? size.height - top - bottom : size.width - left - right);
  const mains = children.map((child) => row ? child.width : child.height);
  const free = innerMain - mains.reduce((sum, value) => sum + value, 0) - plan.gap * Math.max(0, children.length - 1);
  let offset = 0;
  let spacing = plan.gap;
  const count = children.length;
  if (plan.justify === "center") offset = free / 2;
  else if (plan.justify === "end") offset = free;
  else if (plan.justify === "space-between" && count > 1) spacing += free / (count - 1);
  else if (plan.justify === "space-around") { offset = free / count / 2; spacing += free / count; }
  else if (plan.justify === "space-evenly") { offset = free / (count + 1); spacing += free / (count + 1); }
  let cursor = (row ? left : top) + offset;
  return children.map((child, index) => {
    const main = mains[index];
    const cross = row ? child.height : child.width;
    const crossOffset = plan.align === "center" ? (innerCross - cross) / 2 : plan.align === "end" ? innerCross - cross : 0;
    const crossStart = (row ? top : left) + crossOffset;
    const rect = row
      ? { x: cursor, y: crossStart, width: child.width, height: child.height }
      : { x: crossStart, y: cursor, width: child.width, height: child.height };
    cursor += main + spacing;
    return rect;
  });
}

/** True when every rect matches its prediction within the tolerance. */
export function matchesPrediction(actual: Rect[], expected: Rect[], tolerance = FLEX_TOLERANCE): boolean {
  return actual.length === expected.length && actual.every((rect, index) => Math.abs(rect.x - expected[index].x) <= tolerance && Math.abs(rect.y - expected[index].y) <= tolerance);
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
  if (layout.direction !== "row" && layout.direction !== "column") return { reason: `flex-direction ${layout.direction ?? "unknown"} is not supported.` };
  if (layout.wrap === "wrap") return { reason: "Wrapping flex containers are not supported." };
  const justify = JUSTIFY[layout.justifyContent ?? "normal"];
  if (!justify) return { reason: `justify-content ${layout.justifyContent} is not supported.` };
  const align = ALIGN[layout.alignItems ?? "normal"];
  if (!align) return { reason: `align-items ${layout.alignItems} is not supported.` };
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
  const border = borderWidth(container.paint, "top");
  const [top, right, bottom, left] = layout.padding ?? [0, 0, 0, 0];
  const gap = (layout.direction === "row" ? layout.columnGap : layout.rowGap) ?? 0;
  const plan: FlexPlan = {
    dir: layout.direction, gap, padding: [top + border, right + border, bottom + border, left + border], justify, align, flow,
    absolute: absolute.slice().reverse().sort((a, b) => b.zIndex - a.zIndex)
  };
  const free = (layout.direction === "row" ? container.rect.width - plan.padding[1] - plan.padding[3] : container.rect.height - plan.padding[0] - plan.padding[2])
    - flow.reduce((sum, child) => sum + (layout.direction === "row" ? child.rect.width : child.rect.height), 0) - gap * (flow.length - 1);
  if (justify !== "start" && free < -FLEX_TOLERANCE) return { reason: "The children overflow the container, which the native layout positions differently." };
  const expected = predictFlex(plan, container.rect, flow.map((child) => child.rect));
  const actual = flow.map((child) => ({ x: child.rect.x - container.rect.x, y: child.rect.y - container.rect.y, width: child.rect.width, height: child.rect.height }));
  if (!matchesPrediction(actual, expected)) return { reason: "The captured child positions do not match the supported flex model (margins, flex-grow, order, or auto margins)." };
  return { plan };
}
