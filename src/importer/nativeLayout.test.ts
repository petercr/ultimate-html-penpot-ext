import type { Board, Shape } from "@penpot/plugin-types";
import { describe, expect, it, vi } from "vitest";
import type { Diagnostic, SceneNode } from "../shared/contracts";
import { predictFlex, type FlexAlign, type FlexAlignContent, type FlexDirection, type FlexJustify, type FlexPlan, type Sides } from "./flexLayout";
import { applyNativeLayouts, type NativeFlexEntry } from "./nativeLayout";

interface FakeLayout { dir?: string; remove: () => void; [key: string]: unknown }
interface FakeChild { absolute: boolean; topMargin?: number; rightMargin?: number; bottomMargin?: number; leftMargin?: number; horizontalSizing?: string; verticalSizing?: string }
interface FakeShape {
  id: string; x: number; y: number; width: number; height: number; parent?: FakeShape;
  layoutChild?: FakeChild;
  flex?: FakeLayout; data: Record<string, string>; children: FakeShape[];
  addFlexLayout?: () => FakeLayout; setPluginData: (key: string, value: string) => void; resize: (width: number, height: number) => void;
}

// Like the live host, a reversed layout keeps its justification on the physical axis.
const cssJustify = (dir: unknown, justify: unknown): FlexJustify => (String(dir).endsWith("-reverse") ? ({ start: "end", end: "start" } as Record<string, FlexJustify>)[String(justify)] : undefined) ?? justify as FlexJustify;

let counter = 0;
function shape(x: number, y: number, width: number, height: number, parent?: FakeShape): FakeShape {
  counter += 1;
  const value: FakeShape = {
    id: `s${counter}`, x, y, width, height, parent, data: {}, children: [], layoutChild: { absolute: false },
    setPluginData: (key, data) => { value.data[key] = data; }, resize: (w, h) => { value.width = w; value.height = h; }
  };
  parent?.children.push(value);
  return value;
}

const plan = (overrides: Partial<FlexPlan> = {}): FlexPlan => ({
  dir: "row", wrap: false, gap: 10, crossGap: 0, padding: [0, 0, 0, 0], justify: "start", align: "start", alignContent: "stretch",
  flow: [], margins: [[0, 0, 0, 0], [0, 0, 0, 0]], fill: [false, false], absolute: [], ...overrides
});
const node = { id: "n", source: "#row" } as SceneNode;

/** A board whose layout, once settled, positions and fills flow children like the supported model. */
function host(behavior: "runs" | "never" | "off-by-five", flowSizes: [number, number][], absolute = false) {
  const board = shape(100, 200, 400, 100);
  board.addFlexLayout = () => {
    const layout: FakeLayout = { dir: "row", wrap: "nowrap", rowGap: 0, columnGap: 0, topPadding: 0, rightPadding: 0, bottomPadding: 0, leftPadding: 0, justifyContent: "start", alignItems: "start", remove: () => { board.flex = undefined; } };
    board.flex = layout;
    return layout;
  };
  const flow = flowSizes.map(([width, height], index) => shape(110 + index * 90, 210, width, height, board));
  const floating = absolute ? shape(board.x + 300, board.y + 60, 20, 20, board) : undefined;
  // The scene items the plan was made from, sized as captured.
  const items = flowSizes.map(([width, height]) => ({ kind: "box", rect: { x: 0, y: 0, width, height } }) as SceneNode);
  const entry: NativeFlexEntry = { node, plan: plan({ flow: items }), board: board as unknown as Board, flow: flow as unknown as Shape[], absolute: floating ? [floating as unknown as Shape] : [] };
  const settle = () => {
    const layout = board.flex;
    if (behavior === "never" || !layout) return;
    const row = String(layout.dir).startsWith("row");
    const rects = predictFlex({
      dir: layout.dir as FlexDirection, wrap: layout.wrap === "wrap", gap: (row ? layout.columnGap : layout.rowGap) as number, crossGap: (row ? layout.rowGap : layout.columnGap) as number,
      padding: [layout.topPadding, layout.rightPadding, layout.bottomPadding, layout.leftPadding] as Sides,
      justify: cssJustify(layout.dir, layout.justifyContent), align: layout.alignItems as FlexAlign, alignContent: (layout.alignContent ?? "stretch") as FlexAlignContent
    }, board, flow.map((child) => {
      const item = child.layoutChild!;
      return { width: child.width, height: child.height, margin: [item.topMargin ?? 0, item.rightMargin ?? 0, item.bottomMargin ?? 0, item.leftMargin ?? 0] as Sides, fill: (row ? item.horizontalSizing : item.verticalSizing) === "fill" };
    }));
    flow.forEach((child, index) => {
      Object.assign(child, { width: rects[index].width, height: rects[index].height });
      child.x = board.x + rects[index].x + (behavior === "off-by-five" && index ? 5 : 0);
      child.y = board.y + rects[index].y;
    });
  };
  return { board, flow, floating, entry, settle };
}

