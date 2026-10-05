import type { Board, Shape } from "@penpot/plugin-types";
import { describe, expect, it, vi } from "vitest";
import type { Diagnostic, SceneNode } from "../shared/contracts";
import { predictFlex, type FlexPlan } from "./flexLayout";
import { applyNativeLayouts, type NativeFlexEntry } from "./nativeLayout";

interface FakeLayout { dir?: string; remove: () => void; [key: string]: unknown }
interface FakeShape {
  id: string; x: number; y: number; width: number; height: number; parent?: FakeShape;
  layoutChild?: { absolute: boolean };
  flex?: FakeLayout; data: Record<string, string>; children: FakeShape[];
  addFlexLayout?: () => FakeLayout; setPluginData: (key: string, value: string) => void;
}

let counter = 0;
function shape(x: number, y: number, width: number, height: number, parent?: FakeShape): FakeShape {
  counter += 1;
  const value: FakeShape = { id: `s${counter}`, x, y, width, height, parent, data: {}, children: [], layoutChild: { absolute: false }, setPluginData: (key, data) => { value.data[key] = data; } };
  parent?.children.push(value);
  return value;
}

const plan = (overrides: Partial<FlexPlan> = {}): FlexPlan => ({ dir: "row", gap: 10, padding: [0, 0, 0, 0], justify: "start", align: "start", flow: [], absolute: [], ...overrides });
const node = { id: "n", source: "#row" } as SceneNode;

/** A board whose layout, once settled, positions flow children like the supported model. */
function host(behavior: "runs" | "never" | "off-by-five", flowSizes: [number, number][], absolute = false) {
  const board = shape(100, 200, 400, 100);
  board.addFlexLayout = () => {
    const layout: FakeLayout = { remove: () => { board.flex = undefined; } };
    board.flex = layout;
    return layout;
  };
  const flow = flowSizes.map(([width, height], index) => shape(110 + index * 90, 210, width, height, board));
  const floating = absolute ? shape(board.x + 300, board.y + 60, 20, 20, board) : undefined;
  const entry: NativeFlexEntry = { node, plan: plan(), board: board as unknown as Board, flow: flow as unknown as Shape[], absolute: floating ? [floating as unknown as Shape] : [] };
  const settle = () => {
    if (behavior === "never" || !board.flex) return;
    const rects = predictFlex({ dir: "row", gap: 10, padding: [0, 0, 0, 0], justify: "start", align: "start" }, board, flow);
    flow.forEach((child, index) => { child.x = board.x + rects[index].x + (behavior === "off-by-five" && index ? 5 : 0); child.y = board.y + rects[index].y; });
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
    entry.plan = plan({ dir: "column", gap: 7, padding: [1, 2, 3, 4], justify: "center", align: "end" });
    const original = (board.addFlexLayout as () => FakeLayout);
    let configured: FakeLayout | undefined;
    board.addFlexLayout = () => { configured = original(); return configured; };
    await applyNativeLayouts([entry], hooks(() => { settle(); }));
    expect(configured).toMatchObject({ dir: "column", wrap: "nowrap", rowGap: 7, columnGap: 7, topPadding: 1, rightPadding: 2, bottomPadding: 3, leftPadding: 4, justifyContent: "center", alignItems: "end" });
  });
});
