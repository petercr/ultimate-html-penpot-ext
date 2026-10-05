import { describe, expect, it } from "vitest";
import type { SceneLayout, SceneNode } from "../shared/contracts";
import { matchesPrediction, planFlex, predictFlex } from "./flexLayout";

let counter = 0;
function node(rect: { x: number; y: number; width: number; height: number }, layout: Partial<SceneLayout> = {}, extra: Partial<SceneNode> = {}): SceneNode {
  counter += 1;
  return { id: `n${counter}`, children: [], kind: "box", name: "box", source: `#n${counter}`, rect, zIndex: 0, paint: {}, layout: { kind: "none", ...layout }, ...extra };
}
function container(rect: { x: number; y: number; width: number; height: number }, layout: Partial<SceneLayout>, paint = {}): SceneNode {
  return node(rect, { kind: "flex", direction: "row", wrap: "nowrap", justifyContent: "normal", alignItems: "normal", rowGap: 0, columnGap: 0, padding: [0, 0, 0, 0], ...layout }, { kind: "container", paint });
}

describe("flex prediction", () => {
  const size = { width: 400, height: 100 };
  const items = [{ width: 50, height: 30 }, { width: 60, height: 40 }, { width: 70, height: 20 }];

  it("places a row with gap and padding from the board edge", () => {
    const rects = predictFlex({ dir: "row", gap: 10, padding: [6, 8, 6, 8], justify: "start", align: "start" }, size, items);
    expect(rects.map((rect) => [rect.x, rect.y])).toEqual([[8, 6], [68, 6], [138, 6]]);
  });

  it("distributes free space for each justification", () => {
    const base = { dir: "row" as const, gap: 0, padding: [0, 0, 0, 0] as [number, number, number, number], align: "start" as const };
    expect(predictFlex({ ...base, justify: "space-between" }, size, items).map((rect) => rect.x)).toEqual([0, 160, 330]);
    expect(predictFlex({ ...base, justify: "center" }, size, items).map((rect) => rect.x)).toEqual([110, 160, 220]);
    expect(predictFlex({ ...base, justify: "end" }, size, items).map((rect) => rect.x)).toEqual([220, 270, 330]);
    const around = predictFlex({ ...base, justify: "space-around" }, size, items).map((rect) => rect.x);
    [36.667, 160, 293.333].forEach((value, index) => expect(around[index]).toBeCloseTo(value, 2));
    expect(predictFlex({ ...base, justify: "space-evenly" }, size, items)[0].x).toBeCloseTo(55);
  });

  it("aligns the cross axis and lays out a column", () => {
    const centered = predictFlex({ dir: "row", gap: 0, padding: [0, 0, 0, 0], justify: "start", align: "center" }, size, items);
    expect(centered.map((rect) => rect.y)).toEqual([35, 30, 40]);
    const column = predictFlex({ dir: "column", gap: 12, padding: [0, 0, 0, 0], justify: "start", align: "start" }, { width: 300, height: 200 }, items);
    expect(column.map((rect) => rect.y)).toEqual([0, 42, 94]);
  });

  it("compares positions within a one-pixel tolerance", () => {
    const expected = [{ x: 0, y: 0, width: 1, height: 1 }];
    expect(matchesPrediction([{ x: 0.9, y: -0.5, width: 1, height: 1 }], expected)).toBe(true);
    expect(matchesPrediction([{ x: 1.5, y: 0, width: 1, height: 1 }], expected)).toBe(false);
  });
});

