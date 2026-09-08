import { PROTOCOL_VERSION, SCENE_LIMITS, type AssetRef, type SceneDocument, type SceneNode } from "./contracts";

function fail(message: string): never {
  throw new Error(`Invalid import scene: ${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, maximum = Number.POSITIVE_INFINITY): string {
  if (typeof value !== "string" || value.length > maximum) fail(`${label} must be a string no longer than ${maximum} characters.`);
  return value;
}

function number(value: unknown, label: string, minimum = -Number.MAX_VALUE): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) fail(`${label} must be a finite number.`);
  return value;
}

function array(value: unknown, label: string, maximum: number = SCENE_LIMITS.maxLayers): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail(`${label} must be an array with at most ${maximum} entries.`);
  return value;
}

function optionalString(value: unknown, label: string, maximum = Number.POSITIVE_INFINITY): void {
  if (value !== undefined) string(value, label, maximum);
}

function optionalNumber(value: unknown, label: string, minimum = -Number.MAX_VALUE, maximum = Number.MAX_VALUE): void {
  if (value === undefined) return;
  const parsed = number(value, label, minimum);
  if (parsed > maximum) fail(`${label} must be no greater than ${maximum}.`);
}

function optionalBoolean(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "boolean") fail(`${label} must be a boolean.`);
}

function enumValue(value: unknown, label: string, values: readonly string[]): void {
  if (value !== undefined && (typeof value !== "string" || !values.includes(value))) {
    fail(`${label} must be one of ${values.join(", ")}.`);
  }
}

function tuple(value: unknown, label: string, minimum = -Number.MAX_VALUE): void {
  if (!Array.isArray(value) || value.length !== 4) fail(`${label} must contain exactly four numbers.`);
  value.forEach((part, index) => number(part, `${label}[${index}]`, minimum));
}

// Penpot's plugin compartment does not expose a constructible TextEncoder.
// Count the UTF-8 representation directly so the safety limit is preserved
// without relying on a host-provided global.
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function validateNode(value: unknown, index: number): asserts value is SceneNode {
  const node = record(value, `nodes[${index}]`);
  string(node.id, `nodes[${index}].id`, 200);
  if (node.parentId !== undefined) string(node.parentId, `nodes[${index}].parentId`, 200);
  array(node.children, `nodes[${index}].children`).forEach((child, childIndex) => string(child, `nodes[${index}].children[${childIndex}]`, 200));
  if (!["container", "box", "text", "image", "svg", "fallback"].includes(string(node.kind, `nodes[${index}].kind`, 30))) fail(`nodes[${index}].kind is unsupported.`);
  string(node.name, `nodes[${index}].name`, 200);
  string(node.source, `nodes[${index}].source`, 2_000);
  const rect = record(node.rect, `nodes[${index}].rect`);
  const x = number(rect.x, `nodes[${index}].rect.x`);
  if (Math.abs(x) > SCENE_LIMITS.maxDimension) fail(`nodes[${index}].rect.x must be within ±${SCENE_LIMITS.maxDimension}.`);
  const y = number(rect.y, `nodes[${index}].rect.y`);
  if (Math.abs(y) > SCENE_LIMITS.maxDimension) fail(`nodes[${index}].rect.y must be within ±${SCENE_LIMITS.maxDimension}.`);
  const width = number(rect.width, `nodes[${index}].rect.width`, 0);
  if (width > SCENE_LIMITS.maxDimension) fail(`nodes[${index}].rect.width must be no greater than ${SCENE_LIMITS.maxDimension}.`);
  const height = number(rect.height, `nodes[${index}].rect.height`, 0);
  if (height > SCENE_LIMITS.maxDimension) fail(`nodes[${index}].rect.height must be no greater than ${SCENE_LIMITS.maxDimension}.`);
  number(node.zIndex, `nodes[${index}].zIndex`);
  validatePaint(node.paint, index);
  validateLayout(node.layout, index);
  if (node.text !== undefined) string(node.text, `nodes[${index}].text`, 100_000);
  if (node.textNoWrap !== undefined && typeof node.textNoWrap !== "boolean") fail(`nodes[${index}].textNoWrap must be a boolean.`);
  if (node.textFitScale !== undefined) {
    const scale = number(node.textFitScale, `nodes[${index}].textFitScale`, 0.01);
    if (scale > 1) fail(`nodes[${index}].textFitScale must be no greater than 1.`);
  }
  if (node.textMaxWidth !== undefined) number(node.textMaxWidth, `nodes[${index}].textMaxWidth`, 0.1);
  if (node.textStyle !== undefined) validateTextStyle(node.textStyle, index);
  if (node.assetId !== undefined) string(node.assetId, `nodes[${index}].assetId`, 200);
  if (node.fallbackReason !== undefined) string(node.fallbackReason, `nodes[${index}].fallbackReason`, 1_000);
}

function validatePaint(value: unknown, index: number): void {
  const paint = record(value, `nodes[${index}].paint`);
  optionalString(paint.backgroundColor, `nodes[${index}].paint.backgroundColor`, 200);
  optionalString(paint.backgroundImage, `nodes[${index}].paint.backgroundImage`, 2_000_000);
  // Background placement arrived on main while this validation was in review.
  // These feed asset materialization, so they are bounded like other paint
  // strings rather than reaching the importer unchecked.
  for (const field of ["backgroundRepeat", "backgroundRepeatX", "backgroundRepeatY", "backgroundSize", "backgroundPosition", "backgroundPositionX", "backgroundPositionY"] as const) {
    optionalString(paint[field], `nodes[${index}].paint.${field}`, 500);
  }
  optionalString(paint.color, `nodes[${index}].paint.color`, 200);
  optionalString(paint.borderColor, `nodes[${index}].paint.borderColor`, 200);
  optionalNumber(paint.borderWidth, `nodes[${index}].paint.borderWidth`, 0, SCENE_LIMITS.maxDimension);
  optionalString(paint.borderStyle, `nodes[${index}].paint.borderStyle`, 50);
  if (paint.radius !== undefined) tuple(paint.radius, `nodes[${index}].paint.radius`, 0);
  optionalNumber(paint.opacity, `nodes[${index}].paint.opacity`, 0, 1);
  optionalString(paint.boxShadow, `nodes[${index}].paint.boxShadow`, 2_000);
  enumValue(paint.overflow, `nodes[${index}].paint.overflow`, ["visible", "hidden", "clip"]);
  optionalString(paint.transform, `nodes[${index}].paint.transform`, 500);
}

function validateLayout(value: unknown, index: number): void {
  const layout = record(value, `nodes[${index}].layout`);
  enumValue(string(layout.kind, `nodes[${index}].layout.kind`, 20), `nodes[${index}].layout.kind`, ["none", "flex", "grid"]);
  enumValue(layout.direction, `nodes[${index}].layout.direction`, ["row", "row-reverse", "column", "column-reverse"]);
  enumValue(layout.wrap, `nodes[${index}].layout.wrap`, ["wrap", "nowrap"]);
  optionalString(layout.justifyContent, `nodes[${index}].layout.justifyContent`, 100);
  optionalString(layout.alignItems, `nodes[${index}].layout.alignItems`, 100);
  optionalNumber(layout.rowGap, `nodes[${index}].layout.rowGap`, 0, SCENE_LIMITS.maxDimension);
  optionalNumber(layout.columnGap, `nodes[${index}].layout.columnGap`, 0, SCENE_LIMITS.maxDimension);
  if (layout.padding !== undefined) tuple(layout.padding, `nodes[${index}].layout.padding`, 0);
  optionalBoolean(layout.absolute, `nodes[${index}].layout.absolute`);
}

function validateTextStyle(value: unknown, index: number): void {
  const style = record(value, `nodes[${index}].textStyle`);
  string(style.fontFamily, `nodes[${index}].textStyle.fontFamily`, 500);
  const fontSize = number(style.fontSize, `nodes[${index}].textStyle.fontSize`, 0.01);
  if (fontSize > SCENE_LIMITS.maxDimension) fail(`nodes[${index}].textStyle.fontSize must be no greater than ${SCENE_LIMITS.maxDimension}.`);
  const fontWeight = number(style.fontWeight, `nodes[${index}].textStyle.fontWeight`, 1);
  if (fontWeight > 1_000) fail(`nodes[${index}].textStyle.fontWeight must be no greater than 1000.`);
  string(style.fontStyle, `nodes[${index}].textStyle.fontStyle`, 50);
  const lineHeight = number(style.lineHeight, `nodes[${index}].textStyle.lineHeight`, 0.01);
  if (lineHeight > SCENE_LIMITS.maxDimension) fail(`nodes[${index}].textStyle.lineHeight must be no greater than ${SCENE_LIMITS.maxDimension}.`);
  const letterSpacing = number(style.letterSpacing, `nodes[${index}].textStyle.letterSpacing`, -SCENE_LIMITS.maxDimension);
  if (letterSpacing > SCENE_LIMITS.maxDimension) fail(`nodes[${index}].textStyle.letterSpacing must be no greater than ${SCENE_LIMITS.maxDimension}.`);
  string(style.textAlign, `nodes[${index}].textStyle.textAlign`, 50);
  string(style.textDecoration, `nodes[${index}].textStyle.textDecoration`, 100);
  string(style.textTransform, `nodes[${index}].textStyle.textTransform`, 50);
}

function validateAsset(value: unknown, index: number): asserts value is AssetRef {
  const asset = record(value, `assets[${index}]`);
  string(asset.id, `assets[${index}].id`, 200);
  optionalString(asset.url, `assets[${index}].url`, 2_000_000);
  optionalString(asset.dataUrl, `assets[${index}].dataUrl`, 20_000_000);
  optionalString(asset.mimeType, `assets[${index}].mimeType`, 200);
  optionalNumber(asset.width, `assets[${index}].width`, 0, SCENE_LIMITS.maxDimension);
  optionalNumber(asset.height, `assets[${index}].height`, 0, SCENE_LIMITS.maxDimension);
  if ((typeof asset.url !== "string" || !asset.url.trim()) && (typeof asset.dataUrl !== "string" || !asset.dataUrl.trim())) {
    fail(`assets[${index}] must include a non-empty url or dataUrl.`);
  }
}

function validateDiagnostic(value: unknown, index: number): void {
  const diagnostic = record(value, `diagnostics[${index}]`);
  enumValue(string(diagnostic.severity, `diagnostics[${index}].severity`, 20), `diagnostics[${index}].severity`, ["info", "warning", "error"]);
  string(diagnostic.code, `diagnostics[${index}].code`, 100);
  string(diagnostic.message, `diagnostics[${index}].message`, 2_000);
  optionalString(diagnostic.viewportId, `diagnostics[${index}].viewportId`, 100);
  optionalString(diagnostic.source, `diagnostics[${index}].source`, 2_000);
}

function validateGraph(scene: SceneDocument, index: number): void {
  const nodes = scene.nodes;
  if (!nodes.length) fail(`scenes[${index}].nodes must contain at least one node.`);
  const byId = new Map<string, SceneNode>();
  nodes.forEach((node, nodeIndex) => {
    if (byId.has(node.id)) fail(`scenes[${index}].nodes contains duplicate id "${node.id}".`);
    byId.set(node.id, node);
    if (node.parentId === node.id) fail(`scenes[${index}].nodes[${nodeIndex}] cannot parent itself.`);
  });

  for (const [nodeIndex, node] of nodes.entries()) {
    if (node.parentId !== undefined && !byId.has(node.parentId)) {
      fail(`scenes[${index}].nodes[${nodeIndex}].parentId references missing node "${node.parentId}".`);
    }
    if (node.parentId !== undefined && !byId.get(node.parentId)?.children.includes(node.id)) {
      fail(`scenes[${index}].nodes[${nodeIndex}] is missing from parent "${node.parentId}".children.`);
    }
    const childIds = new Set<string>();
    for (const childId of node.children) {
      if (childIds.has(childId)) fail(`scenes[${index}].nodes[${nodeIndex}].children contains duplicate id "${childId}".`);
      childIds.add(childId);
      const child = byId.get(childId);
      if (!child) fail(`scenes[${index}].nodes[${nodeIndex}].children references missing node "${childId}".`);
      if (child.parentId !== node.id) fail(`scenes[${index}].nodes[${nodeIndex}].children does not match child "${childId}".parentId.`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visited.has(nodeId)) return;
    if (visiting.has(nodeId)) fail(`scenes[${index}].nodes contains a parent cycle at "${nodeId}".`);
    visiting.add(nodeId);
    const parentId = byId.get(nodeId)?.parentId;
    if (parentId) visit(parentId);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of nodes) visit(node.id);
}

function validateReferences(scene: SceneDocument, index: number): void {
  const assets = new Map<string, unknown>();
  scene.assets.forEach((asset, assetIndex) => {
    if (assets.has(asset.id)) fail(`scenes[${index}].assets contains duplicate id "${asset.id}".`);
    assets.set(asset.id, asset);
  });
  scene.nodes.forEach((node, nodeIndex) => {
    if (node.assetId !== undefined && !assets.has(node.assetId)) fail(`scenes[${index}].nodes[${nodeIndex}].assetId references missing asset "${node.assetId}".`);
  });
}

function validateScene(value: unknown, index: number): asserts value is SceneDocument {
  const scene = record(value, `scenes[${index}]`);
  if (scene.protocolVersion !== PROTOCOL_VERSION) fail(`scenes[${index}] has an unsupported protocol version.`);
  const viewport = record(scene.viewport, `scenes[${index}].viewport`);
  string(viewport.id, `scenes[${index}].viewport.id`, 100);
  string(viewport.name, `scenes[${index}].viewport.name`, 100);
  const viewportWidth = number(viewport.width, `scenes[${index}].viewport.width`, 1);
  if (viewportWidth > SCENE_LIMITS.maxDimension) fail(`scenes[${index}].viewport.width must be no greater than ${SCENE_LIMITS.maxDimension}.`);
  const viewportHeight = number(viewport.height, `scenes[${index}].viewport.height`, 1);
  if (viewportHeight > SCENE_LIMITS.maxDimension) fail(`scenes[${index}].viewport.height must be no greater than ${SCENE_LIMITS.maxDimension}.`);
  const size = record(scene.documentSize, `scenes[${index}].documentSize`);
  const width = number(size.width, `scenes[${index}].documentSize.width`, 1);
  if (width > SCENE_LIMITS.maxDimension) throw new Error(`${viewport.name} exceeds the ${SCENE_LIMITS.maxDimension.toLocaleString("en-US")}px width limit.`);
  const height = number(size.height, `scenes[${index}].documentSize.height`, 1);
  if (height > SCENE_LIMITS.maxHeight) throw new Error(`${viewport.name} exceeds the ${SCENE_LIMITS.maxHeight.toLocaleString("en-US")}px height limit.`);
  array(scene.nodes, `scenes[${index}].nodes`).forEach(validateNode);
  array(scene.assets, `scenes[${index}].assets`).forEach(validateAsset);
  array(scene.diagnostics, `scenes[${index}].diagnostics`).forEach(validateDiagnostic);
  validateGraph(scene as unknown as SceneDocument, index);
  validateReferences(scene as unknown as SceneDocument, index);
}

export function validateScenes(value: unknown): SceneDocument[] {
  const scenes = array(value, "scenes", SCENE_LIMITS.maxScenes);
  if (!scenes.length) fail("at least one scene is required.");
  scenes.forEach(validateScene);
  const validatedScenes = scenes as unknown as SceneDocument[];
  const viewportIds = new Set<string>();
  let layers = 0;
  for (const scene of validatedScenes) {
    if (viewportIds.has(scene.viewport.id)) fail(`scenes contains duplicate viewport id "${scene.viewport.id}".`);
    viewportIds.add(scene.viewport.id);
    layers += scene.nodes.length;
  }
  if (layers > SCENE_LIMITS.maxTotalLayers) fail(`import contains more than ${SCENE_LIMITS.maxTotalLayers} layers.`);
  const bytes = utf8ByteLength(JSON.stringify(scenes));
  if (bytes > SCENE_LIMITS.maxMessageBytes) throw new Error("Import is larger than the 25 MB safety limit.");
  return validatedScenes;
}

export function sceneWarnings(scenes: SceneDocument[]) {
  const layers = scenes.reduce((total, scene) => total + scene.nodes.length, 0);
  const tall = scenes.filter((scene) => scene.documentSize.height > SCENE_LIMITS.warningHeight);
  return {
    layers,
    needsLayerConfirmation: layers > SCENE_LIMITS.warningLayers,
    tallViewports: tall.map((scene) => scene.viewport.name)
  };
}
