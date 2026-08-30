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
    const dataUrl = /^data:/i.test(url) ? url : undefined;
    const dataMime = dataUrl?.match(/^data:([^;,]+)/i)?.[1];
    assets.set(url, dataUrl
      ? { id, dataUrl, mimeType: dataMime || hint }
      : { id, url, mimeType: hint });
    return id;
  };
  const backgroundUrl = (value) => {
    const match = /url\\(["']?(.+?)["']?\\)/.exec(value || "");
    return match ? match[1] : undefined;
  };
  const transparent = (value) => {
    const normalized = String(value || "").replace(/\\s+/g, "").toLowerCase();
    return !normalized || normalized === "transparent" || normalized === "rgba(0,0,0,0)";
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
      if (paint.backgroundImage === "none" && htmlStyle.backgroundImage !== "none") paint.backgroundImage = htmlStyle.backgroundImage;
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
  const appendText = (parent, textNode, style) => {
    const layout = textLayout(textNode);
    for (const [index, line] of (layout.lines || []).entries()) {
      if (!line.text || !line.rect) continue;
      const id = "node-" + (++sequence);
      nodes.push({ id, parentId: parent.id, children: [], kind: "text", name: line.text.slice(0, 80), source: parent.source + " ::text", rect: line.rect, zIndex: parent.zIndex + 0.01 + index / 10_000, paint: { color: style.color, opacity: number(style.opacity || "1") }, layout: { kind: "none" }, text: line.text, textNoWrap: true, textStyle: textStyleOf(style, layout.measuredLineHeight) });
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
    if (!visible(element, style, rect)) return;
    const source = sourceOf(element);
    const reason = unsupported(element, style);
    const id = "node-" + (++sequence);
    const directText = [...element.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && compact(child.textContent));
    // Penpot's fixed text layers wrap when the fallback font is a little
    // wider than the browser's font. Links and buttons are inline controls in
    // this capture model, so preserve their source browser line as one line.
    const inlineControl = inlineControlAncestor || tag === "a" || tag === "button";
    const textNoWrap = directText && (style.whiteSpace === "nowrap" || inlineControl);
    const childElements = [...element.children].filter((child) => { const childStyle = getComputedStyle(child); const childRect = child.getBoundingClientRect(); return visible(child, childStyle, childRect); });
    const imageUrl = tag === "img" ? element.currentSrc || element.src : backgroundUrl(style.backgroundImage);
    const imageAsset = asset(imageUrl, tag === "img" ? element.currentSrc?.split(".").pop() : undefined);
    // A text-only node cannot carry fills, borders, or radii, so any element
    // with direct text and visible decoration keeps those surfaces by becoming
    // a container with the text as a child layer.
    const decorated = style.backgroundColor !== "rgba(0, 0, 0, 0)" || style.backgroundImage !== "none" || (style.borderTopStyle !== "none" && number(style.borderTopWidth) > 0) || style.boxShadow !== "none" || [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].some((value) => number(value) > 0);
    const kind = reason ? "fallback" : tag === "img" ? "image" : tag === "svg" ? "svg" : directText && childElements.length === 0 && !decorated ? "text" : (style.display === "flex" || style.display === "grid" || childElements.length > 0 || directText ? "container" : "box");
    const scene = { id, parentId, children: [], kind, name: nameOf(element), source, rect: rectOf(rect), zIndex: Number.parseInt(style.zIndex, 10) || sequence, paint: paintOfElement(element, style), layout: layoutOf(style), assetId: imageAsset, fallbackReason: reason, textNoWrap };
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
      }
    }
    if (tag === "svg") { scene.assetId = asset("data:image/svg+xml," + encodeURIComponent(element.outerHTML), "image/svg+xml"); }
    nodes.push(scene);
    nodeById.set(id, scene);
    if (parentId) nodeById.get(parentId)?.children.push(id);
    if (reason) {
      diagnostics.push({ severity: "warning", code: "UNSUPPORTED_SUBTREE", message: reason, viewportId: viewport.id, source });
      return id;
    }
    if (expandedDirectText && directTextNode) appendText(scene, directTextNode, style);
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE && kind !== "text") appendText(scene, child, style);
      if (child.nodeType === Node.ELEMENT_NODE) visit(child, id, inlineControl);
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
