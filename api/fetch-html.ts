/**
 * Production page-fetch service for the Ultimate HTML to Penpot plugin.
 *
 * Contract (see README "URL import service"):
 * - GET /api/fetch-html?url=<absolute http(s) url>&mode=html|svg
 * - 200 -> body is the upstream document; X-HTML-Source-URL holds the final,
 *   validated URL after redirects so relative assets resolve correctly.
 * - All rejections use JSON bodies ({ error }) with normalised status codes;
 *   internal network details are never included.
 *
 * The endpoint never forwards inbound headers or credentials upstream, caches
 * nothing, and emits one structured log line per request containing no full
 * URL query strings or page contents.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { FetchFailure, fetchHardened } from "./_lib/outbound.js";

const MODES = {
  html: {
    // Real-world page HTML sits far below this; the cap exists to bound
    // worst-case abuse egress, not to fit the largest pages on the web.
    maxBytes: 3 * 1024 * 1024,
    contentTypes: ["text/html", "application/xhtml+xml"],
    responseContentType: "text/html; charset=utf-8"
  },
  svg: {
    maxBytes: 2 * 1024 * 1024,
    contentTypes: ["image/svg+xml"],
    responseContentType: "image/svg+xml"
  }
} as const;

type Mode = keyof typeof MODES;

// Per-instance abuse controls. Serverless instances are ephemeral, so these
// are best-effort backstops on top of platform-level limits; they reset on
// cold start and apply independently per instance.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const RATE_LIMIT_BURST = 5;
const MAX_CONCURRENT_FETCHES = 8;
/** Instance-wide ceiling regardless of how many clients appear. */
const INSTANCE_MAX_REQUESTS_PER_WINDOW = 120;
/** Protects third parties: one target origin cannot be hammered via us. */
const TARGET_MAX_REQUESTS_PER_WINDOW = 30;

interface BucketState {
  tokens: number;
  updatedAt: number;
}

interface WindowCounter {
  count: number;
  windowStartedAt: number;
}

let activeFetches = 0;

/** Buckets live for the lifetime of this instance only; nothing persists. */
const buckets = new Map<string, BucketState>();
let instanceWindow: WindowCounter = { count: 0, windowStartedAt: Date.now() };
const targetWindows = new Map<string, WindowCounter>();

