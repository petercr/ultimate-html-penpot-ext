/** Local-only entry point; never included in a production plugin build. */
import { importScenes, rotatedBoundsOrigin } from "../../src/importer/penpot";
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

penpot.ui.onMessage<{ action: string; size?: number; pageId?: string; pageIds?: string[]; boardIds?: string[]; names?: string[] }>(async (message) => {
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
      const boards = await importScenes(scenes, { isCancelled: () => cancelled,
        onProgress: (completed, total, label) => send({ type: "progress", completed, total, label }),
        onDiagnostic: (value) => diagnostics.push(value),
        onMetrics: (value) => { metrics = value; }
      });
      result = { size: message.size, pageId: page.id, boardId: boards[0].id, boardChildren: boards[0].children.length,
        boards: boards.map((board) => ({ children: board.children.length, imageIds: board.children.flatMap((shape) => "fills" in shape ? ((shape as import("@penpot/plugin-types").Rectangle).fills || []).flatMap((fill) => fill.fillImage ? [fill.fillImage.id] : []) : []) })),
        shapes: page.findShapes().length, durationMs: profileNow() - started, saves,
        saveAcknowledged: (metrics?.saveWaitCount || 0) > 0, metrics, diagnostics };
      send({ type: "import-complete", result });
    } else if (message.action === "rotation-probe") {
      const page = penpot.createPage();
      page.name = `${pagePrefix}rotation probe`;
      await openPage(page);
      send({ type: "rotation-probe", pageId: page.id, result: rotationProbe() });
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
            source: shape.getPluginData("source"), borderSide: shape.getPluginData("border-side"), contentClip: shape.getPluginData("border-content-clip"), opacity: shape.opacity,
            fills: "fills" in shape ? shape.fills.map((fill) => ({ color: fill.fillColor, opacity: fill.fillOpacity, imageId: fill.fillImage?.id })) : [],
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
