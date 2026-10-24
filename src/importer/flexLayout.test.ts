import { describe, expect, it } from "vitest";
import type { SceneLayout, SceneNode } from "../shared/contracts";
import { matchesPrediction, planFlex, predictFlex, type FlexLayoutModel } from "./flexLayout";

let counter = 0;
function node(rect: { x: number; y: number; width: number; height: number }, layout: Partial<SceneLayout> = {}, extra: Partial<SceneNode> = {}): SceneNode {
  counter += 1;
  return { id: `n${counter}`, children: [], kind: "box", name: "box", source: `#n${counter}`, rect, zIndex: 0, paint: {}, layout: { kind: "none", ...layout }, ...extra };
}
function container(rect: { x: number; y: number; width: number; height: number }, layout: Partial<SceneLayout>, paint = {}): SceneNode {
  return node(rect, { kind: "flex", direction: "row", wrap: "nowrap", justifyContent: "normal", alignItems: "normal", rowGap: 0, columnGap: 0, padding: [0, 0, 0, 0], ...layout }, { kind: "container", paint });
}

const model = (overrides: Partial<FlexLayoutModel> = {}): FlexLayoutModel => ({ dir: "row", wrap: false, gap: 0, crossGap: 0, padding: [0, 0, 0, 0], justify: "start", align: "start", alignContent: "stretch", ...overrides });