// Optional global store for Hobby deployments. When UPSTASH_REDIS_REST_URL +
// UPSTASH_REDIS_REST_TOKEN are set (Upstash free tier works), the per-client
// and per-target limits become global across instances. Otherwise they remain
// per-instance memory backstops. The edge challenge in vercel.json (routes
// -> mitigate: challenge) is the true zero-cost edge filter on Hobby; these
// in-function limits are the cost-aware fallback before any outbound fetch.
function upstashConfig(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

/** Observability for degraded limits, without keys or raw addresses. */
function logStoreDegraded(reason: string): void {
  logMetric({ outcome: "store-degraded", store: "upstash", reason });
}

async function takeUpstashSlot(key: string, limit: number, windowMs: number): Promise<boolean | null> {
  const cfg = upstashConfig();
  if (!cfg) return null;
  try {
    const windowSec = Math.ceil(windowMs / 1000);
    const response = await fetch(`${cfg.url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["INCR", key],
        ["EXPIRE", key, `${windowSec}`, "NX"]
      ]),
      signal: AbortSignal.timeout(300)
    });
    if (!response.ok) {
      logStoreDegraded(`http_${response.status}`);
      return null;
    }
    const data = (await response.json()) as Array<{ result?: number }>;
    const count = data?.[0]?.result;
    if (typeof count !== "number") {
      logStoreDegraded("invalid_response");
      return null;
    }
    return count <= limit;
  } catch {
    // Fail open to in-memory on Upstash errors/timeouts.
    logStoreDegraded("network_error");
    return null;
  }
}

async function takeInstanceSlotShared(): Promise<boolean> {
  const windowId = Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS);
  const shared = await takeUpstashSlot(`fetch-html:global:instance:${windowId}`, INSTANCE_MAX_REQUESTS_PER_WINDOW, RATE_LIMIT_WINDOW_MS);
  if (shared !== null) return shared;
  return takeInstanceSlot();
}

async function takeClientSlot(key: string): Promise<boolean> {
  // Upstash fixed-window is slightly looser than the in-memory token bucket
  // (burst folded into limit) but global across instances; acceptable trade.
  const shared = await takeUpstashSlot(`fetch-html:client:${key}`, RATE_LIMIT_MAX_REQUESTS + RATE_LIMIT_BURST, RATE_LIMIT_WINDOW_MS);
  if (shared !== null) return shared;
  return takeToken(key);
}

async function takeTargetSlotShared(targetUrl: string): Promise<boolean> {
  const origin = describeUrl(targetUrl);
  if (!origin) return false;
  const originHash = createHash("sha256").update(origin).digest("hex").slice(0, 16);
  const shared = await takeUpstashSlot(`fetch-html:target:${originHash}`, TARGET_MAX_REQUESTS_PER_WINDOW, RATE_LIMIT_WINDOW_MS);
  if (shared !== null) return shared;
  return takeTargetSlot(targetUrl);
}

/**
 * Derive a stable client key from platform-authoritative data only.
 * x-real-ip is set by Vercel from the actual connection and cannot be chosen
 * by the caller; x-forwarded-for is appended to (not trusted from) the client,
 * so its rightmost entry is the strongest fallback. Spoofed values therefore
 * cannot mint unlimited fresh rate-limit buckets.
 */
function clientKey(request: IncomingMessage): string {
  const trustedFront = hasTrustedFrontSecret(request);
  let ip = trustedFront ? String(request.headers["x-fetch-client-ip"] || "").trim() : "";
  const realIp = String(request.headers["x-real-ip"] || "").trim();
  if (!ip) ip = realIp;
  if (!ip) {
    const forwarded = String(request.headers["x-forwarded-for"] || "");
    ip = forwarded.split(",").map((part) => part.trim()).filter(Boolean).pop() || "unknown";
  }
  // Hash so operational logs never retain raw client addresses.
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

function takeToken(key: string): boolean {
  const now = Date.now();
  const refillPerMs = RATE_LIMIT_MAX_REQUESTS / RATE_LIMIT_WINDOW_MS;
  const state = buckets.get(key) || { tokens: RATE_LIMIT_BURST, updatedAt: now };
  state.tokens = Math.min(RATE_LIMIT_BURST, state.tokens + (now - state.updatedAt) * refillPerMs);
  state.updatedAt = now;
  // Spoofed client headers could otherwise grow the map without bound.
  if (buckets.size > 10_000) buckets.clear();
  buckets.set(key, state);
  if (state.tokens < 1) return false;
  state.tokens -= 1;
  return true;
}

function takeInstanceSlot(): boolean {
  const now = Date.now();
  if (now - instanceWindow.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
    instanceWindow = { count: 0, windowStartedAt: now };
  }
  instanceWindow.count += 1;
  return instanceWindow.count <= INSTANCE_MAX_REQUESTS_PER_WINDOW;
}

function takeTargetSlot(targetUrl: string): boolean {
  const origin = describeUrl(targetUrl);
  if (!origin) return false;
  const now = Date.now();
  const state = targetWindows.get(origin);
  if (!state || now - state.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
    if (targetWindows.size > 500) targetWindows.clear();
    targetWindows.set(origin, { count: 1, windowStartedAt: now });
    return true;
  }
  state.count += 1;
  return state.count <= TARGET_MAX_REQUESTS_PER_WINDOW;
}

/** True when the request plausibly originates from the plugin in a browser. */
function isBrowserInitiated(request: IncomingMessage): boolean {
  // Once a front secret is configured, require the private Worker-to-Vercel
  // channel. This prevents callers from bypassing the Worker via the public
  // Vercel hostname while keeping the secret out of plugin code.
  if (process.env.FETCH_FRONT_SHARED_SECRET?.trim()) return hasTrustedFrontSecret(request);
  // Read at request time so operators can flip the manual-client switch.
  if (["1", "true"].includes(String(process.env.FETCH_SERVICE_ALLOW_ANY_CLIENT || "").toLowerCase())) return true;
  const site = String(request.headers["sec-fetch-site"] || "").toLowerCase();
  return site === "same-origin" || site === "none" || site === "same-site";
}

function hasTrustedFrontSecret(request: IncomingMessage): boolean {
  const expected = process.env.FETCH_FRONT_SHARED_SECRET?.trim();
  return !!expected && String(request.headers["x-fetch-front-secret"] || "") === expected;
}

function sendJson(response: ServerResponse, status: number, payload: Record<string, unknown>, extraHeaders: Record<string, string> = {}): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  for (const [key, value] of Object.entries(extraHeaders)) response.setHeader(key, value);
  response.end(JSON.stringify(payload));
}

function logMetric(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: "fetch_html", at: new Date().toISOString(), ...fields }));
}

/** Origin only: never the full URL, whose query may carry sensitive data. */
function describeUrl(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const startedAt = Date.now();
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Max-Age": "600"
  };

  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Max-Age", "600");
    response.end();
    return;
  }

  const finishMetric = (fields: Record<string, unknown>) =>
    logMetric({ durationMs: Date.now() - startedAt, method: request.method, ...fields });

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Only GET requests are supported." }, { Allow: "GET, OPTIONS" });
    return;
  }

  if (["1", "true"].includes(String(process.env.FETCH_SERVICE_DISABLED || "").toLowerCase())) {
    sendJson(response, 503, { error: "The URL import service is temporarily disabled." }, { "Retry-After": "3600" });
    finishMetric({ outcome: "kill-switch", status: 503 });
    return;
  }

  if (!isBrowserInitiated(request)) {
    sendJson(response, 403, { error: "The import service is only available to the plugin." }, corsHeaders);
    finishMetric({ outcome: "non-browser", status: 403 });
    return;
  }

  if (!(await takeInstanceSlotShared())) {
    sendJson(response, 503, { error: "The service is busy. Try again shortly." }, { "Retry-After": "10", ...corsHeaders });
    finishMetric({ outcome: "instance-saturated", status: 503 });
    return;
  }

  const key = clientKey(request);
  if (!(await takeClientSlot(key))) {
    sendJson(
      response,
      429,
      { error: "Too many requests. Wait a minute before importing again." },
      { "Retry-After": "60", ...corsHeaders }
    );
    finishMetric({ outcome: "rate-limited", status: 429, client: key });
    return;
  }

  const requestUrl = new URL(request.url || "/", "https://internal.invalid");
  const rawTarget = requestUrl.searchParams.get("url");
  const modeParam = requestUrl.searchParams.get("mode") || "html";

  if (!rawTarget) {
    sendJson(response, 400, { error: "The url query parameter is required." }, corsHeaders);
    finishMetric({ outcome: "rejected", status: 400, reason: "missing-url" });
    return;
  }

  if (!(await takeTargetSlotShared(rawTarget))) {
    sendJson(
      response,
      429,
      { error: "That target site is receiving too many requests right now. Try again in a minute." },
      { "Retry-After": "60", ...corsHeaders }
    );
    finishMetric({ outcome: "target-limited", status: 429, origin: describeUrl(rawTarget), client: key });
    return;
  }

  const mode = (modeParam === "svg" ? "svg" : "html") satisfies Mode;
  const limits = MODES[mode];

  if (activeFetches >= MAX_CONCURRENT_FETCHES) {
    sendJson(response, 503, { error: "The service is busy. Try again shortly." }, { "Retry-After": "5", ...corsHeaders });
    finishMetric({ outcome: "busy", status: 503, client: key });
    return;
  }
  activeFetches += 1;
  try {
    const document = await fetchHardened(rawTarget, { maxBytes: limits.maxBytes, timeoutMs: 15_000 });

    const mediaType = document.contentType.split(";")[0].trim().toLowerCase();
    if (!(limits.contentTypes as readonly string[]).includes(mediaType)) {
      sendJson(response, 415, { error: "The target did not return a supported document type." }, corsHeaders);
      finishMetric({
        outcome: "unsupported-content",
        status: 415,
        mode,
        origin: describeUrl(document.finalTarget.href),
        bytes: document.body.length
      });
      return;
    }

    if (document.status < 200 || document.status >= 300) {
      // Non-redirect statuses outside 2xx are upstream problems.
      throw new FetchFailure(document.status >= 500 ? "status" : "status", `the target returned HTTP ${document.status}`, {
        upstreamStatus: document.status
      });
    }

    response.statusCode = 200;
    response.setHeader("Content-Type", limits.responseContentType);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-HTML-Source-URL", document.finalTarget.href);
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Expose-Headers", "X-HTML-Source-URL");
    response.end(document.body);
    finishMetric({
      outcome: "ok",
      status: 200,
      mode,
      bytes: document.body.length,
      origin: describeUrl(document.finalTarget.href),
      client: key
    });
  } catch (error) {
    if (!(error instanceof FetchFailure)) {
      sendJson(response, 500, { error: "The URL import service failed unexpectedly." }, corsHeaders);
      finishMetric({ outcome: "crash", status: 500, mode, message: error instanceof Error ? error.name : "unknown" });
      return;
    }
    const mapped = mapFailure(error);
    sendJson(response, mapped.status, { error: mapped.message }, mapped.retryAfter ? { "Retry-After": mapped.retryAfter, ...corsHeaders } : corsHeaders);
    finishMetric({
      outcome: "upstream-error",
      status: mapped.status,
      mode,
      kind: error.kind,
      reason: error.rejectionReason || error.detail,
      upstreamStatus: error.upstreamStatus,
      client: key
    });
  } finally {
    activeFetches -= 1;
  }
}

export const POLICY_MESSAGES: Record<string, string> = {
  scheme: "Only complete http(s) web page URLs are supported.",
  credentials: "URLs with embedded usernames or passwords are not supported.",
  port: "Only standard web ports (80 and 443) are supported.",
  "too-long": "That URL is longer than the supported limit."
};

export function mapFailure(error: FetchFailure): { status: number; message: string; retryAfter?: string } {
  if (error.kind === "policy") {
    if (error.rejectionReason === "threat") {
      return { status: 451, message: "That address is on a blocklist and cannot be imported." };
    }
    const hostLevel = ["blocked-hostname", "blocked-ip", "zone-id"].includes(error.rejectionReason || "");
    if (hostLevel) {
      return { status: 403, message: "That address is not reachable through the import service." };
    }
    return {
      status: 400,
      message:
        (error.rejectionReason && POLICY_MESSAGES[error.rejectionReason]) ||
        "That URL is not supported. Use a complete http(s) web page URL."
    };
  }
  if (error.kind === "size") {
    return { status: 413, message: "The target page is larger than the allowed size limit." };
  }
  if (error.kind === "timeout") {
    return { status: 504, message: "The target took too long to respond.", retryAfter: "15" };
  }
  if (error.kind === "dns") {
    return { status: 502, message: "The target host could not be found." };
  }
  if (error.kind === "connect" || error.kind === "network") {
    return { status: 502, message: "The target could not be reached." };
  }
  if (error.upstreamStatus && error.upstreamStatus >= 400 && error.upstreamStatus < 500) {
    return { status: 502, message: `The target server rejected the request (HTTP ${error.upstreamStatus}).` };
  }
  return { status: 502, message: "The target server returned an error." };
}
