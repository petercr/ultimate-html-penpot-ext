import type { Rect } from "../shared/contracts";
import { SCENE_LIMITS } from "../shared/contracts";

export interface SvgImageGeometry {
  /** Root source coordinates used by Penpot's SVG converter. */
  viewBox: Rect;
  /** Source viewBox frame mapped into the captured CSS object viewport. */
  rect: Rect;
}

const NUMBER = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
const SEPARATOR = "(?:\\s+,?\\s*|\\s*,\\s*)";
const VIEW_BOX = new RegExp(`^\\s*(${NUMBER})${SEPARATOR}(${NUMBER})${SEPARATOR}(${NUMBER})${SEPARATOR}(${NUMBER})\\s*$`);
const LENGTH = new RegExp(`^\\s*(${NUMBER})(?:px)?\\s*$`, "i");
// XML quotes may contain >. Matching the complete opening tag also ensures
// an aria-label or data attribute cannot accidentally become SVG geometry.
const ROOT = /^<svg\b((?:"[^"]*"|'[^']*'|[^'">])*)>/;
const ATTRIBUTE = /\s+([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;

function attributeValue(value: string): string | undefined {
  let valid = true;
  const result = value.replace(/&([^;\s]*);?/g, (_entity, name: string) => {
    const predefined: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (Object.hasOwn(predefined, name)) return predefined[name];
    const numeric = /^#x([\da-f]+)$/i.exec(name) ?? /^#(\d+)$/.exec(name);
    if (numeric) {
      const codePoint = Number.parseInt(numeric[1], /^#x/i.test(name) ? 16 : 10);
      if (codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)) return String.fromCodePoint(codePoint);
    }
    valid = false;
    return "";
  });
  return valid ? result : undefined;
}

function rootAttributes(source: string): Map<string, string> | undefined {
  // A declaration and comments before the root do not create a viewport.
  const prefix = /^\s*(?:(?:<\?[\s\S]*?\?>|[<]!--[\s\S]*?--[>])\s*)*/.exec(source)?.[0] ?? "";
  const root = ROOT.exec(source.slice(prefix.length));
  if (!root) return undefined;
  const attributes = root[1].replace(/\/\s*$/, "");
  const result = new Map<string, string>();
  let cursor = 0;
  while (cursor < attributes.length) {
    if (!attributes.slice(cursor).trim()) break;
    ATTRIBUTE.lastIndex = cursor;
    const attribute = ATTRIBUTE.exec(attributes);
    if (!attribute || result.has(attribute[1])) return undefined;
    const decoded = attributeValue(attribute[2] ?? attribute[3]);
    if (decoded === undefined) return undefined;
    result.set(attribute[1], decoded);
    cursor = ATTRIBUTE.lastIndex;
  }
  return result;
}

function sourceViewBox(attributes: Map<string, string>): Rect | undefined {
  const value = attributes.get("viewBox");
  if (value !== undefined) {
    const parts = VIEW_BOX.exec(value);
    if (!parts) return undefined;
    const [x, y, width, height] = parts.slice(1).map(Number);
    if (![x, y, width, height].every((amount) => Number.isFinite(amount) && Math.abs(amount) <= SCENE_LIMITS.maxDimension) || width < 0.000001 || height < 0.000001) return undefined;
    return { x, y, width, height };
  }
  const width = Number(LENGTH.exec(attributes.get("width") ?? "")?.[1]);
  const height = Number(LENGTH.exec(attributes.get("height") ?? "")?.[1]);
  if (![width, height].every((amount) => Number.isFinite(amount) && amount >= 0.000001 && amount <= SCENE_LIMITS.maxDimension)) return undefined;
  return { x: 0, y: 0, width, height };
}

/** Resolve the editable SVG group's frame independently of object-fit. Penpot
 * treats nested svg tags as groups, so those sources need image-media fallback
 * rather than an inferred viewport transform. */
export function svgImageGeometry(source: string, viewport: Rect, scale = 1): SvgImageGeometry | undefined {
  if (!Object.values(viewport).every(Number.isFinite) || viewport.width <= 0 || viewport.height <= 0 || !(scale > 0) || !Number.isFinite(scale)) return undefined;
  const markup = source.replace(/[<]!--[\s\S]*?--[>]|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g, "");
  if ((markup.match(/<svg(?:[\s/>])/g) ?? []).length !== 1) return undefined;
  const attributes = rootAttributes(source);
  if (!attributes) return undefined;
  // Penpot inherits a root transform onto its hidden extent rectangle too.
  // Repositioning that converted group's bounds would cancel a root translation
  // even when its dimensions pass the viewBox check. Root CSS sizing also has
  // viewport semantics beyond the supported numeric root-attribute subset.
  if (attributes.get("transform")?.trim() || /(?:^|;)\s*(?:transform|width|height)\s*:/i.test(attributes.get("style") ?? "")) return undefined;
  const viewBox = sourceViewBox(attributes);
  if (!viewBox) return undefined;
  const aspect = attributes.get("preserveAspectRatio")?.trim() || "xMidYMid meet";
  const none = /^none(?:\s+(?:meet|slice))?$/.test(aspect);
  const aligned = /^(xMin|xMid|xMax)(YMin|YMid|YMax)(?:\s+(meet|slice))?$/.exec(aspect);
  if (!none && !aligned) return undefined;

  let rect: Rect;
  if (!attributes.has("viewBox")) {
    // Without viewBox, SVG user units remain CSS pixels: changing its object
    // viewport crops or reveals coordinates, rather than scaling them. The
    // converter resolves percentage geometry in its original viewport, so a
    // different viewport with percent values requires the image fallback.
    const width = viewBox.width * scale;
    const height = viewBox.height * scale;
    if (/%/.test(source) && (Math.abs(width - viewport.width) > 0.000001 || Math.abs(height - viewport.height) > 0.000001)) return undefined;
    rect = { x: viewport.x, y: viewport.y, width, height };
  } else if (none) {
    rect = { ...viewport };
  } else {
    const ratioX = viewport.width / viewBox.width;
    const ratioY = viewport.height / viewBox.height;
    const ratio = aligned![3] === "slice" ? Math.max(ratioX, ratioY) : Math.min(ratioX, ratioY);
    const width = viewBox.width * ratio;
    const height = viewBox.height * ratio;
    const fraction = (alignment: string) => alignment.endsWith("Min") ? 0 : alignment.endsWith("Max") ? 1 : 0.5;
    rect = {
      x: viewport.x + (viewport.width - width) * fraction(aligned![1]),
      y: viewport.y + (viewport.height - height) * fraction(aligned![2]),
      width, height
    };
  }
  if (!Object.values(rect).every(Number.isFinite) || rect.width < 0.000001 || rect.height < 0.000001 || rect.width > SCENE_LIMITS.maxDimension || rect.height > SCENE_LIMITS.maxDimension) return undefined;
  return { viewBox, rect };
}
