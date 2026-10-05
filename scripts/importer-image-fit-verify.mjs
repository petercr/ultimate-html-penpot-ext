#!/usr/bin/env node
// Verify an existing live-host inspection without reading or changing the host.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";

const [statusPath] = process.argv.slice(2);
if (!statusPath || process.argv.length !== 3) throw new Error("Usage: node scripts/importer-image-fit-verify.mjs <status.json>");
const fixtureFile = "image-fit-position.html";
const positionTolerance = 0.005;
const rotationTolerance = 0.001;
const repository = new URL("../", import.meta.url);
const status = JSON.parse(await readFile(statusPath, "utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(`Image fit verification failed: ${message}`);
}

async function moduleUrl(path, dependencies = {}) {
  let source = await readFile(new URL(path, repository), "utf8");
  for (const [name, url] of Object.entries(dependencies)) {
    source = source.replaceAll(`from "${name}"`, `from "${url}"`);
  }
  const compiled = transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ESNext } }).outputText;
  return `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
}

const contractsUrl = await moduleUrl("src/shared/contracts.ts");
const [imageModule, svgModule] = await Promise.all([
  moduleUrl("src/shared/images.ts").then((url) => import(url)),
  moduleUrl("src/importer/svgImage.ts", { "../shared/contracts": contractsUrl }).then((url) => import(url))
]);
const { imageGeometry } = imageModule;
const { svgImageGeometry } = svgModule;

assert(Array.isArray(status.results), "status JSON must contain a results array.");
const completed = status.results.findLast((event) => event.type === "import-complete");
assert(completed?.result, "no import-complete result was recorded.");
const result = completed.result;
const inspected = status.results.findLast((event) => event.type === "inspection" && event.pageId === result.pageId);
assert(inspected, "the latest import has no inspection for its page; inspect it before capturing status.");
assert(Array.isArray(inspected.geometry), "inspection contains no shape geometry.");

const evidence = JSON.parse(await readFile(new URL("src/capture/fixtures/baselines/scene-evidence.json", repository), "utf8"));
const fixture = evidence.fixtures.find((candidate) => candidate.file === fixtureFile);
assert(fixture, `${fixtureFile} is absent from scene evidence.`);
assert(Number.isInteger(result.size) && result.size >= 0 && result.size < fixture.viewports.length, "import viewport index is invalid for the fixture.");
const scene = fixture.viewports[result.size].scene;
const nodes = new Map(scene.nodes.map((node) => [node.id, node]));
const assets = new Map(scene.assets.map((asset) => [asset.id, asset]));
const images = scene.nodes.filter((node) => node.kind === "image" && node.image);
assert(images.length === 16, `expected 16 fixture image nodes, found ${images.length}.`);
assert(result.metrics?.nodeCount === scene.nodes.length, "import node count differs from the selected fixture scene.");
assert(result.metrics?.completedNodes === scene.nodes.length && result.metrics?.outcome === "complete", "import did not complete every captured node.");
assert(result.shapes === inspected.shapes && inspected.geometry.length === inspected.shapes, "inspection shape count differs from the completed import.");

const shapes = new Map(inspected.geometry.map((shape) => [shape.id, shape]));
assert(shapes.size === inspected.geometry.length, "inspection contains duplicate shape records.");
const board = shapes.get(result.boardId);
assert(board?.type === "board", "the imported page board is missing.");
assert(Number.isFinite(board.x) && Number.isFinite(board.y), "the page board origin is invalid.");
assert(Math.abs(board.width - scene.viewport.width) <= positionTolerance && Math.abs(board.height - scene.documentSize.height) <= positionTolerance, "page board dimensions differ from the captured viewport.");
const origin = { x: board.x, y: board.y };
const counters = { borderFrames: 0, contentFrames: 0, objectFrames: 0, svgViewportFrames: 0, editableSvgGroups: 0, rasterRectangles: 0, checkedFrames: 0 };
const errors = { maxCornerErrorPx: 0, maxSizeErrorPx: 0, maxRotationErrorDeg: 0 };

function marked(node, marker) {
  const matches = inspected.geometry.filter((shape) => shape.source === node.source && shape[marker] === "true");
  assert(matches.length === 1, `${node.source}: expected one ${marker} shape, found ${matches.length}.`);
  return matches[0];
}

function expectedFrame(node, local) {
  const radians = (node.rotation ?? 0) * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: origin.x + node.rect.x + local.x * cos - local.y * sin,
    y: origin.y + node.rect.y + local.x * sin + local.y * cos,
    width: local.width, height: local.height, rotation: node.rotation ?? 0
  };
}

function compareFrame(actual, expected, label) {
  assert([actual.corner?.x, actual.corner?.y, actual.width, actual.height, actual.rotation ?? 0].every(Number.isFinite), `${label}: host geometry contains a non-finite value.`);
  const cornerError = Math.hypot(actual.corner.x - expected.x, actual.corner.y - expected.y);
  const widthError = Math.abs(actual.width - expected.width);
  const heightError = Math.abs(actual.height - expected.height);
  const rotationError = Math.abs((((actual.rotation ?? 0) - expected.rotation) % 360 + 540) % 360 - 180);
  errors.maxCornerErrorPx = Math.max(errors.maxCornerErrorPx, cornerError);
  errors.maxSizeErrorPx = Math.max(errors.maxSizeErrorPx, widthError, heightError);
  errors.maxRotationErrorDeg = Math.max(errors.maxRotationErrorDeg, rotationError);
  assert(cornerError <= positionTolerance, `${label}: corner differs by ${cornerError.toFixed(6)}px (allowed ${positionTolerance}px).`);
  assert(widthError <= positionTolerance && heightError <= positionTolerance, `${label}: size differs by ${widthError.toFixed(6)}×${heightError.toFixed(6)}px.`);
  assert(rotationError <= rotationTolerance, `${label}: rotation differs by ${rotationError.toFixed(6)}° (allowed ${rotationTolerance}°).`);
  counters.checkedFrames += 1;
}

function parentIs(shape, parent, label) {
  assert(shape.parentId === parent.id, `${label}: unexpected parent layer.`);
}

function opacityIs(shape, expected, label) {
  const opacity = shape.opacity ?? 1;
  assert(Number.isFinite(opacity) && Math.abs(opacity - expected) <= 0.000001, `${label}: opacity is ${opacity}; expected ${expected}.`);
}

function collapsedWrapper(node) {
  const paint = node.paint;
  const transparent = !paint.backgroundColor || paint.backgroundColor === "transparent" || /^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(paint.backgroundColor);
  return node.kind === "container" && node.children.length === 1 && !node.assetId && transparent
    && (!paint.backgroundImage || paint.backgroundImage === "none")
    && !(paint.borderWidth > 0) && !Object.values(paint.borders ?? {}).some((border) => border.width > 0 && !["none", "hidden"].includes(border.style))
    && !paint.radius?.some((radius) => radius > 0) && (!paint.boxShadow || paint.boxShadow === "none")
    && (!paint.overflow || paint.overflow === "visible") && (paint.opacity ?? 1) === 1;
}

async function svgText(asset) {
  if (asset.dataUrl?.startsWith("data:image/svg+xml")) {
    const comma = asset.dataUrl.indexOf(",");
    const header = asset.dataUrl.slice(0, comma);
    const payload = asset.dataUrl.slice(comma + 1);
    return /;base64$/i.test(header) ? Buffer.from(payload, "base64").toString("utf8") : decodeURIComponent(payload);
  }
  assert(asset.url, "an SVG fixture asset has no source.");
  const name = basename(new URL(asset.url).pathname);
  assert(name.endsWith(".svg"), "SVG fixture asset does not map to a local SVG file.");
  return readFile(new URL(`src/capture/fixtures/assets/${name}`, repository), "utf8");
}

for (const node of images) {
  const label = node.source;
  const geometry = imageGeometry(node);
  assert(geometry && geometry.object.width > 0 && geometry.object.height > 0, `${label}: fixture has no fitted image geometry.`);
  const frame = marked(node, "imageClip");
  const content = marked(node, "imageContentClip");
  const image = marked(node, "imageContent");
  assert(frame.type === "board" && content.type === "board", `${label}: image border/content frames must be boards.`);
  assert(frame.clipContent === true && content.clipContent === true, `${label}: image border/content boards must clip their children.`);
  const parent = shapes.get(frame.parentId);
  let parentNode = nodes.get(node.parentId);
  // The importer reuses the sole child of an undecorated wrapper. In the
  // fixture this collapses the rotation stage while retaining image metadata.
  while (parentNode && collapsedWrapper(parentNode)) parentNode = nodes.get(parentNode.parentId);
  assert(parent && parentNode && parent.source === parentNode.source, `${label}: border frame is attached to an unexpected scene parent.`);
  parentIs(content, frame, `${label} content clip`);
  compareFrame(frame, expectedFrame(node, { x: 0, y: 0, width: node.rect.width, height: node.rect.height }), `${label} border frame`);
  compareFrame(content, expectedFrame(node, geometry.content), `${label} content frame`);
  opacityIs(frame, node.paint.opacity ?? 1, `${label} border frame`);
  opacityIs(content, 1, `${label} content frame`);
  opacityIs(image, 1, `${label} image`);
  assert(Array.isArray(content.fills) && content.fills.length === 0 && Array.isArray(content.strokes) && content.strokes.length === 0, `${label}: content clip paints extra decoration.`);
  counters.borderFrames += 1;
  counters.contentFrames += 1;

  const asset = assets.get(node.assetId);
  assert(asset, `${label}: fixture image asset is missing.`);
  const isSvg = asset.mimeType?.includes("svg") || /\.svg(?:[?#]|$)/i.test(asset.url ?? "") || asset.dataUrl?.startsWith("data:image/svg+xml");
  if (isSvg) {
    const viewport = marked(node, "imageSvgViewport");
    const vector = marked(node, "imageSvgVector");
    assert(vector.id === image.id && vector.type === "group", `${label}: SVG source was not retained as an editable group.`);
    assert(viewport.type === "board", `${label}: SVG object viewport must be a board.`);
    assert(viewport.clipContent === true, `${label}: SVG object viewport must clip its vector content.`);
    parentIs(viewport, content, `${label} SVG viewport`);
    parentIs(vector, viewport, `${label} editable SVG`);
    opacityIs(viewport, 1, `${label} SVG viewport`);
    assert(Array.isArray(viewport.fills) && viewport.fills.length === 0 && Array.isArray(viewport.strokes) && viewport.strokes.length === 0, `${label}: SVG viewport paints extra decoration.`);
    const mapped = svgImageGeometry(await svgText(asset), geometry.object, node.image.scale);
    assert(mapped, `${label}: source SVG geometry could not be resolved.`);
    compareFrame(viewport, expectedFrame(node, geometry.object), `${label} object frame`);
    compareFrame(vector, expectedFrame(node, mapped.rect), `${label} editable SVG frame`);
    assert(inspected.geometry.some((shape) => shape.parentId === vector.id && ["rectangle", "ellipse", "path"].includes(shape.type)), `${label}: editable SVG contains no vector geometry.`);
    assert(!(vector.fills ?? []).some((fill) => fill.imageId), `${label}: SVG group contains an image fill.`);
    counters.svgViewportFrames += 1;
    counters.editableSvgGroups += 1;
  } else {
    assert(image.type === "rectangle", `${label}: raster object must be an image-filled rectangle.`);
    parentIs(image, content, `${label} raster image`);
    compareFrame(image, expectedFrame(node, geometry.object), `${label} object frame`);
    const fills = image.fills?.filter((fill) => fill.imageId) ?? [];
    assert(fills.length === 1, `${label}: raster rectangle must have one uploaded image fill.`);
    assert(fills[0].keepAspectRatio === false, `${label}: native image fill applies a second aspect-ratio rule.`);
    assert(Math.abs((fills[0].opacity ?? 1) - 1) <= 0.000001, `${label}: raster fill duplicates element opacity.`);
    counters.rasterRectangles += 1;
  }
  counters.objectFrames += 1;
  if (node.source === "#rounded-image") {
    assert(Array.isArray(content.radii) && content.radii.length === 4 && content.radii.every((radius) => Math.abs(radius - 16) <= positionTolerance), "#rounded-image: content clip must retain four 16px inner radii.");
  }
}

for (const [marker, expected] of [["imageClip", 16], ["imageContentClip", 16], ["imageContent", 16], ["imageSvgViewport", 3], ["imageSvgVector", 3]]) {
  const actual = inspected.geometry.filter((shape) => shape[marker] === "true").length;
  assert(actual === expected, `expected ${expected} ${marker} layers, found ${actual}.`);
}
assert(counters.editableSvgGroups === 3 && counters.rasterRectangles === 13, "fixture must retain three editable SVG groups and thirteen raster rectangles.");
assert(result.metrics.uploadCount === 1, "fixture must upload its shared raster source once; editable SVGs need no media uploads.");
const diagnostics = (result.diagnostics ?? []).map(({ severity, code, source }) => ({ severity, code, source }));
assert(diagnostics.length === 0, `supported fixture produced diagnostics: ${diagnostics.map((diagnostic) => diagnostic.code).join(", ")}.`);
const roundedErrors = Object.fromEntries(Object.entries(errors).map(([name, value]) => [name, Number(value.toFixed(8))]));
console.log(JSON.stringify({
  viewport: scene.viewport.id, size: result.size, nodeCount: scene.nodes.length, shapeCount: inspected.shapes,
  ...counters, ...roundedErrors, uploads: result.metrics.uploadCount, diagnostics
}, null, 2));
