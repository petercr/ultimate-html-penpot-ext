import { DEFAULT_VIEWPORTS, PROTOCOL_VERSION, SCENE_LIMITS, type SceneDocument, type SceneNode } from "../../src/shared/contracts";

/** Deterministic scenes for importer-only benchmarks, independent of capture. */
export function assetScenes(assetCount: number): SceneDocument[] {
  return DEFAULT_VIEWPORTS.map((viewport) => {
    const nodes: SceneNode[] = Array.from({ length: assetCount * 2 }, (_, index) => ({
      id: `image-${index}`, parentId: "root", children: [], kind: "image", name: `Image ${index}`, source: `#image-${index}`,
      rect: { x: index % 10 * 100, y: Math.floor(index / 10) * 100, width: 80, height: 80 },
      zIndex: index % 5, paint: {}, layout: { kind: "none", positioned: true }, assetId: `asset-${index % assetCount}`
    }));
    return {
      protocolVersion: PROTOCOL_VERSION, viewport, documentSize: { width: viewport.width, height: Math.max(900, Math.ceil(nodes.length / 10) * 100) }, diagnostics: [],
      nodes: [{ id: "root", children: nodes.map((node) => node.id), kind: "container", name: "body", source: "body", rect: { x: 0, y: 0, width: viewport.width, height: 900 }, zIndex: 0, paint: {}, layout: { kind: "none" } }, ...nodes],
      assets: Array.from({ length: assetCount }, (_, index) => ({ id: `asset-${index}`, url: `https://fixture.invalid/image-${index}.png`, mimeType: "image/png" }))
    };
  });
}

export function singleBoardScene(nodeCount: number): SceneDocument {
  if (!Number.isInteger(nodeCount) || nodeCount < 2 || nodeCount > SCENE_LIMITS.maxLayers) throw new Error("Invalid single-board workload size.");
  const viewport = DEFAULT_VIEWPORTS[0];
  const height = Math.max(viewport.height, Math.ceil((nodeCount - 1) / 40) * 24);
  const nodes: SceneNode[] = Array.from({ length: nodeCount - 1 }, (_, index) => ({
    id: `tile-${index}`, parentId: "root", children: [], kind: "box", name: `Tile ${index}`, source: `#tile-${index}`,
    rect: { x: index % 40 * 32, y: Math.floor(index / 40) * 24, width: 28, height: 20 }, zIndex: 0,
    paint: { backgroundColor: index % 2 ? "#2563eb" : "#16a34a", radius: [2, 2, 2, 2] }, layout: { kind: "none" }
  }));
  return { protocolVersion: PROTOCOL_VERSION, viewport, documentSize: { width: viewport.width, height }, diagnostics: [], assets: [],
    nodes: [{ id: "root", children: nodes.map((node) => node.id), kind: "container", name: "body", source: "body", rect: { x: 0, y: 0, width: viewport.width, height }, zIndex: 0, paint: { backgroundColor: "#ffffff" }, layout: { kind: "none" } }, ...nodes] };
}

/** Rotated layers whose fills arrive through an asynchronous upload: an image, a background image, and a plain control. */
export function rotatedAssetScene(): SceneDocument {
  const viewport = DEFAULT_VIEWPORTS[0];
  const nodes: SceneNode[] = [
    { id: "image", parentId: "root", children: [], kind: "image", name: "Rotated image", source: "#image", rect: { x: 100, y: 100, width: 160, height: 100 }, rotation: 25, zIndex: 0, paint: {}, layout: { kind: "none" }, assetId: "asset-0" },
    { id: "background", parentId: "root", children: [], kind: "box", name: "Rotated background", source: "#background", rect: { x: 400, y: 100, width: 180, height: 120 }, rotation: -15, zIndex: 0,
      paint: { backgroundImage: 'url("https://fixture.invalid/image-1.png")', backgroundSize: "cover", backgroundRepeat: "no-repeat" }, layout: { kind: "none" }, assetId: "asset-1" },
    { id: "control", parentId: "root", children: [], kind: "box", name: "Rotated control", source: "#control", rect: { x: 700, y: 100, width: 160, height: 100 }, rotation: 40, zIndex: 0, paint: { backgroundColor: "#2563eb" }, layout: { kind: "none" } }
  ];
  return { protocolVersion: PROTOCOL_VERSION, viewport, documentSize: { width: viewport.width, height: 400 }, diagnostics: [],
    nodes: [{ id: "root", children: nodes.map((node) => node.id), kind: "container", name: "body", source: "body", rect: { x: 0, y: 0, width: viewport.width, height: 400 }, zIndex: 0, paint: { backgroundColor: "#ffffff" }, layout: { kind: "none" } }, ...nodes],
    assets: [0, 1].map((index) => ({ id: `asset-${index}`, url: `https://fixture.invalid/image-${index}.png`, mimeType: "image/png" })) };
}
