import { PROTOCOL_VERSION, SCENE_LIMITS, type SceneDocument, type SceneNode } from "./contracts";

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

function array(value: unknown, label: string, maximum = SCENE_LIMITS.maxLayers): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail(`${label} must be an array with at most ${maximum} entries.`);
  return value;
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
  number(rect.x, `nodes[${index}].rect.x`);
  number(rect.y, `nodes[${index}].rect.y`);
  number(rect.width, `nodes[${index}].rect.width`, 0);
  number(rect.height, `nodes[${index}].rect.height`, 0);
  number(node.zIndex, `nodes[${index}].zIndex`);
  record(node.paint, `nodes[${index}].paint`);
  record(node.layout, `nodes[${index}].layout`);
  if (node.text !== undefined) string(node.text, `nodes[${index}].text`, 100_000);
  if (node.textNoWrap !== undefined && typeof node.textNoWrap !== "boolean") fail(`nodes[${index}].textNoWrap must be a boolean.`);
  if (node.assetId !== undefined) string(node.assetId, `nodes[${index}].assetId`, 200);
  if (node.fallbackReason !== undefined) string(node.fallbackReason, `nodes[${index}].fallbackReason`, 1_000);
}

function validateScene(value: unknown, index: number): asserts value is SceneDocument {
  const scene = record(value, `scenes[${index}]`);
  if (scene.protocolVersion !== PROTOCOL_VERSION) fail(`scenes[${index}] has an unsupported protocol version.`);
  const viewport = record(scene.viewport, `scenes[${index}].viewport`);
  string(viewport.id, `scenes[${index}].viewport.id`, 100);
  string(viewport.name, `scenes[${index}].viewport.name`, 100);
  number(viewport.width, `scenes[${index}].viewport.width`, 1);
  number(viewport.height, `scenes[${index}].viewport.height`, 1);
  const size = record(scene.documentSize, `scenes[${index}].documentSize`);
  number(size.width, `scenes[${index}].documentSize.width`, 1);
  const height = number(size.height, `scenes[${index}].documentSize.height`, 1);
  if (height > SCENE_LIMITS.maxHeight) throw new Error(`${viewport.name} exceeds the 100,000px height limit.`);
  array(scene.nodes, `scenes[${index}].nodes`).forEach(validateNode);
  array(scene.assets, `scenes[${index}].assets`).forEach((asset, assetIndex) => record(asset, `scenes[${index}].assets[${assetIndex}]`));
  array(scene.diagnostics, `scenes[${index}].diagnostics`).forEach((diagnostic, diagnosticIndex) => record(diagnostic, `scenes[${index}].diagnostics[${diagnosticIndex}]`));
}

export function validateScenes(value: unknown): SceneDocument[] {
  const scenes = array(value, "scenes");
  if (!scenes.length) fail("at least one scene is required.");
  scenes.forEach(validateScene);
  const bytes = utf8ByteLength(JSON.stringify(scenes));
  if (bytes > SCENE_LIMITS.maxMessageBytes) throw new Error("Import is larger than the 25 MB safety limit.");
  return scenes as SceneDocument[];
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
