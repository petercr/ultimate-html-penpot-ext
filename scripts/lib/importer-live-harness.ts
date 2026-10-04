/** Local-only entry point; never included in a production plugin build. */
import { importScenes } from "../../src/importer/penpot";
import { profileNow, type ImportMetrics } from "../../src/shared/performance";
import { validateScenes } from "../../src/shared/validation";
import { assetScenes, singleBoardScene } from "./importer-workloads";

declare const LIVE_IMAGES: string[];

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
penpot.ui.open("Importer host validation", "?phase5-validation", { width: 480, height: 380 });

penpot.ui.onMessage<{ action: string; size?: number; pageId?: string; pageIds?: string[]; boardIds?: string[] }>(async (message) => {
  if (message.action === "cancel") { cancelled = true; return; }
  if (busy) return;
  busy = true;
  try {
    if (message.action === "run" || message.action === "assets") {
      const scenes = message.action === "assets" ? assetScenes(message.size!).map((scene) => ({ ...scene,
        assets: scene.assets.map((asset, index) => ({ id: asset.id, dataUrl: LIVE_IMAGES[index], mimeType: "image/png" })) }))
        : [singleBoardScene(message.size!)];
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
    } else if (message.action === "inspect") {
      const page = penpot.currentFile?.pages.find((candidate) => candidate.id === message.pageId);
      if (!page) throw new Error("Expected an existing page.");
      send({ type: "inspection", pageId: page.id, shapes: page.findShapes().length,
        topLevel: page.findShapes().filter((shape) => shape.parent?.id === page.root.id).map((shape) => ({ id: shape.id, name: shape.name, type: shape.type })),
        boards: page.findShapes({ type: "board" }).map((board) => ({ id: board.id, name: board.name, children: (board as import("@penpot/plugin-types").Board).children.length })) });
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