describe("flex prediction", () => {
  const size = { width: 400, height: 100 };
  const items = [{ width: 50, height: 30 }, { width: 60, height: 40 }, { width: 70, height: 20 }];

  it("places a row with gap and padding from the board edge", () => {
    const rects = predictFlex(model({ gap: 10, padding: [6, 8, 6, 8] }), size, items);
    expect(rects.map((rect) => [rect.x, rect.y])).toEqual([[8, 6], [68, 6], [138, 6]]);
  });

  it("distributes free space for each justification", () => {
    const base = model();
    expect(predictFlex({ ...base, justify: "space-between" }, size, items).map((rect) => rect.x)).toEqual([0, 160, 330]);
    expect(predictFlex({ ...base, justify: "center" }, size, items).map((rect) => rect.x)).toEqual([110, 160, 220]);
    expect(predictFlex({ ...base, justify: "end" }, size, items).map((rect) => rect.x)).toEqual([220, 270, 330]);
    const around = predictFlex({ ...base, justify: "space-around" }, size, items).map((rect) => rect.x);
    [36.667, 160, 293.333].forEach((value, index) => expect(around[index]).toBeCloseTo(value, 2));
    expect(predictFlex({ ...base, justify: "space-evenly" }, size, items)[0].x).toBeCloseTo(55);
  });

  it("aligns the cross axis and lays out a column", () => {
    const centered = predictFlex(model({ align: "center" }), size, items);
    expect(centered.map((rect) => rect.y)).toEqual([35, 30, 40]);
    const column = predictFlex(model({ dir: "column", gap: 12 }), { width: 300, height: 200 }, items);
    expect(column.map((rect) => rect.y)).toEqual([0, 42, 94]);
  });

  it("compares positions and sizes within a one-pixel tolerance", () => {
    const expected = [{ x: 0, y: 0, width: 1, height: 1 }];
    expect(matchesPrediction([{ x: 0.9, y: -0.5, width: 1.5, height: 1 }], expected)).toBe(true);
    expect(matchesPrediction([{ x: 1.5, y: 0, width: 1, height: 1 }], expected)).toBe(false);
    expect(matchesPrediction([{ x: 0, y: 0, width: 3, height: 1 }], expected)).toBe(false);
  });

  it("places reversed rows and columns from the far edge", () => {
    expect(predictFlex(model({ dir: "row-reverse", gap: 10, padding: [0, 5, 0, 0] }), size, items).map((rect) => rect.x)).toEqual([345, 275, 195]);
    expect(predictFlex(model({ dir: "row-reverse", justify: "end" }), size, items).map((rect) => rect.x)).toEqual([130, 70, 0]);
    expect(predictFlex(model({ dir: "column-reverse", gap: 5 }), { width: 300, height: 200 }, items).map((rect) => rect.y)).toEqual([170, 125, 100]);
  });

  it("keeps the space around a layer inside its item, on the physical side in a reversed row", () => {
    const margin: [number, number, number, number] = [1, 2, 3, 4];
    const rects = predictFlex(model({ gap: 10 }), size, [{ width: 50, height: 16, margin }, { width: 60, height: 40 }]);
    expect(rects.map((rect) => [rect.x, rect.y])).toEqual([[4, 1], [66, 0]]);
    const reversed = predictFlex(model({ dir: "row-reverse" }), size, [{ width: 50, height: 16, margin }]);
    expect(reversed[0].x).toBe(400 - 2 - 50);
    const centered = predictFlex(model({ align: "center" }), size, [{ width: 50, height: 16, margin }]);
    expect(centered[0].y).toBe((100 - 20) / 2 + 1);
  });

  it("shares the free main-axis space equally among filling items", () => {
    const rects = predictFlex(model({ gap: 10, padding: [0, 10, 0, 10] }), size, [{ width: 50, height: 30 }, { width: 1, height: 30, fill: true }, { width: 1, height: 30, fill: true }]);
    expect(rects.map((rect) => [rect.x, rect.width])).toEqual([[10, 50], [70, 155], [235, 155]]);
    const column = predictFlex(model({ dir: "column" }), { width: 100, height: 200 }, [{ width: 100, height: 20 }, { width: 100, height: 5, fill: true }]);
    expect(column[1]).toEqual({ x: 0, y: 20, width: 100, height: 180 });
  });

  it("breaks wrapping lines and places them by align-content", () => {
    const wrap = model({ wrap: true, gap: 10, crossGap: 4 });
    const tight = { width: 130, height: 100 };
    // Stretched lines share the 36px left over: 40 + 18, then the gap.
    expect(predictFlex(wrap, tight, items).map((rect) => [rect.x, rect.y])).toEqual([[0, 0], [60, 0], [0, 58 + 4]]);
    expect(predictFlex(model({ wrap: true, gap: 10, crossGap: 4, alignContent: "start" }), tight, items).map((rect) => rect.y)).toEqual([0, 0, 44]);
    expect(predictFlex(model({ wrap: true, gap: 10, crossGap: 4, alignContent: "center" }), tight, items).map((rect) => rect.y)).toEqual([18, 18, 62]);
    expect(predictFlex(model({ wrap: true, gap: 10, crossGap: 4, alignContent: "space-between" }), tight, items).map((rect) => rect.y)).toEqual([0, 0, 80]);
    const centeredLines = predictFlex(model({ wrap: true, gap: 10, justify: "center", alignContent: "start", align: "center" }), tight, items);
    expect(centeredLines.map((rect) => [rect.x, rect.y])).toEqual([[5, 5], [65, 0], [30, 40]]);
  });

  it("mirrors each wrapped line of a reversed row", () => {
    const rects = predictFlex(model({ dir: "row-reverse", wrap: true, gap: 10, alignContent: "start" }), { width: 130, height: 100 }, items);
    expect(rects.map((rect) => [rect.x, rect.y])).toEqual([[80, 0], [10, 0], [60, 40]]);
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
    ["wrap-reverse", { wrap: "wrap-reverse" as const }],
    ["a wrapping reversed row", { wrap: "wrap" as const, direction: "row-reverse" as const }],
    ["baseline alignment", { alignItems: "baseline" }],
    ["unsupported justification", { justifyContent: "left" }],
    ["unsupported line placement", { wrap: "wrap" as const, alignContent: "baseline" }]
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

  it("accepts reversed and wrapping containers, reading start and end by the writing mode", () => {
    const reversed = container({ x: 0, y: 0, width: 200, height: 40 }, { direction: "row-reverse", justifyContent: "start" });
    // `start` is the left edge, which is the far end of a reversed row.
    expect(planFlex(reversed, [node({ x: 0, y: 0, width: 50, height: 20 })])).toMatchObject({ plan: { dir: "row-reverse", justify: "end" } });
    const flexStart = container({ x: 0, y: 0, width: 200, height: 40 }, { direction: "row-reverse", justifyContent: "flex-start" });
    expect(planFlex(flexStart, [node({ x: 150, y: 0, width: 50, height: 20 })])).toMatchObject({ plan: { justify: "start" } });
    const wrapping = container({ x: 0, y: 0, width: 130, height: 64 }, { wrap: "wrap", columnGap: 10, rowGap: 4, alignContent: "normal" });
    const decision = planFlex(wrapping, [node({ x: 0, y: 0, width: 50, height: 30 }), node({ x: 60, y: 0, width: 60, height: 40 }), node({ x: 0, y: 44, width: 70, height: 20 })]);
    expect(decision).toMatchObject({ plan: { wrap: true, gap: 10, crossGap: 4, alignContent: "stretch" } });
  });

  it("rejects wrapped lines that overflow a container which centers them", () => {
    const parent = container({ x: 0, y: 0, width: 60, height: 50 }, { wrap: "wrap", rowGap: 0, alignContent: "center" });
    const decision = planFlex(parent, [node({ x: 0, y: -5, width: 50, height: 30 }), node({ x: 0, y: 25, width: 50, height: 30 })]);
    expect(decision).toMatchObject({ reason: expect.stringContaining("lines overflow") });
  });

  it("lays out a text layer by its element box, with the glyph line inset as margins", () => {
    const parent = container({ x: 0, y: 0, width: 200, height: 60 }, { direction: "column", rowGap: 2 });
    const heading = node({ x: 0, y: 1, width: 80, height: 16 }, {}, { kind: "text", box: { x: 0, y: 0, width: 80, height: 19.6 } });
    const caption = node({ x: 0, y: 22.6, width: 40, height: 14 }, {}, { kind: "text", box: { x: 0, y: 21.6, width: 40, height: 16.8 } });
    const decision = planFlex(parent, [heading, caption]);
    expect(decision).toMatchObject({ plan: { margins: [[1, 0, 2.6, 0], [1, 0, 1.8, 0]] } });
    // Without the box, the glyph rects alone miss the model by the leading.
    expect(planFlex(parent, [{ ...heading, box: undefined }, { ...caption, box: undefined }])).toHaveProperty("reason");
    const overflowing = node({ x: 0, y: 0, width: 120, height: 16 }, {}, { kind: "text", box: { x: 0, y: 0, width: 60, height: 16 } });
    expect(planFlex(parent, [overflowing])).toMatchObject({ reason: expect.stringContaining("overflows its element") });
  });

  it("fills with growing items when the browser shared the space equally, and keeps them fixed otherwise", () => {
    const parent = container({ x: 0, y: 0, width: 300, height: 40 }, { columnGap: 10 });
    const fixed = node({ x: 0, y: 0, width: 50, height: 20 });
    const equal = [node({ x: 60, y: 0, width: 115, height: 20 }, { flexGrow: 1 }), node({ x: 185, y: 0, width: 115, height: 20 }, { flexGrow: 1 })];
    expect(planFlex(parent, [fixed, ...equal])).toMatchObject({ plan: { fill: [false, true, true] } });
    const unequal = [node({ x: 60, y: 0, width: 90, height: 20 }, { flexGrow: 1 }), node({ x: 160, y: 0, width: 140, height: 20 }, { flexGrow: 2 })];
    expect(planFlex(parent, [fixed, ...unequal])).toMatchObject({ plan: { fill: [false, false, false] } });
    const text = node({ x: 60, y: 0, width: 240, height: 20 }, { flexGrow: 1 }, { kind: "text" });
    expect(planFlex(parent, [fixed, text])).toMatchObject({ plan: { fill: [false, false] } });
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
