import { PROTOCOL_VERSION, SCENE_LIMITS, type ViewportSpec } from "../shared/contracts";

export interface CaptureLimits {
  maxNodes: number;
  maxAssets: number;
  maxWidth: number;
  maxHeight: number;
}

const DEFAULT_CAPTURE_LIMITS: CaptureLimits = {
  maxNodes: SCENE_LIMITS.maxLayers,
  // Scene validation uses the same per-scene array bound for assets.
  maxAssets: SCENE_LIMITS.maxLayers,
  maxWidth: SCENE_LIMITS.maxDimension,
  maxHeight: SCENE_LIMITS.maxHeight
};

/** A self-contained script run inside the opaque, sandboxed document. */
export function buildExtractorScript(token: string, viewport: ViewportSpec, settleDelayMs: number, limits: CaptureLimits = DEFAULT_CAPTURE_LIMITS, collectMetrics = false): string {
  const encodedViewport = JSON.stringify(viewport);
  const captureLimits: CaptureLimits = {
    maxNodes: Math.max(1, Math.floor(limits.maxNodes)),
    maxAssets: Math.max(1, Math.floor(limits.maxAssets)),
    maxWidth: Math.max(1, Math.floor(limits.maxWidth)),
    maxHeight: Math.max(1, Math.floor(limits.maxHeight))
  };
  return `
(() => {
  const token = ${JSON.stringify(token)};
  const viewport = ${encodedViewport};
  const delay = ${Math.max(0, Math.min(settleDelayMs, 10_000))};
  const limits = ${JSON.stringify(captureLimits)};
  const collectMetrics = ${collectMetrics};
  const startedAt = performance.now();
  const metrics = { viewportId: viewport.id, nodeCount: 0, assetCount: 0, settleMs: 0, extractionMs: 0, textMeasurementMs: 0, styleReads: 0, geometryReads: 0, textRangeReads: 0 };
  // Capture reads run synchronously after settling. A child's style is often
  // needed both to classify its parent and to visit the child itself.
  const styleCache = new WeakMap();
  const styleOf = (element, pseudo) => {
    if (!pseudo && styleCache.has(element)) return styleCache.get(element);
    if (collectMetrics) metrics.styleReads += 1;
    const style = getComputedStyle(element, pseudo);
    if (!pseudo) styleCache.set(element, style);
    return style;
  };
  const boundsOf = (element) => {
    if (collectMetrics) metrics.geometryReads += 1;
    return element.getBoundingClientRect();
  };
  const rangeRects = (range) => {
    if (collectMetrics) metrics.textRangeReads += 1;
    return range.getClientRects();
  };
  const rangeBounds = (range) => {
    if (collectMetrics) metrics.textRangeReads += 1;
    return range.getBoundingClientRect();
  };
  const scriptsDisabled = document.documentElement.getAttribute("data-html-to-penpot-scripts-disabled");
  const diagnostics = [];
  const assets = new Map();
  const nodes = [];
  const nodeById = new Map();
  const reportedDiagnostics = new Set();
  let sequence = 0;

  const reserveNode = () => {
    if (nodes.length >= limits.maxNodes) throw new Error("Capture stopped before import: this viewport has more than " + limits.maxNodes.toLocaleString() + " renderable layers. Reduce page complexity or split the page into smaller imports.");
  };

  const number = (value) => { const parsed = parseFloat(value || "0"); return Number.isFinite(parsed) ? parsed : 0; };
  const compact = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const rectOf = (rect) => ({ x: Math.round(rect.x * 100) / 100, y: Math.round(rect.y * 100) / 100, width: Math.round(rect.width * 100) / 100, height: Math.round(rect.height * 100) / 100 });
  // CSS transforms. A transformed element's own transform is recorded and
  // replaced by an identity matrix before its box is read, so that element and
  // every descendant are measured in untransformed layout space. The recorded
  // matrices are composed into a frame for each node: its own size, the
  // position of its top-left corner after all transforms, and a rotation about
  // that corner. Penpot rotates a layer from its own unrotated size, so
  // rotating a transformed bounding box would grow and displace the layer.
  const IDENTITY = [1, 0, 0, 1, 0, 0];
  const matrices = new Map();
  const compose = (outer, inner) => [
    outer[0] * inner[0] + outer[2] * inner[1], outer[1] * inner[0] + outer[3] * inner[1],
    outer[0] * inner[2] + outer[2] * inner[3], outer[1] * inner[2] + outer[3] * inner[3],
    outer[0] * inner[4] + outer[2] * inner[5] + outer[4], outer[1] * inner[4] + outer[3] * inner[5] + outer[5]
  ];
  const tokensOf = (value) => String(value || "").trim().split(/\\s+/).filter(Boolean);
  const angleDegrees = (token) => {
    const match = /^([+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?)(deg|grad|rad|turn)$/i.exec(token || "");
    if (!match) return undefined;
    const amount = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    return unit === "deg" ? amount : unit === "grad" ? amount * 0.9 : unit === "rad" ? amount * 180 / Math.PI : amount * 360;
  };
  const isSet = (value) => Boolean(value) && value !== "none";
  // Computed transforms serialize as matrix() or matrix3d(); the 3D form is
  // flat only when every component outside the 2D plane is the identity.
  const parseMatrix = (value) => {
    const match = /^matrix(3d)?\\(([^)]*)\\)$/.exec(String(value).trim());
    if (!match) return undefined;
    const values = match[2].split(",").map(parseFloat);
    if (values.some((entry) => !Number.isFinite(entry))) return undefined;
    if (!match[1]) return values.length === 6 ? { matrix: values, flat: true } : undefined;
    if (values.length !== 16) return undefined;
    const flat = [2, 3, 6, 7, 8, 9, 11, 14].every((index) => values[index] === 0) && values[10] === 1 && values[15] === 1;
    return { matrix: [values[0], values[1], values[4], values[5], values[12], values[13]], flat };
  };
  // CSS applies translate, then rotate, then scale, then transform. The result
  // is flat only when none of them has a 3D component.
  const readTransform = (style) => {
    if (!isSet(style.transform) && !isSet(style.translate) && !isSet(style.rotate) && !isSet(style.scale)) return undefined;
    let matrix = IDENTITY;
    let flat = true;
    // The computed translate property keeps percentages, which refer to the
    // layer's own box and are resolved once that box has been measured.
    let percent;
    if (isSet(style.translate)) {
      const [x = "0", y = "0", z = "0"] = tokensOf(style.translate);
      const parts = [x, y, z].map((token) => /^([+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?)(px|%)?$/i.exec(token));
      if (parts.some((part) => !part) || parseFloat(z)) flat = false;
      else {
        const [lengthX, lengthY] = parts.map((part, index) => index < 2 && part[2] !== "%" ? parseFloat(part[1]) : 0);
        const [percentX, percentY] = parts.map((part, index) => index < 2 && part[2] === "%" ? parseFloat(part[1]) : 0);
        matrix = compose(matrix, [1, 0, 0, 1, lengthX, lengthY]);
        if (percentX || percentY) percent = [percentX, percentY];
      }
    }
    if (isSet(style.rotate)) {
      const tokens = tokensOf(style.rotate);
      const degrees = tokens.length === 1 ? angleDegrees(tokens[0]) : undefined;
      if (degrees === undefined) flat = false;
      else {
        const radians = degrees * Math.PI / 180;
        matrix = compose(matrix, [Math.cos(radians), Math.sin(radians), -Math.sin(radians), Math.cos(radians), 0, 0]);
      }
    }
    if (isSet(style.scale)) {
      const [x = 1, y = x, z = 1] = tokensOf(style.scale).map(parseFloat);
      matrix = compose(matrix, [x, 0, 0, y, 0, 0]);
      if (z !== 1) flat = false;
    }
    if (isSet(style.transform)) {
      const own = parseMatrix(style.transform);
      if (!own || !own.flat) flat = false;
      else matrix = compose(matrix, own.matrix);
    }
    const origin = tokensOf(style.transformOrigin).map(parseFloat);
    if (origin[2]) flat = false;
    return { matrix, percent, originX: origin[0] || 0, originY: origin[1] || 0, flat: flat && matrix.every(Number.isFinite) };
  };
  // Penpot layers carry a rotation, a position and a size, so only similarity
  // transforms (rotation, uniform scale, translation) map onto them exactly.
  const SIMILARITY_TOLERANCE = 0.001;
  const isSimilarity = (matrix) => {
    const [a, b, c, d] = matrix;
    const scaleX = Math.hypot(a, b);
    const scaleY = Math.hypot(c, d);
    if (!(scaleX > 0) || !(scaleY > 0)) return false;
    return a * d - b * c > 0 && Math.abs(a * c + b * d) <= SIMILARITY_TOLERANCE * scaleX * scaleY && Math.abs(scaleX - scaleY) <= SIMILARITY_TOLERANCE * Math.max(scaleX, scaleY);
  };
  const isDegenerate = (matrix) => Math.hypot(matrix[0], matrix[1]) < 1e-4 || Math.hypot(matrix[2], matrix[3]) < 1e-4;
  // Inline boxes that are not replaced content are not transformable: the browser ignores their transform.
  const REPLACED_TAGS = ["IMG", "SVG", "VIDEO", "CANVAS", "IFRAME", "EMBED", "OBJECT", "AUDIO"];
  const transformable = (element, style) => style.display !== "contents" && (style.display !== "inline" || REPLACED_TAGS.includes(element.tagName.toUpperCase()));
  const neutralize = (element) => {
    // An identity matrix, not "none", keeps the element the containing block
    // for fixed and absolute descendants, so layout is unchanged.
    element.style?.setProperty("transform", "matrix(1, 0, 0, 1, 0, 0)", "important");
    for (const property of ["translate", "rotate", "scale"]) element.style?.setProperty(property, "none", "important");
  };
  const aboutOrigin = (transform, box) => {
    const x = box.x + transform.originX;
    const y = box.y + transform.originY;
    return compose([1, 0, 0, 1, x, y], compose(transform.matrix, [1, 0, 0, 1, -x, -y]));
  };
  // Replaces a node's layout-space rect with its frame. Sizes and the text,
  // border and corner measurements that scale with the layer follow a uniform scale.
  const placeNode = (node, matrix) => {
    const box = node.rect;
    const [a, b, c, d, e, f] = matrix;
    const scale = Math.hypot(a, b);
    const degrees = Math.atan2(b, a) * 180 / Math.PI;
    node.rect = rectOf({ x: a * box.x + c * box.y + e, y: b * box.x + d * box.y + f, width: box.width * scale, height: box.height * scale });
    if (Math.abs(degrees) > 0.005) node.rotation = Math.round(degrees * 1000) / 1000;
    if (node.image && scale !== 1) {
      node.image.scale = (node.image.scale || 1) * scale;
      node.image.position.x.offset *= scale;
      node.image.position.y.offset *= scale;
    }
    if (Math.abs(scale - 1) <= 1e-4) return;
    const scaled = (value) => Math.round(value * scale * 100) / 100;
    if (node.paint.borderWidth) node.paint.borderWidth = scaled(node.paint.borderWidth);
    if (node.paint.borders) for (const border of Object.values(node.paint.borders)) border.width = scaled(border.width);
    if (node.paint.radius) node.paint.radius = node.paint.radius.map(scaled);
    if (node.layout.padding) node.layout.padding = node.layout.padding.map(scaled);
    if (node.textMaxWidth) node.textMaxWidth = Math.max(0.1, scaled(node.textMaxWidth));
    if (node.textStyle) {
      node.textStyle.fontSize = scaled(node.textStyle.fontSize);
      node.textStyle.letterSpacing = scaled(node.textStyle.letterSpacing);
    }
  };
  const visible = (element, style, rect) => style.display !== "none" && style.visibility !== "hidden" && number(style.opacity) !== 0 && (rect.width > 0 || rect.height > 0);
  const suppressesSubtree = (style) => style.display === "none" || number(style.opacity) === 0;
  const sourceOf = (element) => {
    if (element.id) return "#" + CSS.escape(element.id);
    const parts = [];
    let cursor = element;
    while (cursor && cursor.nodeType === 1 && cursor !== document.body && parts.length < 6) {
      const siblings = [...cursor.parentElement?.children || []].filter((candidate) => candidate.tagName === cursor.tagName);
      const suffix = siblings.length > 1 ? ":nth-of-type(" + (siblings.indexOf(cursor) + 1) + ")" : "";
      parts.unshift(cursor.tagName.toLowerCase() + suffix);
      cursor = cursor.parentElement;
    }
    return parts.join(" > ") || "body";
  };
  const nameOf = (element) => compact(element.getAttribute("aria-label")) || compact(element.id) || compact(element.className && typeof element.className === "string" ? element.className.split(/\\s+/)[0] : "") || element.tagName.toLowerCase();
  // Computed positions retain percentages and calc(% +/- px). Store each axis
  // as a fraction of the remaining space plus a fixed offset, so cover and
  // contain use the same positioning rule even when that space is negative.
  const imagePositionLength = (token) => {
    const numeric = "[+-]?(?:\\\\d+\\\\.?\\\\d*|\\\\.\\\\d+)(?:e[+-]?\\\\d+)?";
    const single = new RegExp("^(" + numeric + ")(px|%)?$", "i").exec(token);
    if (single) {
      const amount = Number(single[1]);
      if (!Number.isFinite(amount) || (!single[2] && amount !== 0)) return undefined;
      return { percentage: single[2] === "%" ? amount / 100 : 0, offset: single[2] === "%" ? 0 : amount };
    }
    const calc = /^calc\\(([^()]*)\\)$/i.exec(token);
    if (!calc) return undefined;
    const expression = calc[1].replace(/\\s+/g, "");
    const terms = expression.match(new RegExp(numeric + "(?:px|%)", "gi"));
    if (!terms || terms.join("") !== expression || terms.slice(1).some((term) => !/^[+-]/.test(term))) return undefined;
    let percentage = 0;
    let offset = 0;
    for (const term of terms) {
      const amount = parseFloat(term);
      if (term.endsWith("%")) percentage += amount / 100;
      else offset += amount;
    }
    return Number.isFinite(percentage) && Number.isFinite(offset) ? { percentage, offset } : undefined;
  };
  const imagePosition = (value) => {
    // Split outside parentheses, preserving the spaces in a calc expression.
    const tokens = [];
    let depth = 0;
    let token = "";
    for (const character of String(value || "50% 50%").trim().toLowerCase()) {
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      if (depth < 0) return undefined;
      if (/\\s/.test(character) && depth === 0) {
        if (token) tokens.push(token);
        token = "";
      } else token += character;
    }
    if (depth !== 0) return undefined;
    if (token) tokens.push(token);
    const center = () => ({ percentage: 0.5, offset: 0 });
    const axisValue = (part, axis) => {
      if (part === "center") return center();
      if (part === (axis === "x" ? "left" : "top")) return { percentage: 0, offset: 0 };
      if (part === (axis === "x" ? "right" : "bottom")) return { percentage: 1, offset: 0 };
      return imagePositionLength(part);
    };
    let result;
    if (tokens.length === 1) {
      result = ["top", "bottom"].includes(tokens[0])
        ? { x: center(), y: axisValue(tokens[0], "y") }
        : { x: axisValue(tokens[0], "x"), y: center() };
    } else if (tokens.length === 2) {
      const keywords = tokens.every((part) => ["left", "right", "top", "bottom", "center"].includes(part));
      const swapped = keywords && (["top", "bottom"].includes(tokens[0]) || ["left", "right"].includes(tokens[1]));
      result = { x: axisValue(tokens[swapped ? 1 : 0], "x"), y: axisValue(tokens[swapped ? 0 : 1], "y") };
    } else if (tokens.length === 3 || tokens.length === 4) {
      result = {};
      let centers = 0;
      for (let index = 0; index < tokens.length; index += 1) {
        const edge = tokens[index];
        if (edge === "center") { centers += 1; continue; }
        const axis = ["left", "right"].includes(edge) ? "x" : ["top", "bottom"].includes(edge) ? "y" : undefined;
        if (!axis || result[axis]) return undefined;
        const offset = imagePositionLength(tokens[index + 1] || "");
        if (offset) index += 1;
        const fromEnd = edge === "right" || edge === "bottom";
        result[axis] = {
          percentage: (fromEnd ? 1 : 0) + (fromEnd ? -1 : 1) * (offset?.percentage || 0),
          offset: (fromEnd ? -1 : 1) * (offset?.offset || 0)
        };
      }
      for (const axis of ["x", "y"]) if (!result[axis] && centers > 0) { result[axis] = center(); centers -= 1; }
      if (centers) return undefined;
    }
    if (!result?.x || !result?.y) return undefined;
    if ([result.x.percentage, result.x.offset, result.y.percentage, result.y.offset].some((amount) => !Number.isFinite(amount) || Math.abs(amount) > ${SCENE_LIMITS.maxDimension})) return undefined;
    return result;
  };
  const imageOf = (element, style, source) => {
    const intrinsicWidth = element.naturalWidth;
    const intrinsicHeight = element.naturalHeight;
    if (!(intrinsicWidth > 0) || !(intrinsicHeight > 0) || intrinsicWidth > ${SCENE_LIMITS.maxDimension} || intrinsicHeight > ${SCENE_LIMITS.maxDimension}) {
      diagnostics.push({ severity: "warning", code: "IMAGE_DIMENSIONS_UNAVAILABLE", message: "The image has no usable natural dimensions; its captured element bounds are retained and object-fit/object-position cannot be reproduced.", viewportId: viewport.id, source });
      return undefined;
    }
    const fit = String(style.objectFit || "fill").trim().toLowerCase();
    if (!["fill", "contain", "cover", "none", "scale-down"].includes(fit)) {
      diagnostics.push({ severity: "warning", code: "UNSUPPORTED_OBJECT_FIT", message: "The image uses an unsupported object-fit value; its captured element bounds are retained.", viewportId: viewport.id, source });
      return undefined;
    }
    let position = imagePosition(style.objectPosition);
    if (!position) {
      diagnostics.push({ severity: "warning", code: "UNSUPPORTED_OBJECT_POSITION", message: "The image object-position cannot be represented as percentages and pixel offsets; the imported image is centered while preserving object-fit.", viewportId: viewport.id, source });
      position = { x: { percentage: 0.5, offset: 0 }, y: { percentage: 0.5, offset: 0 } };
    }
    return { fit, position, intrinsicWidth, intrinsicHeight };
  };
  const asset = (url, hint) => {
    if (!url || url === "none" || url.startsWith("linear-gradient") || url.startsWith("radial-gradient")) return undefined;
    const existing = assets.get(url);
    if (existing) return existing.id;
    if (assets.size >= limits.maxAssets) throw new Error("Capture stopped before import: this viewport has more than " + limits.maxAssets.toLocaleString() + " distinct assets. Reduce page complexity or split the page into smaller imports.");
    const id = "asset-" + (assets.size + 1);
    const dataUrl = /^data:/i.test(url) ? url : undefined;
    const dataMime = dataUrl?.match(/^data:([^;,]+)/i)?.[1];
    assets.set(url, dataUrl
      ? { id, dataUrl, mimeType: dataMime || hint }
      : { id, url, mimeType: hint });
    return id;
  };
  // CSS separates background layers with commas, but commas may also appear
  // inside gradients and data URLs. Split only at the top level so the
  // importer can deliberately retain the topmost layer it knows how to draw.
  const backgroundLayers = (value) => {
    const layers = [];
    let start = 0;
    let depth = 0;
    let quote = "";
    let escaped = false;
    const source = String(value || "");
    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\\\") escaped = true;
        else if (character === quote) quote = "";
        continue;
      }
      if (character.charCodeAt(0) === 34 || character === "'") { quote = character; continue; }
      if (character === "(") { depth += 1; continue; }
      if (character === ")") { depth = Math.max(0, depth - 1); continue; }
      if (character === "," && depth === 0) {
        const layer = source.slice(start, index).trim();
        if (layer) layers.push(layer);
        start = index + 1;
      }
    }
    const layer = source.slice(start).trim();
    if (layer) layers.push(layer);
    return layers;
  };
  const backgroundUrl = (value) => {
    const layer = backgroundLayers(value)[0] || "";
    const match = /^url\\(\\s*(?:"([^"]*)"|'([^']*)'|(.+?))\\s*\\)$/i.exec(layer);
    return match ? (match[1] ?? match[2] ?? match[3])?.trim() : undefined;
  };
  const decodeSvgDataUrl = (value) => {
    const source = String(value || "");
    const comma = source.indexOf(",");
    if (comma < 0 || !/^data:image\\/svg\\+xml(?:;[^,]*)?,/i.test(source)) return undefined;
    const header = source.slice(0, comma);
    const encoded = source.slice(comma + 1);
    try {
      if (/;base64(?:;|$)/i.test(header)) {
        const binary = atob(encoded);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        if (typeof TextDecoder === "function") return new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
        return binary.trim();
      }
      const decoded = decodeURIComponent(encoded).trim();
      return /<svg[\\s>]/i.test(decoded) ? decoded : undefined;
    } catch (_) {
      return undefined;
    }
  };
  const positiveNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  const svgViewport = (root) => {
    const viewBox = String(root.getAttribute("viewBox") || "").trim().split(/[\\s,]+/).map(Number);
    if (viewBox.length === 4 && viewBox.every((value) => Number.isFinite(value)) && viewBox[2] > 0 && viewBox[3] > 0) {
      const intrinsicWidth = positiveNumber(String(root.getAttribute("width") || "").replace(/px$/i, "")) || viewBox[2];
      const intrinsicHeight = positiveNumber(String(root.getAttribute("height") || "").replace(/px$/i, "")) || viewBox[3];
      return { x: viewBox[0], y: viewBox[1], width: viewBox[2], height: viewBox[3], intrinsicWidth, intrinsicHeight };
    }
    const width = positiveNumber(String(root.getAttribute("width") || "").replace(/px$/i, ""));
    const height = positiveNumber(String(root.getAttribute("height") || "").replace(/px$/i, ""));
    return width && height ? { x: 0, y: 0, width, height, intrinsicWidth: width, intrinsicHeight: height } : undefined;
  };
  const cssSize = (value, target, natural) => {
    const token = String(value || "").trim().toLowerCase();
    if (!token || token === "auto") return undefined;
    if (token.endsWith("%")) return positiveNumber(target * Number.parseFloat(token) / 100);
    return positiveNumber(Number.parseFloat(token.replace(/px$/i, ""))) || natural;
  };
  const backgroundTileSize = (value, targetWidth, targetHeight, sourceWidth, sourceHeight) => {
    const tokens = String(value || "auto auto").trim().split(/\\s+/).filter(Boolean);
    const first = tokens[0] || "auto";
    const second = tokens[1] || "auto";
    if (first === "cover" || first === "contain") {
      const factor = first === "cover"
        ? Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight)
        : Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
      return { width: sourceWidth * factor, height: sourceHeight * factor };
    }
    let width = cssSize(first, targetWidth, sourceWidth);
    let height = cssSize(second, targetHeight, sourceHeight);
    if (!width && !height) return { width: sourceWidth, height: sourceHeight };
    if (!width) width = height * sourceWidth / sourceHeight;
    if (!height) height = width * sourceHeight / sourceWidth;
    return width && height ? { width, height } : undefined;
  };
  const backgroundPositionValue = (token, target, tile, axis) => {
    const normalized = String(token || "").trim().toLowerCase();
    if (normalized === (axis === "x" ? "left" : "top")) return 0;
    if (normalized === "center") return (target - tile) / 2;
    if (normalized === (axis === "x" ? "right" : "bottom")) return target - tile;
    if (normalized.endsWith("%")) return (target - tile) * Number.parseFloat(normalized) / 100;
    const pixels = Number.parseFloat(normalized.replace(/px$/i, ""));
    return Number.isFinite(pixels) ? pixels : 0;
  };
  const backgroundPosition = (value, targetWidth, targetHeight, tileWidth, tileHeight, positionX, positionY) => {
    const tokens = String(value || "0% 0%").trim().split(/\\s+/).filter(Boolean);
    const xToken = positionX || tokens[0] || "0%";
    const yToken = positionY || tokens[1] || (tokens[0] === "center" ? "center" : "0%");
    // Four-token edge-offset positions (for example, right 12px bottom 8px)
    // are uncommon for data SVG backgrounds. Leave them at the CSS origin
    // rather than guessing an offset that could move a repeated pattern.
    if (!positionX && !positionY && tokens.length > 2) return { x: 0, y: 0 };
    return {
      x: backgroundPositionValue(xToken, targetWidth, tileWidth, "x"),
      y: backgroundPositionValue(yToken, targetHeight, tileHeight, "y")
    };
  };
  const backgroundRepeat = (paint) => {
    const shorthand = String(paint.backgroundRepeat || "repeat").trim().toLowerCase().split(/\\s+/).filter(Boolean);
    let repeatX = String(paint.backgroundRepeatX || "").trim().toLowerCase();
    let repeatY = String(paint.backgroundRepeatY || "").trim().toLowerCase();
    if (!repeatX || !repeatY) {
      if (shorthand[0] === "repeat-x") { repeatX = "repeat"; repeatY = "no-repeat"; }
      else if (shorthand[0] === "repeat-y") { repeatX = "no-repeat"; repeatY = "repeat"; }
      else {
        repeatX ||= shorthand[0] || "repeat";
        repeatY ||= shorthand[1] || shorthand[0] || "repeat";
      }
    }
    const supported = [repeatX, repeatY].every((value) => value === "repeat" || value === "no-repeat");
    return { x: repeatX === "repeat", y: repeatY === "repeat", supported };
  };
  const serializeSvgNode = (node) => {
    try { return typeof XMLSerializer === "function" ? new XMLSerializer().serializeToString(node) : node.outerHTML || ""; } catch (_) { return node.outerHTML || ""; }
  };
  const xmlAttribute = (value) => String(value).replace(/&/g, "&amp;").replace(/\"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const numberString = (value) => Number.isInteger(value) ? String(value) : String(Math.round(value * 1_000_000) / 1_000_000);
  const repeatedPositions = (target, tile, offset, repeats) => {
    if (!repeats) return [offset];
    const first = Math.floor((0 - offset) / tile);
    const last = Math.ceil((target - offset) / tile) - 1;
    const count = last - first + 1;
    if (count < 1 || count > 4096) return undefined;
    return Array.from({ length: count }, (_, index) => offset + (first + index) * tile);
  };
  const materializeSvgBackground = (paint, rect) => {
    const originalUrl = backgroundUrl(paint.backgroundImage);
    const sourceText = decodeSvgDataUrl(originalUrl);
    const targetWidth = positiveNumber(rect.width);
    const targetHeight = positiveNumber(rect.height);
    // A repeated background can multiply a large source SVG many times. Keep
    // this capture-side expansion bounded; the original asset remains a safe
    // fallback when materializing it would exceed the scene payload budget.
    if (!originalUrl || !sourceText || sourceText.length > 512 * 1024 || !targetWidth || !targetHeight || typeof DOMParser !== "function") return originalUrl;
    let sourceRoot;
    try { sourceRoot = new DOMParser().parseFromString(sourceText, "image/svg+xml").documentElement; } catch (_) { return originalUrl; }
    if (!sourceRoot || sourceRoot.tagName.toLowerCase() !== "svg") return originalUrl;
    const source = svgViewport(sourceRoot);
    if (!source) return originalUrl;
    const tile = backgroundTileSize(paint.backgroundSize, targetWidth, targetHeight, source.intrinsicWidth, source.intrinsicHeight);
    if (!tile || !tile.width || !tile.height) return originalUrl;
    const position = backgroundPosition(paint.backgroundPosition, targetWidth, targetHeight, tile.width, tile.height, paint.backgroundPositionX, paint.backgroundPositionY);
    const repeat = backgroundRepeat(paint);
    if (!repeat.supported) return originalUrl;
    const xPositions = repeatedPositions(targetWidth, tile.width, position.x, repeat.x);
    const yPositions = repeatedPositions(targetHeight, tile.height, position.y, repeat.y);
    if (!xPositions || !yPositions || xPositions.length * yPositions.length > 4096) return originalUrl;
    const rootAttributes = Array.from(sourceRoot.attributes || [])
      .filter((attribute) => !["xmlns", "xmlns:xlink", "width", "height", "viewbox"].includes(attribute.name.toLowerCase()))
      .map((attribute) => attribute.name + '=\"' + xmlAttribute(attribute.value) + '\"')
      .join(" ");
    const definitions = [];
    const styles = [];
    const drawing = [];
    for (const child of Array.from(sourceRoot.childNodes || [])) {
      if (child.nodeType !== 1) continue;
      const name = String(child.tagName || "").toLowerCase();
      if (name === "defs") definitions.push(serializeSvgNode(child));
      else if (name === "style") styles.push(serializeSvgNode(child));
      else if (!["title", "desc", "metadata"].includes(name)) drawing.push(serializeSvgNode(child));
    }
    if (!drawing.length) return originalUrl;
    const content = definitions.concat(styles).join("");
    const drawingText = drawing.join("");
    const groups = [];
    const scaleX = tile.width / source.width;
    const scaleY = tile.height / source.height;
    const groupCount = xPositions.length * yPositions.length;
    if (content.length + drawingText.length * groupCount > 4 * 1024 * 1024) return originalUrl;
    for (const y of yPositions) for (const x of xPositions) {
      groups.push('<g transform=\"translate(' + numberString(x) + ' ' + numberString(y) + ') scale(' + numberString(scaleX) + ' ' + numberString(scaleY) + ') translate(' + numberString(-source.x) + ' ' + numberString(-source.y) + ')\">' + drawingText + "</g>");
    }
    const attributes = 'xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"' + numberString(targetWidth) + '\" height=\"' + numberString(targetHeight) + '\" viewBox=\"0 0 ' + numberString(targetWidth) + ' ' + numberString(targetHeight) + '\"' + (rootAttributes ? " " + rootAttributes : "");
    return "data:image/svg+xml," + encodeURIComponent("<svg " + attributes + ">" + content + groups.join("") + "</svg>");
  };
  const transparent = (value) => {
    const normalized = String(value || "").replace(/\\s+/g, "").toLowerCase();
    return !normalized || normalized === "transparent" || normalized === "rgba(0,0,0,0)";
  };
  const BORDER_SIDES = ["top", "right", "bottom", "left"];
  const borderOf = (style, side) => {
    const property = "border" + side[0].toUpperCase() + side.slice(1);
    return { color: String(style[property + "Color"] || "transparent"), width: number(style[property + "Width"]), style: String(style[property + "Style"] || "none") };
  };
  const activeBorder = (border) => border.width > 0 && border.style !== "none" && border.style !== "hidden";
  const borderEntries = (paint) => paint.borders
    ? BORDER_SIDES.map((side) => [side, paint.borders[side]])
    : [["", { color: paint.borderColor, width: paint.borderWidth || 0, style: paint.borderStyle || "none" }]];
  const reportUnsupportedBorders = (paint, style, source) => {
    const entries = borderEntries(paint).filter(([, border]) => activeBorder(border));
    for (const [side, border] of entries) {
      const supported = border.style === "solid" || (!paint.borders && ["dashed", "dotted"].includes(border.style));
      if (supported) continue;
      diagnostics.push({ severity: "warning", code: "UNSUPPORTED_BORDER_STYLE", message: "The " + (side ? side + " " : "") + "border uses the unsupported CSS style " + border.style + "; that border was omitted.", viewportId: viewport.id, source });
    }
    if (paint.borders && entries.length && paint.radius.some((radius) => radius > 0)) {
      diagnostics.push({ severity: "warning", code: "UNSUPPORTED_BORDER_RADIUS", message: "Rounded corners with differing border sides cannot yet be reproduced as editable Penpot borders; the borders were omitted and the background retains its corner radii.", viewportId: viewport.id, source });
    }
    if (style.borderImageSource && style.borderImageSource !== "none") {
      diagnostics.push({ severity: "warning", code: "UNSUPPORTED_BORDER_IMAGE", message: "CSS border-image cannot yet be reproduced as editable Penpot borders; the border image was omitted and the ordinary CSS border fallback was preserved.", viewportId: viewport.id, source });
    }
  };
  const unsupportedModernColor = (value) => /(?:^|[\\s,(])(?:color|color-mix|lab|lch|oklab|oklch)\\(/i.test(String(value || ""));
  const reportUnsupportedColor = (field, value, source, message) => {
    if (!unsupportedModernColor(value)) return;
    const key = field + "\\n" + source + "\\n" + value;
    if (reportedDiagnostics.has(key)) return;
    reportedDiagnostics.add(key);
    diagnostics.push({ severity: "warning", code: "UNSUPPORTED_COLOR_FORMAT", message, viewportId: viewport.id, source });
  };
  const reportUnsupportedPaintColors = (paint, source) => {
    // Computed CSS colors normally arrive as sRGB rgb()/rgba() values. The
    // importer deliberately has a small, predictable parser, so preserve
    // fidelity by reporting CSS Color 4 values it cannot translate instead
    // of silently replacing a fill, shadow, or gradient stop.
    if (!transparent(paint.backgroundColor)) reportUnsupportedColor("background color", paint.backgroundColor, source, "The background color uses a CSS Color 4 format that this importer cannot represent; the affected fill was omitted rather than approximated.");
    for (const [side, border] of borderEntries(paint)) {
      if (!activeBorder(border)) continue;
      const field = (side ? side + " " : "") + "border color";
      reportUnsupportedColor(field, border.color, source, "The " + field + " uses a CSS Color 4 format that this importer cannot represent; the affected border was omitted rather than approximated.");
    }
    if (paint.boxShadow && paint.boxShadow !== "none") reportUnsupportedColor("box shadow", paint.boxShadow, source, "The box shadow uses a CSS Color 4 format that this importer cannot represent; the affected shadow was omitted rather than approximated.");
    // Do not inspect arbitrary image URLs: data payloads can contain color(
    // without being a CSS gradient or a color value.
    if (/^(?:linear|radial)-gradient\\(/i.test(String(paint.backgroundImage || "").trim())) reportUnsupportedColor("background gradient", paint.backgroundImage, source, "The background gradient uses a CSS Color 4 format that this importer cannot represent; the affected gradient was omitted rather than approximated.");
  };
  const reportUnsupportedTextColor = (value, source) => reportUnsupportedColor("text color", value, source, "The text color uses a CSS Color 4 format that this importer cannot represent; the affected text uses Penpot's default color.");
  // scroll and auto clip their content just as hidden does; only the
  // scrollbars and the ability to reach the hidden content differ, and a
  // snapshot import cannot reproduce scrolling either way.
  const clipsAxis = (value) => ["hidden", "clip", "scroll", "auto", "overlay"].includes(String(value || "visible").trim());
  const axisOverflow = (style, axis) => {
    const value = String(style["overflow" + axis] || "").trim();
    if (value) return value;
    // Fall back to the shorthand for engines that only report it. The first
    // shorthand value is the x axis; a single value applies to both.
    const shorthand = String(style.overflow || "").trim().split(/\s+/).filter(Boolean);
    return (axis === "X" ? shorthand[0] : shorthand[1] || shorthand[0]) || "visible";
  };
  const reportPartialOverflowClip = (paint, source) => {
    // A computed style can clip one axis only through overflow-x/y: clip,
    // because every other single-axis value forces the other axis to auto.
    // Penpot containers clip both axes together, so reproducing this would
    // hide content the browser shows.
    if (clipsAxis(paint.overflowX) === clipsAxis(paint.overflowY)) return;
    diagnostics.push({ severity: "warning", code: "UNSUPPORTED_OVERFLOW", message: "This element clips only one axis (overflow-x: " + paint.overflowX + "; overflow-y: " + paint.overflowY + "). Penpot containers clip both axes together, so the imported layer is left unclipped rather than hiding content the browser shows.", viewportId: viewport.id, source });
  };
  const unsupported = (element, style) => {
    if (["CANVAS", "VIDEO", "IFRAME", "OBJECT", "EMBED"].includes(element.tagName)) return element.tagName.toLowerCase() + " cannot be converted to editable layers";
    if (style.filter && style.filter !== "none") return "CSS filter needs a raster fallback";
    if (style.backdropFilter && style.backdropFilter !== "none") return "backdrop-filter needs a raster fallback";
    if (style.maskImage && style.maskImage !== "none") return "CSS mask needs a raster fallback";
    if (style.mixBlendMode && style.mixBlendMode !== "normal") return "CSS blend mode needs a raster fallback";
    return undefined;
  };
  const paintOf = (style) => {
    const overflowX = axisOverflow(style, "X");
    const overflowY = axisOverflow(style, "Y");
    const borders = Object.fromEntries(BORDER_SIDES.map((side) => [side, borderOf(style, side)]));
    const uniformBorder = BORDER_SIDES.every((side) => borders[side].color === borders.top.color && borders[side].width === borders.top.width && borders[side].style === borders.top.style);
    return {
      backgroundColor: style.backgroundColor,
      // Penpot has one image/gradient fill per imported source surface. CSS
      // paints its first background image on top, so preserve that layer and
      // report any lower layers during capture instead of letting a regex pick
      // an arbitrary URL from the entire shorthand.
      backgroundImage: backgroundLayers(style.backgroundImage)[0] || "none",
      backgroundRepeat: style.backgroundRepeat,
      backgroundRepeatX: style.backgroundRepeatX,
      backgroundRepeatY: style.backgroundRepeatY,
      backgroundSize: style.backgroundSize,
      backgroundPosition: style.backgroundPosition,
      backgroundPositionX: style.backgroundPositionX,
      backgroundPositionY: style.backgroundPositionY,
      color: style.color,
      borderColor: uniformBorder ? borders.top.color : undefined,
      borderWidth: uniformBorder ? borders.top.width : undefined,
      borderStyle: uniformBorder ? borders.top.style : undefined,
      borders: uniformBorder ? undefined : borders,
      radius: [number(style.borderTopLeftRadius), number(style.borderTopRightRadius), number(style.borderBottomRightRadius), number(style.borderBottomLeftRadius)],
      opacity: number(style.opacity || "1"),
      boxShadow: style.boxShadow,
      overflowX,
      overflowY,
      // Penpot clips a container on both axes together, so only a box that
      // clips both is reported as clipping. A single clipped axis is reported
      // as a diagnostic instead, because hiding content the browser shows is
      // worse than leaving the overflow visible.
      overflow: clipsAxis(overflowX) && clipsAxis(overflowY)
        ? (overflowX === "clip" && overflowY === "clip" ? "clip" : "hidden")
        : "visible"
    };
  };
  const paintOfElement = (element, style) => {
    const paint = paintOf(style);
    // The browser paints a transparent html/body pair against the default
    // white canvas. Penpot boards have their own default canvas color, so
    // leaving this as "no fill" makes an otherwise white page render black.
    // Carry the effective document background onto the top-level board while
    // preserving an explicitly colored body or html background.
    if (element === document.body && transparent(paint.backgroundColor) && paint.backgroundImage === "none") {
      const htmlStyle = styleOf(document.documentElement);
      paint.backgroundColor = transparent(htmlStyle.backgroundColor) ? "rgb(255, 255, 255)" : htmlStyle.backgroundColor;
      if (paint.backgroundImage === "none" && htmlStyle.backgroundImage !== "none") {
        const htmlPaint = paintOf(htmlStyle);
        paint.backgroundImage = htmlPaint.backgroundImage;
        paint.backgroundRepeat = htmlPaint.backgroundRepeat;
        paint.backgroundRepeatX = htmlPaint.backgroundRepeatX;
        paint.backgroundRepeatY = htmlPaint.backgroundRepeatY;
        paint.backgroundSize = htmlPaint.backgroundSize;
        paint.backgroundPosition = htmlPaint.backgroundPosition;
        paint.backgroundPositionX = htmlPaint.backgroundPositionX;
        paint.backgroundPositionY = htmlPaint.backgroundPositionY;
      }
    }
    return paint;
  };
  const layoutOf = (style) => {
    const direction = ["row", "row-reverse", "column", "column-reverse"].includes(style.flexDirection) ? style.flexDirection : undefined;
    const wrap = ["wrap", "nowrap"].includes(style.flexWrap) ? style.flexWrap : undefined;
    return {
      kind: style.display === "flex" || style.display === "inline-flex" ? "flex" : style.display === "grid" || style.display === "inline-grid" ? "grid" : "none",
      direction,
      wrap,
      justifyContent: style.justifyContent,
      alignItems: style.alignItems,
      rowGap: number(style.rowGap),
      columnGap: number(style.columnGap),
      padding: [number(style.paddingTop), number(style.paddingRight), number(style.paddingBottom), number(style.paddingLeft)],
      absolute: ["absolute", "fixed"].includes(style.position),
      // Match known positioned keywords positively: engines that report an
      // empty position for unstyled elements must read as non-positioned.
      positioned: ["relative", "absolute", "fixed", "sticky"].includes(style.position)
    };
  };
  const isDecorated = (style, paint) => !transparent(style.backgroundColor) || style.backgroundImage !== "none" || borderEntries(paint).some(([, border]) => activeBorder(border)) || Boolean(style.borderImageSource && style.borderImageSource !== "none") || style.boxShadow !== "none" || [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].some((value) => number(value) > 0);
  const lineHeightOf = (style, measuredLineHeight) => {
    const fontSize = Math.max(1, number(style.fontSize));
    // Penpot stores line height as a multiplier. The browser exposes a
    // measured line box in CSS pixels, so normalize it by the font size.
    if (measuredLineHeight) return measuredLineHeight / fontSize;
    if (style.lineHeight === "normal") return 1.2;
    if (String(style.lineHeight).endsWith("px")) return number(style.lineHeight) / fontSize;
    if (String(style.lineHeight).endsWith("%")) return number(style.lineHeight) / 100;
    return number(style.lineHeight) || 1.2;
  };
  const textStyleOf = (style, measuredLineHeight) => ({
    fontFamily: style.fontFamily,
    fontSize: number(style.fontSize),
    fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
    fontStyle: style.fontStyle,
    lineHeight: lineHeightOf(style, measuredLineHeight),
    letterSpacing: number(style.letterSpacing),
    textAlign: style.textAlign,
    textDecoration: style.textDecorationLine,
    textTransform: style.textTransform
  });
  const textMaxWidthOf = (containerRect, lineRect) => Math.max(0.1, Math.min(lineRect.width, containerRect.x + containerRect.width - lineRect.x) - 1);
  const textFitScaleOf = (containerRect, lineRect) => {
    // Capture preserves the browser's line breaks, but Penpot can still
    // render a captured line a little wider when its editable font metrics
    // differ. Keep the line inside the source element's right edge instead
    // of allowing it to paint over the next card or the board clip.
    const available = textMaxWidthOf(containerRect, lineRect);
    if (available <= 0 || lineRect.width <= available) return undefined;
    return Math.max(0.01, Math.min(1, available / lineRect.width));
  };
  const normalizeNewlines = (value) => String(value || "").replace(/\\r\\n?/g, "\\n");
  const whiteSpaceOf = (style) => String(style.whiteSpace || "normal").trim().toLowerCase() || "normal";
  const preservesNewlines = (whiteSpace) => ["pre", "pre-wrap", "pre-line", "break-spaces"].includes(whiteSpace);
  const preservesSpaces = (whiteSpace) => ["pre", "pre-wrap", "break-spaces"].includes(whiteSpace);
  const tabSizeOf = (style) => {
    const parsed = Number.parseInt(style.tabSize, 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 64) : 8;
  };
  let graphemeSegmenter;
  const textSegments = function* (text) {
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      graphemeSegmenter ||= new Intl.Segmenter(undefined, { granularity: "grapheme" });
      yield* graphemeSegmenter.segment(text);
    } else {
      // Code points still protect surrogate pairs on older browser engines.
      let index = 0;
      for (const segment of text) {
        yield { segment, index };
        index += segment.length;
      }
    }
  };
  const expandTabs = (line, tabSize) => {
    if (!line.includes("\\t")) return line;
    // Advance tabs to the next tab stop the way CSS does by default. Every
    // glyph counts as one column, which is exact for the fixture fonts.
    let column = 0;
    let expanded = "";
    for (const { segment } of textSegments(line)) {
      if (segment === "\\t") {
        const spaces = tabSize - (column % tabSize);
        expanded += " ".repeat(spaces);
        column += spaces;
      } else {
        expanded += segment;
        column += 1;
      }
    }
    return expanded;
  };
  // Collapse whitespace runs without touching nonbreaking spaces, which CSS
  // never collapses and Penpot must keep non-breaking.
  const collapseRun = (value) => String(value).replace(/[^\\S\\u00A0]+/g, " ");
  const trimCollapsibleEdges = (value) => String(value).replace(/^[^\\S\\u00A0]+|[^\\S\\u00A0]+$/g, "");
  // Process a run of text the way its computed white-space demands. Normal
  // collapsing matches the old compact() output exactly except that NBSP is
  // preserved; pre values keep spaces (with tabs expanded) and drop only the
  // edge newlines, which paint no glyphs and would misalign a single-line
  // layer in Penpot.
  const processSingleLine = (raw, whiteSpace, tabSize) => {
    const source = normalizeNewlines(raw);
    if (preservesSpaces(whiteSpace)) return expandTabs(source, tabSize).replace(/^\\n+|\\n+$/g, "").replace(/\\n/g, " ");
    return trimCollapsibleEdges(collapseRun(source));
  };
  const measureTextLayout = (textNodes, whiteSpace = "normal", tabSize = 8) => {
    const nodes = Array.isArray(textNodes) ? textNodes : [textNodes];
    const raw = nodes.map((node) => String(node.textContent || "")).join("");
    const keepLines = preservesNewlines(whiteSpace);
    const keepSpaces = preservesSpaces(whiteSpace);
    const fallback = processSingleLine(raw, whiteSpace, tabSize);
    const rects = [];
    const ranges = [];
    for (const node of nodes) {
      const text = String(node.textContent || "");
      const range = document.createRange();
      range.selectNodeContents(node);
      rects.push(...rangeRects(range));
      ranges.push({ node, text, range });
    }
    // A single-line text node needs no extra work. For wrapped text, preserve
    // the browser's line breaks so Penpot does not reflow it differently when
    // its available font metrics differ from the source browser.
    const lineTops = [...new Set(rects.map((rect) => Math.round(rect.top * 100) / 100))].sort((a, b) => a - b);
    const lineGaps = lineTops.slice(1).map((top, index) => top - lineTops[index]).filter((gap) => gap > 0.5);
    const measuredLineHeight = lineGaps.length
      ? lineGaps.reduce((sum, gap) => sum + gap, 0) / lineGaps.length
      : rects[0]?.height;
    const rectFor = (items) => {
      if (!items.length) return undefined;
      const left = Math.min(...items.map((item) => item.left));
      const top = Math.min(...items.map((item) => item.top));
      const right = Math.max(...items.map((item) => item.right));
      const bottom = Math.max(...items.map((item) => item.bottom));
      return rectOf({ x: left, y: top, width: right - left, height: bottom - top });
    };
    if (!rects.length) return { text: fallback, lines: [], rects, measuredLineHeight };
    if ((lineTops.length < 2 && !(keepLines && /[\\r\\n]/.test(raw))) || raw.length > 20_000) {
      return { text: fallback, lines: fallback ? [{ text: fallback, rect: rectFor(rects) }] : [], rects, measuredLineHeight };
    }
    // Only wrapped text needs detailed measurement. Stream complete
    // graphemes rather than retaining a rectangle per UTF-16 code unit.
    const characters = function* () {
      for (const { node, text, range } of ranges) {
        for (const { segment, index } of textSegments(text)) {
          range.setStart(node, index);
          range.setEnd(node, index + segment.length);
          yield { character: segment, rect: rangeBounds(range) };
        }
      }
    };
    // Preserve the browser's line breaks as separate, non-wrapping scene
    // nodes. Penpot can use different font metrics from the source browser;
    // one fixed text box per source line prevents those metrics from making
    // neighboring lines collide after import.
    const lines = [];
    let current = { top: undefined, text: "", rects: [] };
    let pendingSpace = false;
    const flush = () => {
      const text = keepSpaces ? expandTabs(current.text, tabSize) : current.text;
      if (text && current.rects.length) lines.push({ text, rect: rectFor(current.rects) });
    };
    for (const { character, rect } of characters()) {
      // An author newline starts a new line only where white-space preserves
      // it; elsewhere it collapses like any other whitespace run. Blank lines
      // need no layer of their own: neighbors stay at their measured places.
      if (/^[\\r\\n]+$/.test(character) && keepLines) {
        flush();
        current = { top: undefined, text: "", rects: [] };
        pendingSpace = false;
        continue;
      }
      const line = Math.round(rect.top * 100) / 100;
      if (current.top !== undefined && Math.abs(line - current.top) > 0.5) {
        flush();
        current = { top: line, text: "", rects: [] };
        pendingSpace = false;
      } else if (current.top === undefined) {
        current.top = line;
      }
      // A nonbreaking space is content, never a collapse or break opportunity.
      if (character.includes("\\u00A0")) {
        current.text += character;
        if (rect.width > 0 && rect.height > 0) current.rects.push(rect);
        pendingSpace = false;
        continue;
      }
      if (keepSpaces) {
        current.text += character;
        if (rect.width > 0 && rect.height > 0) current.rects.push(rect);
        continue;
      }
      if (/^\\s+$/.test(character)) {
        if (current.text) pendingSpace = true;
        continue;
      }
      if (pendingSpace) current.text += " ";
      current.text += character;
      current.rects.push(rect);
      pendingSpace = false;
    }
    flush();
    return { text: lines.map((line) => line.text).join("\\n") || fallback, lines, rects, measuredLineHeight };
  };
  const textLayout = (...args) => {
    if (!collectMetrics) return measureTextLayout(...args);
    const start = performance.now();
    try { return measureTextLayout(...args); } finally { metrics.textMeasurementMs += performance.now() - start; }
  };
  const svgMarkupOf = (element) => {
    const clone = element.cloneNode(true);
    if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    if (!clone.getAttribute("xmlns:xlink")) clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
    // Inline SVGs often get their paint from the page stylesheet (classes,
    // inherited color, or CSS variables). Penpot receives only the SVG
    // string, so carry the computed presentation values onto each descendant
    // before converting it to editable vectors.
    const presentationProperties = [
      "color", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width",
      "stroke-opacity", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit",
      "stroke-dasharray", "stroke-dashoffset", "clip-rule", "opacity", "visibility",
      "display", "stop-color", "stop-opacity", "paint-order", "vector-effect",
      "font-family", "font-size", "font-weight", "font-style", "text-anchor",
      "dominant-baseline"
    ];
    const originalElements = [element, ...element.querySelectorAll("*")];
    const clonedElements = [clone, ...clone.querySelectorAll("*")];
    for (let index = 0; index < Math.min(originalElements.length, clonedElements.length); index += 1) {
      const computed = styleOf(originalElements[index]);
      const target = clonedElements[index];
      for (const property of presentationProperties) {
        const value = computed.getPropertyValue(property);
        if (value) target.style.setProperty(property, value);
      }
    }
    return clone.outerHTML;
  };
  const appendText = (parent, textNode, style, textSource = parent.source + " ::text", measuredLayout, matrix = IDENTITY) => {
    // A text node inherits white-space (and tab size) from its parent chain,
    // so the passed-in element style is the correct processing context.
    const layout = measuredLayout || textLayout(Array.isArray(textNode) ? textNode : [textNode], whiteSpaceOf(style), tabSizeOf(style));
    if ((layout.lines || []).some((line) => line.text && line.rect)) reportUnsupportedTextColor(style.color, textSource);
    for (const line of (layout.lines || [])) {
      if (!line.text || !line.rect) continue;
      reserveNode();
      const id = "node-" + (++sequence);
      // The parent scene node carries the element's CSS opacity as a
      // compositing group. Applying it again to its synthetic text child
      // would incorrectly square the opacity.
      // A synthetic text run paints with its originating element's stacking
      // position: sibling order within the parent decides placement, so no
      // fractional offset is added that could push the run across a stacking
      // boundary (for example above an explicit positive z-index sibling).
      if (matrix !== IDENTITY) matrices.set(id, matrix);
      nodes.push({ id, parentId: parent.id, children: [], kind: "text", name: line.text.slice(0, 80), source: textSource, rect: line.rect, zIndex: parent.zIndex, zIndexAuto: parent.zIndexAuto, paint: { color: style.color, opacity: 1 }, layout: { kind: "none" }, text: line.text, textNoWrap: true, textFitScale: textFitScaleOf(parent.rect, line.rect), textMaxWidth: textMaxWidthOf(parent.rect, line.rect), textStyle: textStyleOf(style, layout.measuredLineHeight) });
      parent.children.push(id);
    }
  };
  // Generated content has no DOM box to measure, so it is measured by
  // briefly standing a real element with the pseudo-element's computed style
  // in its place. The generated box is hidden, the stand-in is inserted where
  // the pseudo-element generates (first or last child), it is read like any
  // other element, and every trace is removed before traversal continues.
  const PSEUDO_ATTRIBUTE = "data-html-to-penpot-pseudo";
  const PSEUDO_HOST_ATTRIBUTE = "data-html-to-penpot-pseudo-host";
  const NO_PSEUDO_TAGS = ["img", "input", "select", "textarea", "br", "hr", "video", "canvas", "iframe", "embed", "object", "audio", "svg"];
  // Computed content is a list of strings and keywords or functions. Strings
  // become text; anything else (counters, images, quotes) is reported.
  const pseudoContent = (value) => {
    const source = String(value || "").trim();
    let text = "";
    let unsupportedToken = "";
    let index = 0;
    while (index < source.length) {
      const character = source[index];
      if (/\\s/.test(character)) { index += 1; continue; }
      // Anything after "/" is alternative text for assistive technology.
      if (character === "/") break;
      if (character === '"' || character === "'") {
        index += 1;
        while (index < source.length && source[index] !== character) {
          if (source[index] === "\\\\" && index + 1 < source.length) {
            const hex = /^[0-9a-fA-F]{1,6}/.exec(source.slice(index + 1, index + 7));
            if (hex) {
              const codePoint = parseInt(hex[0], 16);
              text += codePoint > 0 && codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : "\\uFFFD";
              index += 1 + hex[0].length;
              if (/\\s/.test(source[index] || "")) index += 1;
              continue;
            }
            index += 1;
          }
          text += source[index];
          index += 1;
        }
        index += 1;
        continue;
      }
      let end = index;
      let depth = 0;
      let quote = "";
      for (; end < source.length; end += 1) {
        const next = source[end];
        if (quote) {
          if (next === "\\\\") end += 1;
          else if (next === quote) quote = "";
          continue;
        }
        if (next === '"' || next === "'") quote = next;
        else if (next === "(") depth += 1;
        else if (next === ")") depth -= 1;
        else if (depth <= 0 && /\\s/.test(next)) break;
      }
      unsupportedToken ||= source.slice(index, end);
      index = end;
    }
    return { text, unsupportedToken };
  };
  // Decide, without touching the DOM, whether a pseudo-element paints anything
  // this importer can place: generated text, or a decorated box.
  const planPseudo = (element, pseudo) => {
    if (NO_PSEUDO_TAGS.includes(element.tagName.toLowerCase())) return undefined;
    const style = styleOf(element, pseudo);
    const raw = String(style.content || "").trim();
    if (!raw || raw === "none" || raw === "normal" || style.display === "none" || style.visibility === "hidden" || number(style.opacity) === 0) return undefined;
    const content = pseudoContent(raw);
    const whiteSpace = whiteSpaceOf(style);
    const tabSize = tabSizeOf(style);
    const text = processSingleLine(content.text, whiteSpace, tabSize) ? content.text : "";
    const paint = paintOf(style);
    const decorated = isDecorated(style, paint);
    if (!text && !decorated && !content.unsupportedToken) return undefined;
    return { pseudo, style, content, text, whiteSpace, tabSize, paint, decorated, paints: Boolean(text) || decorated };
  };
  const measurePseudo = (element, plan, neutralized) => {
    const marker = document.createElement("span");
    marker.setAttribute(PSEUDO_ATTRIBUTE, plan.pseudo);
    // Computed styles list longhand properties by index; their cssText is
    // empty in Chrome, so each value is copied across individually.
    for (let index = 0; index < plan.style.length; index += 1) {
      const property = plan.style[index];
      marker.style.setProperty(property, plan.style.getPropertyValue(property), plan.style.getPropertyPriority(property));
    }
    // The generated text is the stand-in's own child, and a stand-in must not
    // animate or recurse into generated content of its own.
    for (const [property, value] of [["content", "normal"], ["animation", "none"], ["transition", "none"]]) marker.style.setProperty(property, value, "important");
    if (neutralized) neutralize(marker);
    const textNode = plan.text ? document.createTextNode(plan.content.text) : undefined;
    if (textNode) marker.appendChild(textNode);
    // Repeating the attribute raises specificity above any author rule that
    // generates the real pseudo-element.
    const hide = document.createElement("style");
    hide.textContent = ("[" + PSEUDO_HOST_ATTRIBUTE + "]").repeat(4) + plan.pseudo + "{content:none!important}";
    try {
      element.setAttribute(PSEUDO_HOST_ATTRIBUTE, "");
      (document.head || document.documentElement).appendChild(hide);
      if (plan.pseudo === "::before") element.insertBefore(marker, element.firstChild);
      else element.appendChild(marker);
      const rect = boundsOf(marker);
      const layout = textNode ? textLayout([textNode], plan.whiteSpace, plan.tabSize) : undefined;
      return { rect, layout, hostRect: boundsOf(element) };
    } finally {
      marker.remove();
      hide.remove();
      element.removeAttribute(PSEUDO_HOST_ATTRIBUTE);
    }
  };
  // Planned content is reported even when nothing else about the pseudo-element
  // paints, so a dropped counter or image is never silent.
  const planPseudos = (element, hostSource) => {
    const plans = ["::before", "::after"].map((pseudo) => planPseudo(element, pseudo)).filter(Boolean);
    for (const plan of plans) {
      if (plan.content.unsupportedToken) diagnostics.push({ severity: "warning", code: "UNSUPPORTED_PSEUDO_CONTENT", message: "The " + plan.pseudo + " content " + plan.content.unsupportedToken + " (counters, images, quotes and similar) cannot be imported as text; only its string content and box were imported.", viewportId: viewport.id, source: hostSource + " " + plan.pseudo });
    }
    return plans.filter((plan) => plan.paints);
  };
  const capturePseudo = (element, plan, host, hostSource, hostRect, hostMatrix) => {
    const { pseudo, style } = plan;
    const source = hostSource + " " + pseudo;
    const transform = transformable(element, style) ? readTransform(style) : undefined;
    // A transform that collapses the box to a line or point hides it entirely.
    if (transform?.flat && isDegenerate(transform.matrix)) return;
    const exact = Boolean(transform?.flat) && isSimilarity(transform.matrix);
    const measured = measurePseudo(element, plan, exact);
    const box = measured.rect;
    const lines = (measured.layout?.lines || []).filter((line) => line.text && line.rect);
    const drawsBox = plan.decorated && box.width > 0 && box.height > 0;
    if (!lines.length && !drawsBox) return;
    // The stand-in replaces the real pseudo-element for one measurement. If
    // that moved its host, selectors such as :empty or :first-child reacted to
    // it, and the measured geometry may differ from the browser's.
    if (["x", "y", "width", "height"].some((key) => Math.abs(measured.hostRect[key] - hostRect[key]) > 1)) {
      diagnostics.push({ severity: "warning", code: "PSEUDO_ELEMENT_GEOMETRY_UNVERIFIED", message: "Measuring the " + pseudo + " box moved its host element, so the pseudo-element's position may not match the browser exactly.", viewportId: viewport.id, source });
    }
    if (transform && !exact) {
      diagnostics.push({ severity: "warning", code: "UNSUPPORTED_TRANSFORM", message: "This pseudo-element's transform (skew, flip, non-uniform scale, or 3D) cannot be imported as a Penpot rotation, so it keeps the bounds of the transformed box without rotation.", viewportId: viewport.id, source });
    }
    let matrix = hostMatrix;
    if (exact) {
      if (transform.percent) transform.matrix = compose([1, 0, 0, 1, box.width * transform.percent[0] / 100, box.height * transform.percent[1] / 100], transform.matrix);
      matrix = compose(hostMatrix, aboutOrigin(transform, box));
    }
    const parsedZIndex = Number.parseInt(style.zIndex, 10);
    const zIndexAuto = !Number.isFinite(parsedZIndex);
    const stacking = { zIndex: zIndexAuto ? 0 : parsedZIndex, zIndexAuto };
    const reason = unsupported(element, style);
    reserveNode();
    const id = "node-" + (++sequence);
    if (matrix !== IDENTITY) matrices.set(id, matrix);
    // Plain generated text with no box of its own is one text layer, like an
    // undecorated element's text. Anything else keeps its box as a container
    // so its fill, border, and clip stay behind the text lines.
    if (!plan.decorated && !reason && lines.length === 1) {
      reportUnsupportedTextColor(style.color, source);
      const line = lines[0];
      const node = { id, parentId: host.id, children: [], kind: "text", name: pseudo, source, rect: line.rect, ...stacking, paint: { color: style.color, opacity: number(style.opacity || "1") }, layout: layoutOf(style), text: line.text, textNoWrap: true, textFitScale: textFitScaleOf(box, line.rect), textMaxWidth: textMaxWidthOf(box, line.rect), textStyle: { ...textStyleOf(style, measured.layout.measuredLineHeight), textAlign: "left" } };
      nodes.push(node);
      nodeById.set(id, node);
      host.children.push(id);
      return;
    }
    reportUnsupportedPaintColors(plan.paint, source);
    reportUnsupportedBorders(plan.paint, style, source);
    reportPartialOverflowClip(plan.paint, source);
    const backgroundLayerCount = backgroundLayers(style.backgroundImage).filter((layer) => layer !== "none").length;
    if (backgroundLayerCount > 1) {
      diagnostics.push({ severity: "warning", code: "MULTIPLE_BACKGROUND_LAYERS", message: "Only the topmost of " + backgroundLayerCount + " CSS background layers was imported; lower layers were omitted.", viewportId: viewport.id, source });
    }
    const node = { id, parentId: host.id, children: [], kind: reason ? "fallback" : lines.length ? "container" : "box", name: pseudo, source, rect: rectOf(box), ...stacking, paint: plan.paint, layout: layoutOf(style), assetId: asset(materializeSvgBackground(plan.paint, box)), fallbackReason: reason };
    nodes.push(node);
    nodeById.set(id, node);
    host.children.push(id);
    if (reason) {
      diagnostics.push({ severity: "warning", code: "UNSUPPORTED_SUBTREE", message: reason, viewportId: viewport.id, source });
      return;
    }
    if (lines.length) appendText(node, undefined, style, source, measured.layout, matrix);
  };
  const visit = (element, parentId, inlineControlAncestor = false, parentMatrix = IDENTITY) => {
    const tag = element.tagName.toLowerCase();
    // A line break is represented by the source line coordinates above, not
    // by a visible rectangle in the Penpot layer tree.
    if (tag === "br") return;
    const style = styleOf(element);
    // A wrapper can have no box of its own (for example display: contents), or a
    // zero-size element with visible overflow) while its descendants paint.
    // Visibility can also be restored by a descendant. Only properties
    // that suppress the whole compositing subtree let us stop traversal.
    if (suppressesSubtree(style)) return;
    const transform = transformable(element, style) ? readTransform(style) : undefined;
    // A transform that collapses the element to a line or point hides its whole subtree.
    if (transform?.flat && isDegenerate(transform.matrix)) return;
    const exact = Boolean(transform?.flat) && isSimilarity(transform.matrix);
    // Read the layout box with this element's own transform removed. A transform
    // that cannot become a Penpot rotation stays in place, so the element and its
    // descendants keep the transformed bounding boxes the browser reports.
    if (exact) neutralize(element);
    const rect = boundsOf(element);
    if (exact && transform.percent) transform.matrix = compose([1, 0, 0, 1, rect.width * transform.percent[0] / 100, rect.height * transform.percent[1] / 100], transform.matrix);
    const matrix = exact ? compose(parentMatrix, aboutOrigin(transform, rect)) : parentMatrix;
    if (transform && !exact) {
      diagnostics.push({ severity: "warning", code: "UNSUPPORTED_TRANSFORM", message: "This element's transform (skew, flip, non-uniform scale, or 3D) cannot be imported as a Penpot rotation, so it keeps the bounds of the transformed element without rotation.", viewportId: viewport.id, source: sourceOf(element) });
    }
    if (!visible(element, style, rect)) {
      const survivingParent = parentId ? nodeById.get(parentId) : undefined;
      const wrapperSource = sourceOf(element);
      const textSource = wrapperSource + " ::text";
      // An omitted wrapper can still generate content (an empty icon element
      // whose ::before is positioned, for example); it joins the surviving
      // ancestor in source order around the wrapper's own children.
      const wrapperPlans = survivingParent ? planPseudos(element, wrapperSource) : [];
      const generated = (pseudo) => {
        const plan = wrapperPlans.find((candidate) => candidate.pseudo === pseudo);
        if (plan) capturePseudo(element, plan, survivingParent, wrapperSource, rect, matrix);
      };
      generated("::before");
      for (const child of element.childNodes) {
        if (child.nodeType === Node.TEXT_NODE && style.visibility !== "hidden" && survivingParent) appendText(survivingParent, child, style, textSource, undefined, matrix);
        if (child.nodeType === Node.ELEMENT_NODE) visit(child, parentId, inlineControlAncestor, matrix);
      }
      generated("::after");
      return parentId;
    }
    const source = sourceOf(element);
    const reason = unsupported(element, style);
    const id = "node-" + (++sequence);
    const elementWhiteSpace = whiteSpaceOf(style);
    const elementTabSize = tabSizeOf(style);
    const hasDirectText = (child) => child.nodeType === Node.TEXT_NODE && processSingleLine(child.textContent, elementWhiteSpace, elementTabSize);
    const directText = [...element.childNodes].some(hasDirectText);
    // Penpot's fixed text layers wrap when the fallback font is a little
    // wider than the browser's font. Links and buttons are inline controls in
    // this capture model, so preserve their source browser line as one line.
    const inlineControl = inlineControlAncestor || tag === "a" || tag === "button";
    const textNoWrap = directText && (style.whiteSpace === "nowrap" || inlineControl);
    // Include wrappers which do not have their own box: they may still carry
    // visible descendants and therefore require this node to remain a parent
    // container rather than collapsing into a text-only layer.
    const childElements = [...element.children].filter((child) => !suppressesSubtree(styleOf(child)));
    // Use the effective paint here rather than the body's raw computed style:
    // a transparent body inherits the html element's visible page background.
    const paint = paintOfElement(element, style);
    reportUnsupportedPaintColors(paint, source);
    reportUnsupportedBorders(paint, style, source);
    reportPartialOverflowClip(paint, source);
    const rawBackgroundImage = element === document.body && transparent(style.backgroundColor) && style.backgroundImage === "none"
      ? styleOf(document.documentElement).backgroundImage
      : style.backgroundImage;
    const visibleBackgroundLayers = backgroundLayers(rawBackgroundImage).filter((layer) => layer !== "none");
    const imageUrl = tag === "img" ? element.currentSrc || element.src : materializeSvgBackground(paint, rect);
    const imageAsset = asset(imageUrl, tag === "img" ? element.currentSrc?.split(".").pop() : undefined);
    // A text-only node cannot carry fills, borders, or radii, so any element
    // with direct text and visible decoration keeps those surfaces by becoming
    // a container with the text as a child layer.
    const decorated = isDecorated(style, paint);
    // Generated content becomes child layers, so a host that has any must be a
    // container even when it would otherwise be a text layer or an empty box.
    const pseudoPlans = reason ? [] : planPseudos(element, source);
    const kind = reason ? "fallback" : tag === "img" ? "image" : tag === "svg" ? "svg" : directText && childElements.length === 0 && !decorated && !pseudoPlans.length ? "text" : (style.display === "flex" || style.display === "grid" || childElements.length > 0 || directText || pseudoPlans.length ? "container" : "box");
    // Preserve z-index: auto separately from numeric zero instead of
    // substituting traversal sequence for either. Automatic stacking paints
    // at the zero position for positioned elements, so store 0 with the auto
    // flag; an explicit zero keeps its value without the flag.
    const parsedZIndex = Number.parseInt(style.zIndex, 10);
    const zIndexAuto = !Number.isFinite(parsedZIndex);
    const scene = { id, parentId, children: [], kind, name: nameOf(element), source, rect: rectOf(rect), zIndex: zIndexAuto ? 0 : parsedZIndex, zIndexAuto, paint, layout: layoutOf(style), assetId: imageAsset, image: kind === "image" && imageAsset ? imageOf(element, style, source) : undefined, fallbackReason: reason, textNoWrap };
    let directTextNodes = [];
    let directTextLayout;
    let expandedDirectText = false;
    if (kind === "text") {
      // Combine every direct text run: text separated by comments or other
      // non-rendered nodes belongs to the same content. The runs are measured
      // individually and their raw contents processed together, so spacing
      // across run boundaries collapses exactly as CSS renders it.
      directTextNodes = [...element.childNodes].filter(hasDirectText);
      directTextLayout = directTextNodes.length ? textLayout(directTextNodes, elementWhiteSpace, elementTabSize) : undefined;
      if (directTextLayout?.lines?.length > 1) {
        scene.kind = "container";
        scene.text = undefined;
        scene.textStyle = undefined;
        expandedDirectText = true;
      } else {
        scene.text = directTextLayout?.text || processSingleLine(element.textContent, elementWhiteSpace, elementTabSize);
        scene.textStyle = textStyleOf(style, directTextLayout?.measuredLineHeight);
        // Keep every captured single-line text layer from being rewrapped by
        // Penpot's fixed text box when its font metrics differ from the page.
        scene.textNoWrap = Boolean(scene.text);
        const line = directTextLayout?.lines?.[0];
        if (line?.rect) {
          scene.textFitScale = textFitScaleOf(scene.rect, line.rect);
          scene.textMaxWidth = textMaxWidthOf(scene.rect, line.rect);
          // Use the glyph line's position, not the enclosing element's box
          // (which includes padding and text-align offsets).
          scene.rect = line.rect;
          scene.textStyle.textAlign = "left";
        }
        if (scene.text && (directTextLayout?.lines || []).some((line) => line.text && line.rect)) reportUnsupportedTextColor(style.color, source + " ::text");
      }
    }
    if (tag === "svg") { scene.assetId = asset("data:image/svg+xml," + encodeURIComponent(svgMarkupOf(element)), "image/svg+xml"); }
    reserveNode();
    if (matrix !== IDENTITY) matrices.set(id, matrix);
    nodes.push(scene);
    nodeById.set(id, scene);
    if (parentId) nodeById.get(parentId)?.children.push(id);
    if (reason) {
      diagnostics.push({ severity: "warning", code: "UNSUPPORTED_SUBTREE", message: reason, viewportId: viewport.id, source });
      return id;
    }
    if (visibleBackgroundLayers.length > 1) {
      diagnostics.push({ severity: "warning", code: "MULTIPLE_BACKGROUND_LAYERS", message: "Only the topmost of " + visibleBackgroundLayers.length + " CSS background layers was imported; lower layers were omitted.", viewportId: viewport.id, source });
    }
    // The serialized SVG already contains the complete subtree. Traversing
    // its paths and groups again would create duplicate rectangle layers and
    // can visibly distort the imported vector when the host conversion also
    // succeeds.
    if (tag === "svg") return id;
    const beforePlan = pseudoPlans.find((plan) => plan.pseudo === "::before");
    if (beforePlan) capturePseudo(element, beforePlan, scene, source, rect, matrix);
    if (expandedDirectText) appendText(scene, directTextNodes, style, source + " ::text", directTextLayout, matrix);
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE && kind !== "text") appendText(scene, child, style, source + " ::text", undefined, matrix);
      if (child.nodeType === Node.ELEMENT_NODE) visit(child, id, inlineControl, matrix);
    }
    const afterPlan = pseudoPlans.find((plan) => plan.pseudo === "::after");
    if (afterPlan) capturePseudo(element, afterPlan, scene, source, rect, matrix);
    return id;
  };
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const settleWithin = async (work, maximumWait) => {
    try { await Promise.race([work, wait(maximumWait)]); } catch (_) {}
  };
  const waitForDomSettle = async () => {
    const root = document.body || document.documentElement;
    if (!root || typeof MutationObserver === "undefined") return;
    await new Promise((resolve) => {
      let finished = false;
      let quietTimer;
      const observer = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(done, 180);
      });
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(quietTimer);
        clearTimeout(maximumTimer);
        observer.disconnect();
        resolve(undefined);
      };
      const maximumTimer = setTimeout(done, 4_000);
      observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
      quietTimer = setTimeout(done, 180);
    });
  };
  const settle = async () => {
    // A remote font or image is allowed to be slow, but must never prevent a
    // useful capture. This is deliberately shorter than the outer watchdog.
    await settleWithin(document.fonts?.ready || Promise.resolve(), 3_000);
    await settleWithin(Promise.all([...document.images].map((image) => image.decode?.().catch(() => undefined))), 3_000);
    // Hidden/offscreen plugin windows can throttle rAF indefinitely; a short
    // timer still gives styles and layout a chance to flush.
    await wait(32);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    // Client-rendered pages often finish their first DOM update after the
    // initial HTML has parsed. Wait for a brief quiet period, with a hard cap,
    // so those updates are captured without allowing a page to hang forever.
    await waitForDomSettle();
  };
  settle().then(() => {
    try {
      const extractionStart = performance.now();
      if (collectMetrics) metrics.settleMs = extractionStart - startedAt;
      const root = document.body || document.documentElement;
      const documentWidth = Math.max(document.documentElement.scrollWidth, viewport.width);
      const documentHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0, viewport.height);
      if (documentWidth > limits.maxWidth) throw new Error("Capture stopped before import: " + viewport.name + " is " + Math.round(documentWidth).toLocaleString() + "px wide, above the " + limits.maxWidth.toLocaleString() + "px limit. Reduce the page width or choose a smaller viewport.");
      if (documentHeight > limits.maxHeight) throw new Error("Capture stopped before import: " + viewport.name + " is " + Math.round(documentHeight).toLocaleString() + "px tall, above the " + limits.maxHeight.toLocaleString() + "px limit. Reduce the page height or split it into smaller imports.");
      visit(root, undefined);
      // Layout rects stay in untransformed space during traversal so measurements
      // such as a text line's width compare like with like; place frames last.
      for (const node of nodes) {
        const matrix = matrices.get(node.id);
        if (matrix) placeNode(node, matrix);
      }
      if (scriptsDisabled) {
        diagnostics.push({
          severity: "warning",
          code: "SCRIPTS_DISABLED",
          message: "Page scripts were disabled; dynamic content or JavaScript-controlled layout may not match. Enable Run trusted page scripts for a source you trust if needed.",
          viewportId: viewport.id,
          source: "script"
        });
      }
      if (nodes.length <= 1) {
        diagnostics.push({
          severity: "warning",
          code: "EMPTY_CAPTURE",
          message: scriptsDisabled
            ? "No visible page content was captured. This page contains JavaScript-rendered content, but its scripts were disabled; enable Run trusted page scripts for source you trust or paste rendered HTML."
            : "No visible page content was captured. The page may require more settle time or may render content outside the supported HTML surface.",
          viewportId: viewport.id,
          source: "body"
        });
      }
      if (collectMetrics) {
        metrics.nodeCount = nodes.length;
        metrics.assetCount = assets.size;
        metrics.extractionMs = performance.now() - extractionStart;
      }
      parent.postMessage({ type: "CAPTURE_RESULT", token, ...(collectMetrics ? { metrics } : {}), scene: { protocolVersion: ${PROTOCOL_VERSION}, viewport, documentSize: { width: documentWidth, height: documentHeight }, nodes, assets: [...assets.values()], diagnostics } }, "*");
    } catch (error) {
      parent.postMessage({ type: "CAPTURE_ERROR", token, message: error instanceof Error ? error.message : String(error) }, "*");
    }
  });
})();`;
}