describe("flex planning", () => {
  it("accepts a padded, bordered row and folds the border into the padding", () => {
    const parent = container({ x: 100, y: 100, width: 400, height: 100 }, { columnGap: 10, padding: [6, 8, 6, 8] }, { borderWidth: 2, borderStyle: "solid", borderColor: "red" });
    const children = [node({ x: 110, y: 108, width: 50, height: 30 }), node({ x: 170, y: 108, width: 60, height: 40 })];
    const decision = planFlex(parent, children);
    expect(decision).toMatchObject({ plan: { dir: "row", gap: 10, padding: [8, 10, 8, 10], justify: "start", align: "start" } });
  });

  it("maps the browser's default stretch to top alignment and keeps absolute children out of the flow", () => {
    const parent = container({ x: 0, y: 0, width: 300, height: 60 }, { direction: "column", rowGap: 4 });
    const flow = [node({ x: 0, y: 0, width: 300, height: 20 }), node({ x: 0, y: 24, width: 300, height: 20 })];
    const badge = node({ x: 280, y: -4, width: 20, height: 20 }, { absolute: true, positioned: true });
    const decision = planFlex(parent, [flow[0], badge, flow[1]]);
    expect(decision).toMatchObject({ plan: { dir: "column", align: "start" } });
    expect("plan" in decision && decision.plan.flow).toEqual(flow);
    expect("plan" in decision && decision.plan.absolute).toEqual([badge]);
  });

  it.each([
    ["reversed direction", { direction: "row-reverse" as const }],
    ["wrapping", { wrap: "wrap" as const }],
    ["baseline alignment", { alignItems: "baseline" }],
    ["unsupported justification", { justifyContent: "left" }]
  ])("keeps %s as fixed geometry", (_name, layout) => {
    const parent = container({ x: 0, y: 0, width: 200, height: 40 }, layout);
    const decision = planFlex(parent, [node({ x: 0, y: 0, width: 50, height: 20 })]);
    expect(decision).toHaveProperty("reason");
  });

  it("keeps a container fixed when the browser's positions do not fit the model", () => {
    // A 30px margin between the children is not expressible as the model's gap.
    const parent = container({ x: 0, y: 0, width: 400, height: 40 }, { columnGap: 0 });
    const decision = planFlex(parent, [node({ x: 0, y: 0, width: 50, height: 20 }), node({ x: 80, y: 0, width: 50, height: 20 })]);
    expect(decision).toMatchObject({ reason: expect.stringContaining("do not match") });
  });

  it("rejects rotated children, per-side borders, differing stacking, and overflow with centering", () => {
    const one = node({ x: 0, y: 0, width: 50, height: 20 });
    expect(planFlex(container({ x: 0, y: 0, width: 200, height: 40 }, {}), [{ ...one, rotation: 10 }])).toHaveProperty("reason");
    const sided = container({ x: 0, y: 0, width: 200, height: 40 }, {}, { borders: { top: { color: "red", width: 1, style: "solid" }, right: { color: "red", width: 0, style: "none" }, bottom: { color: "red", width: 0, style: "none" }, left: { color: "red", width: 0, style: "none" } } });
    expect(planFlex(sided, [one])).toHaveProperty("reason");
    const stacked = { ...node({ x: 50, y: 0, width: 50, height: 20 }), zIndex: 3 };
    expect(planFlex(container({ x: 0, y: 0, width: 200, height: 40 }, {}), [one, stacked])).toMatchObject({ reason: expect.stringContaining("stacking") });
    const wide = [node({ x: -20, y: 0, width: 120, height: 20 }), node({ x: 100, y: 0, width: 120, height: 20 })];
    expect(planFlex(container({ x: 0, y: 0, width: 200, height: 40 }, { justifyContent: "center" }), wide)).toMatchObject({ reason: expect.stringContaining("overflow") });
  });

  it("returns absolute children topmost first", () => {
    const parent = container({ x: 0, y: 0, width: 100, height: 40 }, {});
    const low = node({ x: 0, y: 0, width: 10, height: 10 }, { absolute: true, positioned: true });
    const high = node({ x: 10, y: 0, width: 10, height: 10 }, { absolute: true, positioned: true }, { zIndex: 4 });
    const later = node({ x: 20, y: 0, width: 10, height: 10 }, { absolute: true, positioned: true });
    const flow = node({ x: 0, y: 0, width: 100, height: 40 });
    const decision = planFlex(parent, [low, high, later, flow]);
    expect("plan" in decision && decision.plan.absolute).toEqual([high, later, low]);
  });
});
