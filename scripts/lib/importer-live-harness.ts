/** Local-only entry point; never included in a production plugin build. */
import { importScenes, rotatedBoundsOrigin } from "../../src/importer/penpot";
import { matchesPrediction, predictFlex, type FlexItem, type FlexLayoutModel } from "../../src/importer/flexLayout";
import { profileNow, type ImportMetrics } from "../../src/shared/performance";
import type { SceneDocument } from "../../src/shared/contracts";
import { validateScenes } from "../../src/shared/validation";
import { assetScenes, rotatedAssetScene, singleBoardScene } from "./importer-workloads";

declare const LIVE_IMAGES: string[];
declare const FIXTURE_SCENES: SceneDocument[];

const pagePrefix = "Phase 5 validation — ";
const originalPageId = penpot.currentPage?.id;
let busy = false;
let cancelled = false;
let saveListener: symbol | undefined;
const send = (result: unknown) => penpot.ui.sendMessage(result);
async function openPage(page: import("@penpot/plugin-types").Page) {
  penpot.openPage(page);
  const deadline = Date.now() + 5000;
  while (penpot.currentPage?.id !== page.id) {
    if (Date.now() > deadline) throw new Error("The validation page did not become active.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
type Probe = Record<string, unknown>;
const round = (value: number) => Math.round(value * 100) / 100;
function describe(shape: import("@penpot/plugin-types").Shape): Probe {
  return { x: round(shape.x), y: round(shape.y), width: round(shape.width), height: round(shape.height), rotation: round(shape.rotation),
    center: { x: round(shape.center.x), y: round(shape.center.y) }, bounds: { x: round(shape.bounds.x), y: round(shape.bounds.y), width: round(shape.bounds.width), height: round(shape.bounds.height) } };
}
/** Records how the host reports rotated shapes so the importer's geometry contract rests on observations. */
function rotationProbe(): Probe {
  const out: Probe = {};
  const board = (x: number, y: number, width = 200, height = 100) => { const value = penpot.createBoard(); value.x = x; value.y = y; value.resize(width, height); return value; };
  const rect = (parent: import("@penpot/plugin-types").Board, x: number, y: number, width: number, height: number) => {
    const value = penpot.createRectangle(); parent.appendChild(value); value.x = x; value.y = y; value.resize(width, height); return value;
  };
  const a = board(100, 100); a.rotation = 30; out.rotatedBoard = describe(a);
  const r1 = rect(a, 120, 120, 50, 20); out.childAppendedToRotatedBoard = describe(r1);
  r1.rotation = 45; out.childRotatedInRotatedBoard = describe(r1);
  const b = board(500, 100); const r2 = rect(b, 640, 140, 40, 20); out.childBeforeParentRotation = describe(r2);
  b.rotation = 90; out.parentAfterRotation = describe(b); out.childAfterParentRotation = describe(r2);
  const host = board(100, 400, 600, 300); const r3 = rect(host, 100, 420, 100, 40); r3.rotation = 45; out.rotatedRect = describe(r3);
  r3.x = r3.x + 50; out.rotatedRectAfterXShift = describe(r3);
  r3.resize(60, 60); out.rotatedRectAfterResize = describe(r3);
  const r4 = rect(host, 300, 420, 100, 40); r4.resize(80, 30); r4.rotation = 30; r4.x = 350; r4.y = 500; out.rotatedRectPlacedAfter = describe(r4);
  const r5 = rect(host, 500, 420, 100, 40); r5.rotation = 30; r5.resize(80, 30); out.rotatedRectResizedAfter = describe(r5);
  out.hostId = host.id; out.boardIds = [a.id, b.id, host.id];
  return out;
}

/** Records how the host lays out children of a native flex board so the layout conversion rests on observations. */
async function flexProbe(): Promise<Probe> {
  type Board = import("@penpot/plugin-types").Board;
  const out: Probe = {};
  const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  let top = 100;
  const board = (width: number, height: number) => { const value = penpot.createBoard(); value.x = 100; value.y = top; value.resize(width, height); top += height + 60; return value; };
  const rect = (parent: Board, x: number, y: number, width: number, height: number) => {
    const value = penpot.createRectangle(); parent.appendChild(value); value.x = x; value.y = y; value.resize(width, height); return value;
  };
  const positions = (shapes: import("@penpot/plugin-types").Shape[]) => shapes.map((shape) => ({ x: round(shape.x), y: round(shape.y), width: round(shape.width), height: round(shape.height) }));
  const sizes = [[50, 30], [60, 40], [70, 20]];
  const make = (width: number, height: number) => {
    const host = board(width, height);
    const children = sizes.map(([w, h], index) => rect(host, 110 + index * 200, host.y + 10, w, h));
    return { host, children };
  };

  // 1. Order and spacing for a plain row, with and without padding, read at several delays.
  const variants: [string, (layout: import("@penpot/plugin-types").FlexLayout) => void][] = [
    ["gapOnly", (layout) => { layout.dir = "row"; layout.columnGap = 10; }],
    ["gapAndPadding", (layout) => { layout.dir = "row"; layout.columnGap = 10; layout.leftPadding = 8; layout.topPadding = 6; layout.rightPadding = 8; layout.bottomPadding = 6; }],
    ["paddingOnly", (layout) => { layout.leftPadding = 8; layout.topPadding = 6; }],
    ["nothingSet", () => undefined]
  ];
  for (const [name, configure] of variants) {
    const a = make(400, 100);
    const layout = a.host.addFlexLayout();
    configure(layout);
    const immediate = positions(a.children);
    await pause(100); const at100 = positions(a.children);
    await pause(900); const at1000 = positions(a.children);
    out[name] = { immediate, at100, at1000, hostChildOrder: a.host.children.map((c) => a.children.findIndex((child) => child.id === c.id)) };
  }

  // 2. Alignment and justification.
  const b = make(400, 100);
  const bl = b.host.addFlexLayout(); bl.dir = "row"; bl.columnGap = 0; bl.alignItems = "center"; bl.justifyContent = "space-between";
  await pause(300);
  out.centerSpaceBetween = { children: positions(b.children) };
  bl.alignItems = "end"; bl.justifyContent = "end"; await pause(300);
  out.endEnd = { children: positions(b.children) };

  // 3. Column direction.
  const c = make(300, 200);
  const cl = c.host.addFlexLayout(); cl.dir = "column"; cl.rowGap = 12; await pause(300);
  out.column = { children: positions(c.children) };

  // 4. Hug sizing resizes the board; fixed sizing keeps it.
  const d = make(400, 100);
  const dl = d.host.addFlexLayout(); dl.dir = "row"; dl.columnGap = 10; dl.horizontalSizing = "auto"; dl.verticalSizing = "auto"; await pause(300);
  out.hug = { host: describe(d.host), children: positions(d.children), horizontalSizing: dl.horizontalSizing };

  // 5. Child sizing: fill, and a margin.
  const e = make(400, 100);
  const el = e.host.addFlexLayout(); el.dir = "row"; el.columnGap = 10; await pause(100);
  e.children[1].layoutChild!.horizontalSizing = "fill"; e.children[0].layoutChild!.rightMargin = 20; await pause(300);
  out.fillAndMargin = { children: positions(e.children), childProps: e.children.map((child) => ({ h: child.layoutChild?.horizontalSizing, v: child.layoutChild?.verticalSizing, absolute: child.layoutChild?.absolute })) };

  // 6. An absolutely positioned child keeps its place and is excluded from flow.
  const f = make(400, 100);
  const fl = f.host.addFlexLayout(); fl.dir = "row"; fl.columnGap = 10; await pause(100);
  f.children[2].layoutChild!.absolute = true; f.children[2].x = f.host.x + 300; f.children[2].y = f.host.y + 60; await pause(300);
  out.absoluteChild = { children: positions(f.children) };

  // 7. Wrap.
  const g = make(100, 160);
  const gl = g.host.addFlexLayout(); gl.dir = "row"; gl.wrap = "wrap"; gl.columnGap = 6; gl.rowGap = 6; await pause(300);
  out.wrap = { children: positions(g.children) };

  // 8. Removing the layout leaves the children where the layout put them.
  const h = make(400, 100);
  const hl = h.host.addFlexLayout(); hl.dir = "row"; hl.columnGap = 10; await pause(300);
  const before = positions(h.children); hl.remove(); await pause(300);
  out.removedLayout = { before, after: positions(h.children), hasLayout: Boolean(h.host.flex) };
  // 9. Reversed directions: which end each justification starts from, and the order along it.
  const reversed: [string, number, number, (layout: import("@penpot/plugin-types").FlexLayout) => void][] = [
    ["rowReverseStart", 400, 100, (layout) => { layout.dir = "row-reverse"; layout.columnGap = 10; layout.justifyContent = "start"; }],
    ["rowReverseEnd", 400, 100, (layout) => { layout.dir = "row-reverse"; layout.columnGap = 10; layout.justifyContent = "end"; }],
    ["rowReversePadded", 400, 100, (layout) => { layout.dir = "row-reverse"; layout.columnGap = 10; layout.leftPadding = 8; layout.rightPadding = 20; }],
    ["columnReverseStart", 300, 200, (layout) => { layout.dir = "column-reverse"; layout.rowGap = 6; layout.justifyContent = "start"; }],
    ["rowReverseWrap", 130, 120, (layout) => { layout.dir = "row-reverse"; layout.wrap = "wrap"; layout.columnGap = 10; layout.rowGap = 4; layout.alignContent = "start"; }]
  ];
  const reversedHosts: Board[] = [];
  for (const [name, width, height, configure] of reversed) {
    const r = make(width, height);
    configure(r.host.addFlexLayout());
    await pause(400);
    reversedHosts.push(r.host);
    out[name] = { host: { x: round(r.host.x), y: round(r.host.y) }, children: positions(r.children) };
  }
  out.boardIds = [b, c, d, e, f, g, h].map((value) => value.host.id).concat(reversedHosts.map((host) => host.id));
  return out;
}

/** Edits an imported native-layout page the way a user would and records how the layout responds. */
async function flexEditProbe(pageId: string): Promise<Probe> {
  type Shape = import("@penpot/plugin-types").Shape;
  type Board = import("@penpot/plugin-types").Board;
  const page = penpot.currentFile?.pages.find((candidate) => candidate.id === pageId);
  if (!page) throw new Error("Expected an existing page.");
  const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const find = (source: string, type?: string) => page.findShapes().find((shape) => shape.getPluginData("source") === source && (!type || shape.type === type));
  const rel = (shape: Shape, board: Shape) => ({ x: round(shape.x - board.x), y: round(shape.y - board.y), w: round(shape.width), h: round(shape.height) });
  const kids = (board: Board) => board.children.slice().reverse().map((child) => ({ source: child.getPluginData("source"), ...rel(child, board) }));
  const out: Probe = {};

  const between = find("#between", "board") as Board;
  out.betweenBefore = kids(between);
  between.resize(360, between.height); await pause(500);
  out.betweenWidened = { width: round(between.width), children: kids(between) };

  const basic = find("#basic", "board") as Board;
  out.basicBefore = kids(basic);
  const second = basic.children.slice().reverse()[1];
  second.resize(100, second.height); await pause(500);
  out.basicAfterChildResize = kids(basic);
  const added = penpot.createRectangle(); added.resize(20, 20); basic.appendChild(added); await pause(500);
  out.basicAfterAppend = { children: kids(basic), addedLayoutChild: added.layoutChild ? { absolute: added.layoutChild.absolute } : null };

  const column = find("#column", "board") as Board;
  out.columnBefore = kids(column);
  const first = column.children.slice().reverse()[0];
  first.resize(first.width, 60); await pause(500);
  out.columnAfterChildResize = kids(column);

  const text = page.findShapes().find((shape) => shape.type === "text" && (shape as import("@penpot/plugin-types").Text).characters === "Ada Lovelace") as import("@penpot/plugin-types").Text | undefined;
  if (text) {
    const card = find("#card", "board") as Board;
    out.cardBefore = kids(card);
    text.characters = "Ada Lovelace, Countess of Lovelace"; await pause(800);
    out.cardAfterTextEdit = { text: { w: round(text.width), h: round(text.height), growType: text.growType }, children: kids(card) };
  }

  // Growing items fill the space a wider board adds; equal growers share it.
  for (const source of ["#grow", "#grow-equal"]) {
    const board = find(source, "board") as Board;
    const before = kids(board);
    board.resize(board.width + 60, board.height); await pause(500);
    out[`${source.slice(1)}Widened`] = { before, after: kids(board) };
  }
  // A narrower wrapping board moves items onto new lines.
  const wrapping = find("#wrapping", "board") as Board;
  const wrappingBefore = kids(wrapping);
  wrapping.resize(120, wrapping.height); await pause(500);
  out.wrappingNarrowed = { before: wrappingBefore, after: kids(wrapping) };
  // A layer appended to a reversed row; a taller first item in a reversed column.
  const reversedRow = find("#reversed", "board") as Board;
  const appended = penpot.createRectangle(); appended.resize(20, 20); reversedRow.appendChild(appended); await pause(500);
  out.reversedAfterAppend = kids(reversedRow);
  const reversedColumn = find("#column-reverse", "board") as Board;
  const reversedBefore = kids(reversedColumn);
  const bottom = reversedColumn.children.slice().reverse()[0];
  bottom.resize(bottom.width, bottom.height + 10); await pause(500);
  out.columnReverseAfterResize = { before: reversedBefore, after: kids(reversedColumn) };
  // Editing the caption of the text column keeps its margins and the heading in place.
  const caption = page.findShapes().find((shape) => shape.type === "text" && (shape as import("@penpot/plugin-types").Text).characters === "Analyst") as import("@penpot/plugin-types").Text | undefined;
  const textColumn = find("#card-text", "board") as Board | undefined;
  if (caption && textColumn) {
    const before = kids(textColumn);
    caption.characters = "Analyst and mathematician"; await pause(800);
    out.textColumnAfterEdit = { before, after: kids(textColumn), margins: textColumn.children.map((child) => [child.layoutChild?.topMargin, child.layoutChild?.bottomMargin]) };
  }
  return out;
}

type Placed = { x: number; y: number; width: number; height: number; native: boolean };
/** Shape geometry relative to its top-level board, grouped by viewport, source, and type. */
function sourceGeometry(page: import("@penpot/plugin-types").Page): Map<string, Placed[]> {
  const out = new Map<string, Placed[]>();
  for (const shape of page.findShapes()) {
    const source = shape.getPluginData("source");
    if (!source) continue;
    let top: import("@penpot/plugin-types").Shape = shape;
    while (top.parent && top.parent.id !== page.root.id) top = top.parent;
    const key = `${top.getPluginData("viewport")}|${source}|${shape.type}`;
    out.set(key, [...(out.get(key) || []), { x: shape.x - top.x, y: shape.y - top.y, width: shape.width, height: shape.height,
      native: shape.parent?.type === "board" && Boolean((shape.parent as import("@penpot/plugin-types").Board).flex) }]);
  }
  return out;
}

/** Compares a native-layout import with a snapshot import of the same scene, layer by layer. Layers that
 * share a source and type (border sides, text runs) are paired nearest first, since layer order may differ. */
function compareImports(snapshotPageId: string, nativePageId: string): Probe {
  const pages = penpot.currentFile?.pages || [];
  const snapshot = pages.find((page) => page.id === snapshotPageId), native = pages.find((page) => page.id === nativePageId);
  if (!snapshot || !native) throw new Error("Expected two existing pages.");
  const a = sourceGeometry(snapshot), b = sourceGeometry(native);
  const moved: { key: string; dx: number; dy: number; dw: number; dh: number; native: boolean }[] = [];
  const groups: typeof moved = [];
  const size = (entry: { dx: number; dy: number; dw: number; dh: number }) => Math.max(Math.abs(entry.dx), Math.abs(entry.dy), Math.abs(entry.dw), Math.abs(entry.dh));
  let compared = 0, inNative = 0, snapshotLayers = 0, nativeLayers = 0;
  for (const list of b.values()) nativeLayers += list.length;
  for (const [key, befores] of a) {
    snapshotLayers += befores.length;
    const afters = (b.get(key) || []).slice();
    const pairs = befores.flatMap((before, i) => afters.map((after, j) => {
      const delta = { dx: round(after.x - before.x), dy: round(after.y - before.y), dw: round(after.width - before.width), dh: round(after.height - before.height) };
      return { i, j, delta, distance: size(delta) };
    })).sort((x, y) => x.distance - y.distance);
    const usedA = new Set<number>(), usedB = new Set<number>();
    for (const pair of pairs) {
      if (usedA.has(pair.i) || usedB.has(pair.j)) continue;
      usedA.add(pair.i); usedB.add(pair.j);
      compared += 1;
      const after = afters[pair.j];
      if (after.native) inNative += 1;
      // A group draws nothing itself; its bounds follow whatever it encloses.
      if (pair.distance > 1) (key.endsWith("|group") ? groups : moved).push({ key, ...pair.delta, native: after.native });
    }
  }
  moved.sort((x, y) => size(y) - size(x));
  return { snapshotLayers, nativeLayers, compared, inNativeLayouts: inNative, movedOver1px: moved.length, movedInNativeLayouts: moved.filter((entry) => entry.native).length,
    movedOver3px: moved.filter((entry) => size(entry) > 3).length, groupBoundsChanged: groups.length, worst: moved.slice(0, 20) };
}

/** The supported flex model for a native board, read back from the host, with its in-flow children in layout order. */
function hostModel(board: import("@penpot/plugin-types").Board): { model: FlexLayoutModel; flow: import("@penpot/plugin-types").Shape[]; items: FlexItem[] } | undefined {
  const flex = board.flex;
  if (!flex || flex.dir.endsWith("-reverse")) return undefined;
  const row = flex.dir === "row";
  const justify = !flex.justifyContent || flex.justifyContent === "stretch" ? "start" : flex.justifyContent;
  const align = flex.alignItems === "stretch" ? "start" : flex.alignItems;
  const model: FlexLayoutModel = { dir: flex.dir, wrap: flex.wrap === "wrap", gap: row ? flex.columnGap : flex.rowGap, crossGap: row ? flex.rowGap : flex.columnGap,
    padding: [flex.topPadding, flex.rightPadding, flex.bottomPadding, flex.leftPadding], justify, align: align as FlexLayoutModel["align"], alignContent: (flex.alignContent ?? "stretch") as FlexLayoutModel["alignContent"] };
  const flow = board.children.slice().reverse().filter((child) => !child.layoutChild?.absolute);
  const items = flow.map((child): FlexItem => {
    const layout = child.layoutChild;
    return { width: child.width, height: child.height, margin: layout ? [layout.topMargin, layout.rightMargin, layout.bottomMargin, layout.leftMargin] : undefined,
      fill: (row ? layout?.horizontalSizing : layout?.verticalSizing) === "fill" };
  });
  return { model, flow, items };
}

/** Grows every native board along its main axis and checks its children reflow as the flex model predicts, then restores the sizes. */
async function reflowProbe(pageId: string, amount: number): Promise<Probe> {
  type Board = import("@penpot/plugin-types").Board;
  const page = penpot.currentFile?.pages.find((candidate) => candidate.id === pageId);
  if (!page) throw new Error("Expected an existing page.");
  const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const boards = page.findShapes({ type: "board" }).filter((shape) => shape.getPluginData("native-layout") === "flex") as Board[];
  const check = (label: string) => {
    const failures: Probe[] = [];
    let checked = 0, matched = 0;
    for (const board of boards) {
      const host = hostModel(board);
      if (!host) continue;
      checked += 1;
      const actual = host.flow.map((child) => ({ x: child.x - board.x, y: child.y - board.y, width: child.width, height: child.height }));
      const expected = predictFlex(host.model, { width: board.width, height: board.height }, host.items);
      if (matchesPrediction(actual, expected)) matched += 1;
      else if (failures.length < 8) failures.push({ source: board.getPluginData("source"), dir: host.model.dir, justify: host.model.justify, wrap: host.model.wrap, size: [round(board.width), round(board.height)],
        actual: actual.map((rect) => [round(rect.x), round(rect.y), round(rect.width), round(rect.height)]), expected: expected.map((rect) => [round(rect.x), round(rect.y), round(rect.width), round(rect.height)]) });
    }
    return { label, checked, matched, failures };
  };
  const before = check("imported");
  const sizes = new Map(boards.map((board) => [board, { width: board.width, height: board.height }]));
  let moved = 0;
  const positions = new Map(boards.map((board) => [board, board.children.map((child) => [child.x - board.x, child.y - board.y, child.width, child.height].join())]));
  for (const board of boards) {
    const row = board.flex?.dir.startsWith("row");
    board.resize(board.width + (row ? amount : 0), board.height + (row ? 0 : amount));
  }
  await pause(1500);
  const grown = check(`grown ${amount}px`);
  for (const board of boards) if (board.children.map((child) => [child.x - board.x, child.y - board.y, child.width, child.height].join()).join() !== positions.get(board)!.join()) moved += 1;
  for (const board of boards) { const size = sizes.get(board)!; board.resize(size.width, size.height); }
  await pause(1500);
  const restored = check("restored");
  return { boards: boards.length, before, grown, childrenMovedWhenGrown: moved, restored };
}

/** Second pass: the primitives a flat per-node transform model depends on. */
async function pivotProbe(): Promise<Probe> {
  const out: Probe = {};
  const host = penpot.createBoard(); host.x = 100; host.y = 100; host.resize(900, 600);
  const rect = (x: number, y: number, width: number, height: number) => {
    const value = penpot.createRectangle(); host.appendChild(value); value.x = x; value.y = y; value.resize(width, height); return value;
  };
  const a = rect(150, 150, 100, 40); a.rotate(30, { x: 150, y: 150 }); out.rotateAboutTopLeft = describe(a);
  const fractional = rect(300.37, 150.62, 100, 40); fractional.rotate(30, { x: 300.37, y: 150.62 }); out.rotateAboutTopLeftFractional = describe(fractional);
  const setter = rect(450.37, 150.62, 100, 40); setter.rotation = 30; out.rotationSetterFractional = describe(setter);
  setter.x = 460.37; setter.y = 160.62; out.fractionalPositionAfterRotation = describe(setter);
  const g1 = rect(150, 300, 80, 40); const g2 = rect(260, 300, 80, 40);
  const group = penpot.group([g1, g2]); if (!group) throw new Error("group failed");
  out.groupBefore = describe(group);
  g1.rotate(45, { x: 150, y: 300 }); out.memberAfterRotate = describe(g1); out.groupAfterMemberRotate = describe(group);
  const inner = penpot.createBoard(); host.appendChild(inner); inner.x = 700; inner.y = 150; inner.resize(150, 100); inner.clipContent = true;
  inner.rotate(15, { x: 700, y: 150 }); out.rotatedClipBoard = describe(inner);
  const child = penpot.createRectangle(); inner.appendChild(child); child.x = 720; child.y = 170; child.resize(60, 30);
  out.childOfRotatedClipBoard = describe(child);
  child.rotate(15, { x: 720, y: 170 }); out.childRotatedToMatchParent = describe(child);
  out.hostId = host.id;
  return out;
}

/** Shapes rotated well after creation, as uploads and conversions delay some layers. Text is left out on purpose:
 * rotating a laid-out text layer stalls the host tab (see docs/importer-transforms.md). Each shape is read back
 * right after the rotation, once the host has settled, and after the importer's position write, next to a control
 * rotated at creation. `mode` 2 skips the immediate read. */
async function lateRotationProbe(mode: number): Promise<Probe> {
  const out: Probe = {};
  const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const host = penpot.createBoard(); host.x = 100; host.y = 100; host.resize(900, 600);
  const rect = (x: number, y: number) => {
    const value = penpot.createRectangle(); host.appendChild(value); value.x = x; value.y = y; value.resize(262, 36); return value;
  };
  const control = rect(150, 150); if (mode === 1) control.rotation = 20; out.controlImmediate = describe(control);
  const late = rect(150, 250);
  const method = rect(150, 350);
  const svg = penpot.createShapeFromSvg('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#c33"/><circle cx="30" cy="30" r="20" fill="#fff"/></svg>');
  if (!svg) throw new Error("svg failed");
  host.appendChild(svg); svg.x = 500; svg.y = 150;
  const clip = penpot.createBoard(); host.appendChild(clip); clip.x = 150; clip.y = 450; clip.resize(262, 100); clip.clipContent = true;
  const shapes = { rect: late, svgGroup: svg, clipBoard: clip };
  await pause(1200);
  late.rotation = 20; svg.rotation = 20; clip.rotation = 20; method.rotate(20);
  if (mode !== 2) out.lateImmediate = { rect: describe(late), svgGroup: describe(svg), clipBoard: describe(clip), rotateMethod: describe(method) };
  await pause(3000);
  out.lateSettled = { rect: describe(late), svgGroup: describe(svg), clipBoard: describe(clip), rotateMethod: describe(method) };
  // The importer writes the position of the rotated bounding box after rotating.
  for (const shape of [...Object.values(shapes), method]) {
    const origin = rotatedBoundsOrigin({ x: shape.x, y: shape.y }, shape.width, shape.height, 0);
    shape.x = origin.x + 7; shape.y = origin.y + 11;
  }
  await pause(500);
  out.afterPositionWrite = { rect: describe(late), svgGroup: describe(svg), clipBoard: describe(clip), rotateMethod: describe(method) };
  out.controlSettled = describe(control);
  out.hostId = host.id;
  return out;
}

/** How long after creation can a rectangle still be rotated and then placed the way the importer does it? */
async function delaySweepProbe(): Promise<Probe> {
  const out: Probe = {};
  const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const host = penpot.createBoard(); host.x = 100; host.y = 100; host.resize(1000, 800);
  const rows: Probe[] = [];
  for (const [index, delay] of [0, 25, 50, 100, 200, 400, 800, 1600].entries()) {
    const value = penpot.createRectangle(); host.appendChild(value);
    const corner = { x: 150, y: 120 + index * 80 };
    value.x = corner.x; value.y = corner.y; value.resize(200, 40);
    if (delay) await pause(delay);
    value.rotation = 20;
    const want = rotatedBoundsOrigin(corner, 200, 40, 20);
    value.x = want.x; value.y = want.y;
    await pause(300);
    rows.push({ delay, want: { x: round(want.x), y: round(want.y) }, ...describe(value) });
  }
  out.rows = rows; out.hostId = host.id;
  return out;
}

penpot.ui.open("Importer host validation", "?phase5-validation", { width: 480, height: 380 });

penpot.ui.onMessage<{ action: string; native?: boolean; size?: number; pageId?: string; pageIds?: string[]; boardIds?: string[]; names?: string[] }>(async (message) => {
  if (message.action === "cancel") { cancelled = true; return; }
  if (busy) return;
  busy = true;
  try {
    if (message.action === "run" || message.action === "assets" || message.action === "fixture" || message.action === "rotated-image") {
      const fixture = FIXTURE_SCENES[message.size ?? 0];
      if (message.action === "fixture" && !fixture) throw new Error("No fixture scene is embedded for that viewport.");
      const withImages = (scene: SceneDocument): SceneDocument => ({ ...scene,
        assets: scene.assets.map((asset, index) => ({ id: asset.id, dataUrl: LIVE_IMAGES[index], mimeType: "image/png" })) });
      const scenes = message.action === "fixture" ? [fixture] : message.action === "rotated-image" ? [withImages(rotatedAssetScene())]
        : message.action === "assets" ? assetScenes(message.size!).map(withImages) : [singleBoardScene(message.size!)];
      validateScenes(scenes);
      cancelled = false;
      const page = penpot.createPage();
      page.name = `${pagePrefix}${message.action} ${message.size}`;
      await openPage(page);
      if (saveListener) penpot.off(saveListener);
      let result: unknown;
      let saves = 0;
      saveListener = penpot.on("contentsave", () => { saves += 1; send({ type: "save-observed", pageId: page.id, saves, result }); });
      const started = profileNow();
      let metrics: ImportMetrics | undefined;
      const diagnostics: unknown[] = [];
      const boards = await importScenes(scenes, { nativeLayout: message.native === true, isCancelled: () => cancelled,
        onProgress: (completed, total, label) => send({ type: "progress", completed, total, label }),
        onDiagnostic: (value) => diagnostics.push(value),
        onMetrics: (value) => { metrics = value; }
      });
      result = { size: message.size, pageId: page.id, boardId: boards[0].id, boardChildren: boards[0].children.length,
        boards: boards.map((board) => ({ children: board.children.length, imageIds: board.children.flatMap((shape) => "fills" in shape ? ((shape as import("@penpot/plugin-types").Rectangle).fills || []).flatMap((fill) => fill.fillImage ? [fill.fillImage.id] : []) : []) })),
        fontAvailability: (() => { const font = penpot.fonts.findByName("DejaVu Sans"); return { family: "DejaVu Sans", available: Boolean(font), variants: font?.variants.map((variant) => ({ weight: variant.fontWeight, style: variant.fontStyle })) ?? [] }; })(),
        shapes: page.findShapes().length, durationMs: profileNow() - started, saves,
        saveAcknowledged: (metrics?.saveWaitCount || 0) > 0, metrics, diagnostics };
      send({ type: "import-complete", result });
    } else if (message.action === "rotation-probe") {
      const page = penpot.createPage();
      page.name = `${pagePrefix}rotation probe`;
      await openPage(page);
      send({ type: "rotation-probe", pageId: page.id, result: rotationProbe() });
    } else if (message.action === "flex-probe") {
      const page = penpot.createPage();
      page.name = `${pagePrefix}flex probe`;
      await openPage(page);
      send({ type: "flex-probe", pageId: page.id, result: await flexProbe() });
    } else if (message.action === "compare") {
      send({ type: "comparison", result: compareImports(message.pageIds![0], message.pageIds![1]) });
    } else if (message.action === "reflow-probe") {
      send({ type: "reflow-probe", pageId: message.pageId, result: await reflowProbe(message.pageId!, message.size ?? 40) });
    } else if (message.action === "flex-edit-probe") {
      send({ type: "flex-edit-probe", pageId: message.pageId, result: await flexEditProbe(message.pageId!) });
    } else if (message.action === "pivot-probe") {
      const page = penpot.createPage();
      page.name = `${pagePrefix}pivot probe`;
      await openPage(page);
      send({ type: "pivot-probe", pageId: page.id, result: await pivotProbe() });
    } else if (message.action === "late-rotation-probe") {
      const page = penpot.createPage();
      page.name = `${pagePrefix}late rotation probe`;
      await openPage(page);
      send({ type: "late-rotation-probe", pageId: page.id, result: await lateRotationProbe(message.size ?? 1) });
    } else if (message.action === "delay-probe") {
      const page = penpot.createPage();
      page.name = `${pagePrefix}delay probe`;
      await openPage(page);
      send({ type: "delay-probe", pageId: page.id, result: await delaySweepProbe() });
    } else if (message.action === "inspect") {
      const page = penpot.currentFile?.pages.find((candidate) => candidate.id === message.pageId);
      if (!page) throw new Error("Expected an existing page.");
      send({ type: "inspection", pageId: page.id, shapes: page.findShapes().length,
        topLevel: page.findShapes().filter((shape) => shape.parent?.id === page.root.id).map((shape) => ({ id: shape.id, name: shape.name, type: shape.type })),
        boards: page.findShapes({ type: "board" }).map((board) => ({ id: board.id, name: board.name, children: (board as import("@penpot/plugin-types").Board).children.length })),
        // Position, unrotated size, and the page position of the rotated top-left corner for every shape.
        geometry: page.findShapes().map((shape) => {
          const radians = (shape.rotation || 0) * Math.PI / 180;
          const cos = Math.cos(radians), sin = Math.sin(radians);
          const boundsWidth = Math.abs(shape.width * cos) + Math.abs(shape.height * sin), boundsHeight = Math.abs(shape.width * sin) + Math.abs(shape.height * cos);
          const centerX = shape.x + boundsWidth / 2, centerY = shape.y + boundsHeight / 2;
          return { id: shape.id, name: shape.name, type: shape.type, parentId: shape.parent?.id, x: shape.x, y: shape.y, width: shape.width, height: shape.height, rotation: shape.rotation,
            clipContent: shape.type === "board" ? (shape as import("@penpot/plugin-types").Board).clipContent : undefined,
            source: shape.getPluginData("source"), nativeLayout: shape.getPluginData("native-layout"),
            flex: shape.type === "board" && (shape as import("@penpot/plugin-types").Board).flex ? (() => { const f = (shape as import("@penpot/plugin-types").Board).flex!; return { dir: f.dir, wrap: f.wrap, alignContent: f.alignContent, rowGap: f.rowGap, columnGap: f.columnGap, padding: [f.topPadding, f.rightPadding, f.bottomPadding, f.leftPadding], justifyContent: f.justifyContent, alignItems: f.alignItems, horizontalSizing: f.horizontalSizing, verticalSizing: f.verticalSizing }; })() : undefined,
            layoutChild: shape.layoutChild ? { absolute: shape.layoutChild.absolute, horizontalSizing: shape.layoutChild.horizontalSizing, verticalSizing: shape.layoutChild.verticalSizing, margins: [shape.layoutChild.topMargin, shape.layoutChild.rightMargin, shape.layoutChild.bottomMargin, shape.layoutChild.leftMargin] } : undefined, borderSide: shape.getPluginData("border-side"), contentClip: shape.getPluginData("border-content-clip"), imageClip: shape.getPluginData("image-clip"), imageContentClip: shape.getPluginData("image-content-clip"), imageContent: shape.getPluginData("image-content"), imageSvgViewport: shape.getPluginData("image-svg-viewport"), imageSvgVector: shape.getPluginData("image-svg-vector"), opacity: shape.opacity,
            fills: "fills" in shape ? shape.fills.map((fill) => ({ color: fill.fillColor, opacity: fill.fillOpacity, imageId: fill.fillImage?.id, keepAspectRatio: fill.fillImage?.keepAspectRatio })) : [],
            radii: "borderRadiusTopLeft" in shape ? [shape.borderRadiusTopLeft, shape.borderRadiusTopRight, shape.borderRadiusBottomRight, shape.borderRadiusBottomLeft] : undefined,
            strokes: shape.strokes, d: shape.type === "path" ? shape.d : undefined,
            corner: { x: centerX + (-shape.width / 2) * cos - (-shape.height / 2) * sin, y: centerY + (-shape.width / 2) * sin + (-shape.height / 2) * cos } };
        }) });
    } else if (message.action === "focus") {
      const page = penpot.currentFile?.pages.find((candidate) => candidate.id === message.pageId);
      if (!page) throw new Error("Expected an existing page.");
      await openPage(page);
      const shapes = page.findShapes().filter((shape) => (message.names || []).includes(shape.name));
      if (shapes.length) penpot.viewport.zoomIntoView(shapes);
      send({ type: "focused", count: shapes.length });
    } else if (message.action === "list-pages") {
      send({ type: "pages", pages: penpot.currentFile?.pages.map((page) => ({ id: page.id, name: page.name, shapes: page.findShapes().length })), currentPageId: penpot.currentPage?.id });
    } else if (message.action === "remove-boards") {
      const page = penpot.currentFile?.pages.find((candidate) => candidate.id === message.pageId);
      if (!page) throw new Error("Expected an existing page.");
      await openPage(page);
      for (const id of message.boardIds || []) {
        const board = page.getShapeById(id);
        if (!board || board.type !== "board" || board.getPluginData("importer") !== "ultimate-html-to-penpot") throw new Error("Expected an imported validation board.");
        board.remove();
      }
      send({ type: "boards-removed" });
    } else if (message.action === "cleanup") {
      if (saveListener) penpot.off(saveListener);
      saveListener = undefined;
      const pages = penpot.currentFile?.pages || [];
      const original = pages.find((page) => page.id === (message.pageId || originalPageId));
      for (const id of message.pageIds || []) {
        const page = pages.find((candidate) => candidate.id === id);
        if (!page || !page.name.startsWith(pagePrefix)) throw new Error("Refusing to remove a page outside this validation run.");
        await openPage(page);
        for (const board of page.findShapes({ type: "board" }).filter((shape) => shape.id !== page.root.id)) board.remove();
      }
      if (original) await openPage(original);
      send({ type: "cleaned-up" });
    }
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  } finally { busy = false; }
});
