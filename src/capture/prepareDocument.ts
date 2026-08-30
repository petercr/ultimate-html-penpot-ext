import { buildExtractorScript } from "./extractor";
import { assetProxyBase } from "./source";
import type { ScriptPolicy, ViewportSpec } from "../shared/contracts";

export function isSafeBaseUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * A tiny network shim that runs before the page's own scripts in trusted
 * mode. The capture sandbox is an opaque origin, so a site fetching its own
 * same-origin stylesheets, fonts, or data with fetch/XMLHttpRequest would be
 * CORS-blocked even though the real page loads those resources freely. This
 * shim rewrites only GET requests aimed at the page's own origin to the
 * constrained import proxy, which re-fetches them with permissive CORS
 * headers. Third-party requests and non-GET requests are untouched.
 */
export function buildNetworkShim(baseOrigin: string, proxyBase: string): string {
  return `(function(){
  var baseOrigin = ${JSON.stringify(baseOrigin)};
  var proxyBase = ${JSON.stringify(proxyBase)};
  function absolute(url){ try { return new URL(url, document.baseURI); } catch (_) { return null; } }
  function proxied(url, method){
    if (String(method || "GET").toUpperCase() !== "GET" || !proxyBase) return url;
    var abs = absolute(url);
    if (!abs || abs.origin !== baseOrigin || (abs.protocol !== "https:" && abs.protocol !== "http:")) return url;
    return proxyBase + "?mode=asset&url=" + encodeURIComponent(abs.href);
  }
  var nativeFetch = window.fetch;
  if (nativeFetch) window.fetch = function(input, init){
    var request;
    try {
      // Materialise Request inputs first so an init override is reflected in
      // the method we inspect and all of the original Request options survive
      // the URL rewrite. Passing a Request object to nativeFetch with only a
      // replacement string would otherwise silently turn it into a new GET.
      request = input && typeof input === "object" && input.url ? new Request(input, init) : null;
      var requestUrl = request ? request.url : input;
      var method = request ? request.method : init && init.method;
      if (requestUrl) {
        var rewritten = proxied(requestUrl, method);
        if (rewritten !== requestUrl) {
          var rewrittenInput = request ? new Request(rewritten, request) : rewritten;
          return nativeFetch.apply(this, request ? [rewrittenInput] : [rewrittenInput, init]);
        }
        if (request) return nativeFetch.call(this, request);
      }
    } catch (_) {}
    return nativeFetch.apply(this, arguments);
  };
  var nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url){
    var rest = Array.prototype.slice.call(arguments, 2);
    try {
      var rewritten = proxied(url, method);
      if (rewritten !== url) {
        url = rewritten;
      }
    } catch (_) {}
    return nativeOpen.apply(this, [method, url].concat(rest));
  };
})();`;
}

export function prepareSandboxDocument(input: {
  html: string;
  baseUrl?: string;
  scriptPolicy: ScriptPolicy;
  token: string;
  viewport: ViewportSpec;
  settleDelayMs: number;
}): string {
  const parser = new DOMParser();
  const document = parser.parseFromString(input.html, "text/html");
  const nonce = crypto.randomUUID();
  const head = document.head || document.documentElement.insertBefore(document.createElement("head"), document.body);

  document.querySelectorAll("base").forEach((base) => base.remove());
  if (isSafeBaseUrl(input.baseUrl)) {
    const base = document.createElement("base");
    base.href = input.baseUrl;
    head.prepend(base);
  }

  const scripts = [...document.querySelectorAll("script")];
  if (input.scriptPolicy === "off") {
    scripts.forEach((script) => script.remove());
    if (scripts.length) document.documentElement.setAttribute("data-html-to-penpot-scripts-disabled", String(scripts.length));
  } else scripts.forEach((script) => script.setAttribute("nonce", nonce));

  // The shim must run before any page script, so it is placed first among
  // them: prepended to the head, nonce-carried like the rest of the trusted
  // script set, and only when a proxy exists to receive rewritten requests.
  const proxyBase = input.scriptPolicy === "trusted" && isSafeBaseUrl(input.baseUrl) ? assetProxyBase() : undefined;
  if (proxyBase) {
    const shim = document.createElement("script");
    shim.setAttribute("nonce", nonce);
    shim.textContent = buildNetworkShim(new URL(input.baseUrl!).origin, proxyBase);
    head.prepend(shim);
  }

  const policy = input.scriptPolicy === "trusted"
    // Trusted mode promises the page's scripts run, and many sites start
    // their boot from inline event handlers (for example, a deferred
    // loader's onload attribute). script-src-attr governs only those
    // handler attributes; script elements themselves stay nonce-gated.
    ? `default-src 'none'; img-src data: blob: http: https:; style-src 'unsafe-inline' http: https:; font-src data: http: https:; script-src 'nonce-${nonce}' http: https:; script-src-attr 'unsafe-inline'; connect-src http: https:; media-src data: blob: http: https:; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'self' http: https:`
    : `default-src 'none'; img-src data: blob: http: https:; style-src 'unsafe-inline' http: https:; font-src data: http: https:; script-src 'nonce-${nonce}'; media-src data: blob: http: https:; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'self' http: https:`;
  const csp = document.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = policy;
  head.prepend(csp);
  const referrer = document.createElement("meta");
  referrer.name = "referrer";
  referrer.content = "no-referrer";
  head.prepend(referrer);
  const freeze = document.createElement("style");
  freeze.textContent = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";
  head.append(freeze);
  const extractor = document.createElement("script");
  extractor.setAttribute("nonce", nonce);
  extractor.textContent = buildExtractorScript(input.token, input.viewport, input.settleDelayMs);
  document.body.append(extractor);
  return "<!doctype html>\n" + document.documentElement.outerHTML;
}
