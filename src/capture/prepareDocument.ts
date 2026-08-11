import { buildExtractorScript } from "./extractor";
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

  const policy = input.scriptPolicy === "trusted"
    ? `default-src 'none'; img-src data: blob: http: https:; style-src 'unsafe-inline' http: https:; font-src data: http: https:; script-src 'nonce-${nonce}' http: https:; connect-src http: https:; media-src data: blob: http: https:; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'self' http: https:`
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
