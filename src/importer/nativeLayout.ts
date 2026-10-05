import type { Board, Shape } from "@penpot/plugin-types";
import type { Diagnostic, SceneNode } from "../shared/contracts";
import { FLEX_TOLERANCE, matchesPrediction, predictFlex, type FlexPlan } from "./flexLayout";

/** A board already holding its children at their captured positions. */
export interface NativeFlexEntry {
  node: SceneNode;
  plan: FlexPlan;
  board: Board;
  flow: (Shape | undefined)[];
  absolute: (Shape | undefined)[];
}

export interface NativeLayoutHooks {
  wait: (milliseconds: number) => Promise<void>;
  markDirty: () => void;
  diagnostic: (diagnostic: Diagnostic) => void;
  viewportId: string;
}

export interface NativeLayoutResult {
  converted: number;
  reverted: number;
}

// The host applies a layout asynchronously: positions were still the captured
// ones immediately afterwards and settled within 100 ms in live passes.
const SETTLE_DELAYS = [150, 250, 400];

interface Saved {
  entry: NativeFlexEntry;
  flow: Shape[];
  absolute: Shape[];
  offsets: Map<Shape, { dx: number; dy: number }>;
}

const rectOf = (shape: Shape, board: Board) => ({ x: shape.x - board.x, y: shape.y - board.y, width: shape.width, height: shape.height });

function settled(saved: Saved): boolean {
  const { entry, flow, absolute, offsets } = saved;
  const { board, plan } = entry;
  const actual = flow.map((shape) => rectOf(shape, board));
  // Predict from the sizes the host now has: text fitting may have changed
  // widths, and a native layout is expected to reflow around them.
  const expected = predictFlex(plan, { width: board.width, height: board.height }, actual);
  if (!matchesPrediction(actual, expected)) return false;
  return absolute.every((shape) => {
    const original = offsets.get(shape)!;
    return Math.abs(shape.x - board.x - original.dx) <= FLEX_TOLERANCE && Math.abs(shape.y - board.y - original.dy) <= FLEX_TOLERANCE;
  });
}

function restore(saved: Saved): void {
  const { entry, offsets } = saved;
  entry.board.flex?.remove();
  for (const shape of [...saved.flow, ...saved.absolute]) {
    const original = offsets.get(shape)!;
    shape.x = entry.board.x + original.dx;
    shape.y = entry.board.y + original.dy;
  }
}

/**
 * Turn captured containers into native Penpot flex boards, keeping only those
 * whose resulting layout reproduces the supported model. Children are first
 * piled at the board origin, so a layout that never ran is detected rather
 * than mistaken for one that matched. Entries are ordered outermost first.
 */
export async function applyNativeLayouts(entries: NativeFlexEntry[], hooks: NativeLayoutHooks): Promise<NativeLayoutResult> {
  const result: NativeLayoutResult = { converted: 0, reverted: 0 };
  const skipped: string[] = [];
  const usable: Saved[] = [];
  for (const entry of entries) {
    const flow = entry.flow.filter((shape): shape is Shape => Boolean(shape));
    const absolute = entry.absolute.filter((shape): shape is Shape => Boolean(shape));
    const complete = flow.length === entry.flow.length && absolute.length === entry.absolute.length;
    if (!complete || [...flow, ...absolute].some((shape) => shape.parent?.id !== entry.board.id)) {
      skipped.push(entry.node.source);
      continue;
    }
    const offsets = new Map<Shape, { dx: number; dy: number }>();
    for (const shape of [...flow, ...absolute]) offsets.set(shape, { dx: shape.x - entry.board.x, dy: shape.y - entry.board.y });
    usable.push({ entry, flow, absolute, offsets });
  }
  for (const { entry, flow, absolute, offsets } of usable) {
    const { board, plan } = entry;
    for (const shape of flow) { shape.x = board.x; shape.y = board.y; }
    const layout = board.addFlexLayout();
    layout.dir = plan.dir;
    layout.wrap = "nowrap";
    layout.rowGap = plan.gap;
    layout.columnGap = plan.gap;
    [layout.topPadding, layout.rightPadding, layout.bottomPadding, layout.leftPadding] = plan.padding;
    layout.justifyContent = plan.justify;
    layout.alignItems = plan.align;
    for (const shape of absolute) {
      if (shape.layoutChild) shape.layoutChild.absolute = true;
      const original = offsets.get(shape)!;
      shape.x = board.x + original.dx;
      shape.y = board.y + original.dy;
    }
    hooks.markDirty();
  }
  let pending = usable;
  for (const delay of SETTLE_DELAYS) {
    if (!pending.length) break;
    await hooks.wait(delay);
    pending = pending.filter((saved) => !settled(saved));
  }
  const failed = new Set(pending);
  // Undo outer layouts first: restoring an inner board's children is relative
  // to that board, which must already be back where it started.
  for (const saved of usable) {
    if (!failed.has(saved)) continue;
    restore(saved);
    result.reverted += 1;
    skipped.push(saved.entry.node.source);
  }
  for (const saved of usable) {
    if (failed.has(saved)) continue;
    saved.entry.board.setPluginData("native-layout", "flex");
    result.converted += 1;
  }
  if (result.reverted || skipped.length) {
    const count = skipped.length;
    hooks.diagnostic({
      severity: "warning",
      code: "NATIVE_LAYOUT_REVERTED",
      message: `${count} flex container${count === 1 ? "" : "s"} could not be reproduced by Penpot's layout and kept fixed geometry` + (count > 1 ? `, including ${skipped.slice(0, 3).join(", ")}.` : "."),
      viewportId: hooks.viewportId,
      source: skipped[0]
    });
  }
  if (result.reverted) hooks.markDirty();
  return result;
}