function hooks(settle: () => void, diagnostics: Diagnostic[] = []) {
  return { wait: vi.fn(async () => settle()), markDirty: vi.fn(), diagnostic: (diagnostic: Diagnostic) => diagnostics.push(diagnostic), viewportId: "desktop" };
}

describe("native layout application", () => {
  it("keeps a layout whose host result matches the model and marks the board", async () => {
    const { board, flow, entry, settle } = host("runs", [[50, 30], [60, 40]]);
    const diagnostics: Diagnostic[] = [];
    const result = await applyNativeLayouts([entry], hooks(settle, diagnostics));
    expect(result).toEqual({ converted: 1, reverted: 0 });
    expect(board.data["native-layout"]).toBe("flex");
    expect(flow.map((child) => child.x)).toEqual([100, 160]);
    expect(diagnostics).toEqual([]);
  });

  it("predicts from the host's current sizes, so reflowed text is not a mismatch", async () => {
    const { flow, entry, settle } = host("runs", [[50, 30], [60, 40]]);
    entry.plan.flow[0] = { ...entry.plan.flow[0], kind: "text" };
    flow[0].width = 80;
    expect(await applyNativeLayouts([entry], hooks(settle))).toEqual({ converted: 1, reverted: 0 });
    expect(flow[1].x).toBe(100 + 80 + 10);
  });

  it("detects a layout that never ran and restores the captured positions", async () => {
    const { board, flow, entry, settle } = host("never", [[50, 30], [60, 40]]);
    const diagnostics: Diagnostic[] = [];
    const result = await applyNativeLayouts([entry], hooks(settle, diagnostics));
    expect(result).toEqual({ converted: 0, reverted: 1 });
    expect(board.flex).toBeUndefined();
    expect(board.data["native-layout"]).toBeUndefined();
    expect(flow.map((child) => [child.x, child.y])).toEqual([[110, 210], [200, 210]]);
    expect(diagnostics).toMatchObject([{ code: "NATIVE_LAYOUT_REVERTED", source: "#row" }]);
  });

  it("reverts when the host's positions differ from the model", async () => {
    const { flow, entry, settle } = host("off-by-five", [[50, 30], [60, 40]]);
    expect(await applyNativeLayouts([entry], hooks(settle))).toEqual({ converted: 0, reverted: 1 });
    expect(flow.map((child) => child.x)).toEqual([110, 200]);
  });

  it("reverts when a layer's bounds are not its captured item, as with a group that shrinks to its content", async () => {
    const { flow, entry, settle } = host("runs", [[50, 30], [60, 40]]);
    flow[1].width = 36;
    expect(await applyNativeLayouts([entry], hooks(settle))).toEqual({ converted: 0, reverted: 1 });
    expect(flow.map((child) => child.x)).toEqual([110, 200]);
  });

  it("keeps absolute children outside the flow at their captured offsets", async () => {
    const { board, floating, entry, settle } = host("runs", [[50, 30], [60, 40]], true);
    expect(await applyNativeLayouts([entry], hooks(settle))).toEqual({ converted: 1, reverted: 0 });
    expect(floating?.layoutChild?.absolute).toBe(true);
    expect([floating?.x, floating?.y]).toEqual([board.x + 300, board.y + 60]);
  });

  it("skips a container whose child layer is missing or was regrouped, without touching it", async () => {
    const { board, entry, settle } = host("runs", [[50, 30], [60, 40]]);
    entry.flow[1] = undefined;
    const diagnostics: Diagnostic[] = [];
    expect(await applyNativeLayouts([entry], hooks(settle, diagnostics))).toEqual({ converted: 0, reverted: 0 });
    expect(board.flex).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
  });

  it("configures direction, gap, padding, and alignment on the host layout", async () => {
    const { board, entry, settle } = host("runs", [[50, 30]]);
    entry.plan = plan({ flow: entry.plan.flow, dir: "column", gap: 7, padding: [1, 2, 3, 4], justify: "center", align: "end" });
    const original = (board.addFlexLayout as () => FakeLayout);
    let configured: FakeLayout | undefined;
    board.addFlexLayout = () => { configured = original(); return configured; };
    await applyNativeLayouts([entry], hooks(() => { settle(); }));
    expect(configured).toMatchObject({ dir: "column", wrap: "nowrap", rowGap: 7, columnGap: 0, topPadding: 1, rightPadding: 2, bottomPadding: 3, leftPadding: 4, justifyContent: "center", alignItems: "end" });
    expect(configured).not.toHaveProperty("alignContent");
  });

  it("configures a wrapping row with its line gap and line placement", async () => {
    const { board, entry, settle } = host("runs", [[50, 30], [60, 40]]);
    entry.plan = plan({ flow: entry.plan.flow, wrap: true, gap: 6, crossGap: 4, alignContent: "center" });
    expect(await applyNativeLayouts([entry], hooks(settle))).toEqual({ converted: 1, reverted: 0 });
    expect(board.flex).toMatchObject({ dir: "row", wrap: "wrap", columnGap: 6, rowGap: 4, alignContent: "center" });
  });

  it("mirrors a reversed row's justification onto Penpot's physical axis", async () => {
    const { board, flow, entry, settle } = host("runs", [[50, 30], [60, 40]]);
    entry.plan = plan({ flow: entry.plan.flow, dir: "row-reverse" });
    expect(await applyNativeLayouts([entry], hooks(settle))).toEqual({ converted: 1, reverted: 0 });
    expect(board.flex).toMatchObject({ dir: "row-reverse", justifyContent: "end" });
    // CSS flex-start in a reversed row packs against the right edge, first item rightmost.
    expect(flow.map((child) => child.x)).toEqual([100 + 350, 100 + 280]);
  });

  it("sets a text layer's margins and a growing layer's fill sizing, and checks the host's filled size", async () => {
    const { flow, entry, settle } = host("runs", [[50, 16], [60, 40]]);
    entry.plan = plan({ flow: entry.plan.flow, margins: [[1, 0, 2.6, 0], [0, 0, 0, 0]], fill: [false, true] });
    expect(await applyNativeLayouts([entry], hooks(settle))).toEqual({ converted: 1, reverted: 0 });
    expect(flow[0].layoutChild).toMatchObject({ topMargin: 1, rightMargin: 0, bottomMargin: 2.6, leftMargin: 0 });
    expect(flow[0].y).toBe(200 + 1);
    expect(flow[1].layoutChild).toMatchObject({ horizontalSizing: "fill" });
    expect(flow[1].layoutChild).not.toHaveProperty("topMargin");
    expect([flow[1].x, flow[1].width]).toEqual([100 + 60, 400 - 60]);
  });

  it("reverts a layer the host did not fill and restores its captured size", async () => {
    const { flow, entry } = host("runs", [[50, 30], [60, 40]]);
    entry.plan = plan({ flow: entry.plan.flow, fill: [false, true] });
    // A host that positions the flow but ignores fill sizing.
    const settle = () => { flow[0].x = 100; flow[0].y = 200; flow[1].x = 160; flow[1].y = 200; flow[1].width = 70; };
    expect(await applyNativeLayouts([entry], hooks(settle))).toEqual({ converted: 0, reverted: 1 });
    expect([flow[1].x, flow[1].y, flow[1].width, flow[1].height]).toEqual([200, 210, 60, 40]);
  });
});
