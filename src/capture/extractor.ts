import { PROTOCOL_VERSION, type ViewportSpec } from "../shared/contracts";

/** A self-contained script run inside the opaque, sandboxed document. */
export function buildExtractorScript(token: string, viewport: ViewportSpec, settleDelayMs: number): string {
  const encodedViewport = JSON.stringify(viewport);
  return `
(() => {
  const token = ${JSON.stringify(token)};
  const viewport = ${encodedViewport};
  const delay = ${Math.max(0, Math.min(settleDelayMs, 10_000))};
  const scriptsDisabled = document.documentElement.getAttribute("data-html-to-penpot-scripts-disabled");
  const diagnostics = [];
  const assets = new Map();
  const nodes = [];
  const nodeById = new Map();
  const reportedDiagnostics = new Set();
  let sequence = 0;

  const number = (value) => { const parsed = parseFloat(value || "0"); return Number.isFinite(parsed) ? parsed : 0; };
  const compact = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const rectOf = (rect) => ({ x: Math.round(rect.x * 100) / 100, y: Math.round(rect.y * 100) / 100, width: Math.round(rect.width * 100) / 100, height: Math.round(rect.height * 100) / 100 });
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
  const asset = (url, hint) => {
    if (!url || url === "none" || url.startsWith("linear-gradient") || url.startsWith("radial-gradient")) return undefined;
    const existing = assets.get(url);
    if (existing) return existing.id;
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
    if (paint.borderWidth > 0 && paint.borderStyle !== "none") reportUnsupportedColor("border color", paint.borderColor, source, "The border color uses a CSS Color 4 format that this importer cannot represent; the affected border was omitted rather than approximated.");
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
      borderColor: style.borderTopColor,
      borderWidth: number(style.borderTopWidth),
      borderStyle: style.borderTopStyle,
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
        : "visible",
      transform: style.transform
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
      const htmlStyle = getComputedStyle(document.documentElement);
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
  const layoutOf = (style) => ({
    kind: style.display === "flex" || style.display === "inline-flex" ? "flex" : style.display === "grid" || style.display === "inline-grid" ? "grid" : "none",
    direction: style.flexDirection,
    wrap: style.flexWrap,
    justifyContent: style.justifyContent,
    alignItems: style.alignItems,
    rowGap: number(style.rowGap),
    columnGap: number(style.columnGap),
    padding: [number(style.paddingTop), number(style.paddingRight), number(style.paddingBottom), number(style.paddingLeft)],
    absolute: ["absolute", "fixed"].includes(style.position)
  });
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
  const textLayout = (textNode) => {
    const raw = String(textNode.textContent || "");
    const fallback = compact(raw);
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const rects = [...range.getClientRects()];
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
    if (rects.length < 2 || raw.length > 20_000) {
      return { text: fallback, lines: fallback ? [{ text: fallback, rect: rectFor(rects) }] : [], rects, measuredLineHeight };
    }
    // Preserve the browser's line breaks as separate, non-wrapping scene
    // nodes. Penpot can use different font metrics from the source browser;
    // one fixed text box per source line prevents those metrics from making
    // neighboring lines collide after import.
    const lines = [];
    let current = { top: undefined, text: "", rects: [] };
    let pendingSpace = false;
    const flush = () => {
      if (current.text) lines.push({ text: current.text, rect: rectFor(current.rects) });
    };
    for (let index = 0; index < raw.length; index += 1) {
      range.setStart(textNode, index);
      range.setEnd(textNode, index + 1);
      const characterRect = range.getBoundingClientRect();
      const character = raw[index];
      const line = Math.round(characterRect.top * 100) / 100;
      if (current.top !== undefined && Math.abs(line - current.top) > 0.5) {
        flush();
        current = { top: line, text: "", rects: [] };
        pendingSpace = false;
      } else if (current.top === undefined) {
        current.top = line;
      }
      if (/\\s/.test(character)) {
        if (current.text) pendingSpace = true;
        continue;
      }
      if (pendingSpace) current.text += " ";
      current.text += character;
      current.rects.push(characterRect);
      pendingSpace = false;
    }
    flush();
    return { text: lines.map((line) => line.text).join("\\n") || fallback, lines, rects, measuredLineHeight };
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
      const computed = getComputedStyle(originalElements[index]);
      const target = clonedElements[index];
      for (const property of presentationProperties) {
        const value = computed.getPropertyValue(property);
        if (value) target.style.setProperty(property, value);
      }
    }
    return clone.outerHTML;
  };
  const appendText = (parent, textNode, style, textSource = parent.source + " ::text") => {
    const layout = textLayout(textNode);
    if ((layout.lines || []).some((line) => line.text && line.rect)) reportUnsupportedTextColor(style.color, textSource);
    for (const [index, line] of (layout.lines || []).entries()) {
      if (!line.text || !line.rect) continue;
      const id = "node-" + (++sequence);
      // The parent scene node carries the element's CSS opacity as a
      // compositing group. Applying it again to its synthetic text child
      // would incorrectly square the opacity.
      nodes.push({ id, parentId: parent.id, children: [], kind: "text", name: line.text.slice(0, 80), source: textSource, rect: line.rect, zIndex: parent.zIndex + 0.01 + index / 10_000, paint: { color: style.color, opacity: 1 }, layout: { kind: "none" }, text: line.text, textNoWrap: true, textFitScale: textFitScaleOf(parent.rect, line.rect), textMaxWidth: textMaxWidthOf(parent.rect, line.rect), textStyle: textStyleOf(style, layout.measuredLineHeight) });
      parent.children.push(id);
    }
  };
  const visit = (element, parentId, inlineControlAncestor = false) => {
    const tag = element.tagName.toLowerCase();
    // A line break is represented by the source line coordinates above, not
    // by a visible rectangle in the Penpot layer tree.
    if (tag === "br") return;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    // A wrapper can have no box of its own (for example display: contents), or a
    // zero-size element with visible overflow) while its descendants paint.
    // Visibility can also be restored by a descendant. Only properties
    // that suppress the whole compositing subtree let us stop traversal.
    if (suppressesSubtree(style)) return;
    if (!visible(element, style, rect)) {
      const survivingParent = parentId ? nodeById.get(parentId) : undefined;
      const textSource = sourceOf(element) + " ::text";
      for (const child of element.childNodes) {
        if (child.nodeType === Node.TEXT_NODE && style.visibility !== "hidden" && survivingParent) appendText(survivingParent, child, style, textSource);
        if (child.nodeType === Node.ELEMENT_NODE) visit(child, parentId, inlineControlAncestor);
      }
      return parentId;
    }
    const source = sourceOf(element);
    const reason = unsupported(element, style);
    const id = "node-" + (++sequence);
    const directText = [...element.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && compact(child.textContent));
    // Penpot's fixed text layers wrap when the fallback font is a little
    // wider than the browser's font. Links and buttons are inline controls in
    // this capture model, so preserve their source browser line as one line.
    const inlineControl = inlineControlAncestor || tag === "a" || tag === "button";
    const textNoWrap = directText && (style.whiteSpace === "nowrap" || inlineControl);
    // Include wrappers which do not have their own box: they may still carry
    // visible descendants and therefore require this node to remain a parent
    // container rather than collapsing into a text-only layer.
    const childElements = [...element.children].filter((child) => !suppressesSubtree(getComputedStyle(child)));
    // Use the effective paint here rather than the body's raw computed style:
    // a transparent body inherits the html element's visible page background.
    const paint = paintOfElement(element, style);
    reportUnsupportedPaintColors(paint, source);
    reportPartialOverflowClip(paint, source);
    const rawBackgroundImage = element === document.body && transparent(style.backgroundColor) && style.backgroundImage === "none"
      ? getComputedStyle(document.documentElement).backgroundImage
      : style.backgroundImage;
    const visibleBackgroundLayers = backgroundLayers(rawBackgroundImage).filter((layer) => layer !== "none");
    const imageUrl = tag === "img" ? element.currentSrc || element.src : materializeSvgBackground(paint, rect);
    const imageAsset = asset(imageUrl, tag === "img" ? element.currentSrc?.split(".").pop() : undefined);
    // A text-only node cannot carry fills, borders, or radii, so any element
    // with direct text and visible decoration keeps those surfaces by becoming
    // a container with the text as a child layer.
    const decorated = !transparent(style.backgroundColor) || style.backgroundImage !== "none" || (style.borderTopStyle !== "none" && number(style.borderTopWidth) > 0) || style.boxShadow !== "none" || [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].some((value) => number(value) > 0);
    const kind = reason ? "fallback" : tag === "img" ? "image" : tag === "svg" ? "svg" : directText && childElements.length === 0 && !decorated ? "text" : (style.display === "flex" || style.display === "grid" || childElements.length > 0 || directText ? "container" : "box");
    const scene = { id, parentId, children: [], kind, name: nameOf(element), source, rect: rectOf(rect), zIndex: Number.parseInt(style.zIndex, 10) || sequence, paint, layout: layoutOf(style), assetId: imageAsset, fallbackReason: reason, textNoWrap };
    let directTextNode;
    let directTextLayout;
    let expandedDirectText = false;
    if (kind === "text") {
      directTextNode = [...element.childNodes].find((child) => child.nodeType === Node.TEXT_NODE && compact(child.textContent));
      directTextLayout = directTextNode ? textLayout(directTextNode) : undefined;
      if (directTextLayout?.lines?.length > 1) {
        scene.kind = "container";
        scene.text = undefined;
        scene.textStyle = undefined;
        expandedDirectText = true;
      } else {
        scene.text = directTextLayout?.text || compact(element.textContent);
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
    if (expandedDirectText && directTextNode) appendText(scene, directTextNode, style, source + " ::text");
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE && kind !== "text") appendText(scene, child, style, source + " ::text");
      if (child.nodeType === Node.ELEMENT_NODE) visit(child, id, inlineControl);
    }
    for (const pseudo of ["::before", "::after"]) {
      const pseudoStyle = getComputedStyle(element, pseudo);
      const content = compact(pseudoStyle.content).replace(/^("|')|("|')$/g, "");
      if (content && content !== "none" && content !== "normal" && pseudoStyle.display !== "none" && pseudoStyle.visibility !== "hidden" && number(pseudoStyle.opacity) !== 0) {
        reportUnsupportedTextColor(pseudoStyle.color, source + " " + pseudo);
        const pseudoId = "node-" + (++sequence);
        nodes.push({ id: pseudoId, parentId: id, children: [], kind: "text", name: pseudo, source: source + " " + pseudo, rect: rectOf(rect), zIndex: scene.zIndex + 0.02, paint: { color: pseudoStyle.color, opacity: number(pseudoStyle.opacity || "1") }, layout: { kind: "none", absolute: true }, text: content, textNoWrap: true, textStyle: textStyleOf(pseudoStyle) });
        scene.children.push(pseudoId);
      }
    }
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
      const root = document.body || document.documentElement;
      visit(root, undefined);
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
      const documentHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0, viewport.height);
      parent.postMessage({ type: "CAPTURE_RESULT", token, scene: { protocolVersion: ${PROTOCOL_VERSION}, viewport, documentSize: { width: Math.max(document.documentElement.scrollWidth, viewport.width), height: documentHeight }, nodes, assets: [...assets.values()], diagnostics } }, "*");
    } catch (error) {
      parent.postMessage({ type: "CAPTURE_ERROR", token, message: error instanceof Error ? error.message : String(error) }, "*");
    }
  });
})();`;
}
