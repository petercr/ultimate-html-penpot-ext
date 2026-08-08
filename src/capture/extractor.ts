import { PROTOCOL_VERSION, type ViewportSpec } from "../shared/contracts";

/** A self-contained script run inside the opaque, sandboxed document. */
export function buildExtractorScript(token: string, viewport: ViewportSpec, settleDelayMs: number): string {
  const encodedViewport = JSON.stringify(viewport);
  return `
(() => {
  const token = ${JSON.stringify(token)};
  const viewport = ${encodedViewport};
  const delay = ${Math.max(0, Math.min(settleDelayMs, 10_000))};
  const diagnostics = [];
  const assets = new Map();
  const nodes = [];
  const nodeById = new Map();
  let sequence = 0;

  const number = (value) => { const parsed = parseFloat(value || "0"); return Number.isFinite(parsed) ? parsed : 0; };
  const compact = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const rectOf = (rect) => ({ x: Math.round(rect.x * 100) / 100, y: Math.round(rect.y * 100) / 100, width: Math.round(rect.width * 100) / 100, height: Math.round(rect.height * 100) / 100 });
  const visible = (element, style, rect) => style.display !== "none" && style.visibility !== "hidden" && number(style.opacity) !== 0 && (rect.width > 0 || rect.height > 0);
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
    assets.set(url, { id, url, mimeType: hint });
    return id;
  };
  const backgroundUrl = (value) => {
    const match = /url\\(["']?(.+?)["']?\\)/.exec(value || "");
    return match ? match[1] : undefined;
  };
  const unsupported = (element, style) => {
    if (["CANVAS", "VIDEO", "IFRAME", "OBJECT", "EMBED"].includes(element.tagName)) return element.tagName.toLowerCase() + " cannot be converted to editable layers";
    if (style.filter && style.filter !== "none") return "CSS filter needs a raster fallback";
    if (style.backdropFilter && style.backdropFilter !== "none") return "backdrop-filter needs a raster fallback";
    if (style.maskImage && style.maskImage !== "none") return "CSS mask needs a raster fallback";
    if (style.mixBlendMode && style.mixBlendMode !== "normal") return "CSS blend mode needs a raster fallback";
    return undefined;
  };
  const paintOf = (style) => ({
    backgroundColor: style.backgroundColor,
    backgroundImage: style.backgroundImage,
    color: style.color,
    borderColor: style.borderTopColor,
    borderWidth: number(style.borderTopWidth),
    borderStyle: style.borderTopStyle,
    radius: [number(style.borderTopLeftRadius), number(style.borderTopRightRadius), number(style.borderBottomRightRadius), number(style.borderBottomLeftRadius)],
    opacity: number(style.opacity || "1"),
    boxShadow: style.boxShadow,
    overflow: ["hidden", "clip"].includes(style.overflow) ? style.overflow : "visible",
    transform: style.transform
  });
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
  const textStyleOf = (style) => ({
    fontFamily: style.fontFamily,
    fontSize: number(style.fontSize),
    fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
    fontStyle: style.fontStyle,
    lineHeight: style.lineHeight === "normal" ? number(style.fontSize) * 1.2 : number(style.lineHeight),
    letterSpacing: number(style.letterSpacing),
    textAlign: style.textAlign,
    textDecoration: style.textDecorationLine,
    textTransform: style.textTransform
  });
  const appendText = (parent, textNode, style) => {
    const text = compact(textNode.textContent);
    if (!text) return;
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const rects = [...range.getClientRects()];
    if (!rects.length) return;
    const left = Math.min(...rects.map((item) => item.left));
    const top = Math.min(...rects.map((item) => item.top));
    const right = Math.max(...rects.map((item) => item.right));
    const bottom = Math.max(...rects.map((item) => item.bottom));
    const id = "node-" + (++sequence);
    nodes.push({ id, parentId: parent.id, children: [], kind: "text", name: text.slice(0, 80), source: parent.source + " ::text", rect: rectOf({ x: left, y: top, width: right - left, height: bottom - top }), zIndex: parent.zIndex + 0.01, paint: { color: style.color, opacity: number(style.opacity || "1") }, layout: { kind: "none" }, text, textStyle: textStyleOf(style) });
    parent.children.push(id);
  };
  const visit = (element, parentId) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (!visible(element, style, rect)) return;
    const source = sourceOf(element);
    const reason = unsupported(element, style);
    const tag = element.tagName.toLowerCase();
    const id = "node-" + (++sequence);
    const directText = [...element.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && compact(child.textContent));
    const childElements = [...element.children].filter((child) => { const childStyle = getComputedStyle(child); const childRect = child.getBoundingClientRect(); return visible(child, childStyle, childRect); });
    const imageUrl = tag === "img" ? element.currentSrc || element.src : backgroundUrl(style.backgroundImage);
    const imageAsset = asset(imageUrl, tag === "img" ? element.currentSrc?.split(".").pop() : undefined);
    const kind = reason ? "fallback" : tag === "img" ? "image" : tag === "svg" ? "svg" : directText && childElements.length === 0 ? "text" : (style.display === "flex" || style.display === "grid" || childElements.length > 0 ? "container" : "box");
    const scene = { id, parentId, children: [], kind, name: nameOf(element), source, rect: rectOf(rect), zIndex: Number.parseInt(style.zIndex, 10) || sequence, paint: paintOf(style), layout: layoutOf(style), assetId: imageAsset, fallbackReason: reason };
    if (kind === "text") { scene.text = compact(element.textContent); scene.textStyle = textStyleOf(style); }
    if (tag === "svg") { scene.assetId = asset("data:image/svg+xml," + encodeURIComponent(element.outerHTML), "image/svg+xml"); }
    nodes.push(scene);
    nodeById.set(id, scene);
    if (parentId) nodeById.get(parentId)?.children.push(id);
    if (reason) {
      diagnostics.push({ severity: "warning", code: "UNSUPPORTED_SUBTREE", message: reason, viewportId: viewport.id, source });
      return id;
    }
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE && kind !== "text") appendText(scene, child, style);
      if (child.nodeType === Node.ELEMENT_NODE) visit(child, id);
    }
    for (const pseudo of ["::before", "::after"]) {
      const pseudoStyle = getComputedStyle(element, pseudo);
      const content = compact(pseudoStyle.content).replace(/^("|')|("|')$/g, "");
      if (content && content !== "none" && content !== "normal") {
        const pseudoId = "node-" + (++sequence);
        nodes.push({ id: pseudoId, parentId: id, children: [], kind: "text", name: pseudo, source: source + " " + pseudo, rect: rectOf(rect), zIndex: scene.zIndex + 0.02, paint: { color: pseudoStyle.color, opacity: number(pseudoStyle.opacity || "1") }, layout: { kind: "none", absolute: true }, text: content, textStyle: textStyleOf(pseudoStyle) });
        scene.children.push(pseudoId);
      }
    }
    return id;
  };
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const settleWithin = async (work, maximumWait) => {
    try { await Promise.race([work, wait(maximumWait)]); } catch (_) {}
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
  };
  settle().then(() => {
    try {
      const root = document.body || document.documentElement;
      visit(root, undefined);
      const documentHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0, viewport.height);
      parent.postMessage({ type: "CAPTURE_RESULT", token, scene: { protocolVersion: ${PROTOCOL_VERSION}, viewport, documentSize: { width: Math.max(document.documentElement.scrollWidth, viewport.width), height: documentHeight }, nodes, assets: [...assets.values()], diagnostics } }, "*");
    } catch (error) {
      parent.postMessage({ type: "CAPTURE_ERROR", token, message: error instanceof Error ? error.message : String(error) }, "*");
    }
  });
})();`;
}
