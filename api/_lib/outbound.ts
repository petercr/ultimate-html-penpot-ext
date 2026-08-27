/**
 * Hardened outbound page fetcher used by the /api/fetch-html service.
 *
 * Design notes:
 * - Every hostname is resolved with node:dns before connecting and every
 *   returned address must pass the public-IP classification, so private,
 *   loopback and other prohibited space can never be dialled.
 * - The connection is pinned to a validated address (with SNI still naming the
 *   original host) so a rebinding DNS answer between validation and connection
 *   cannot redirect us into an internal network.
 * - Redirects are followed manually: each hop is re-parsed and re-validated
 *   with the same rules, including its own DNS answers.
 * - Response bytes are counted while streaming (after decompression) so size
 *   limits hold even when the peer lies about Content-Length or dribbles data.
 * - No inbound header, cookie or credential is ever forwarded; the outbound
 *   header set below is fixed.
 */

import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import {
  classifyIpAddress,
  MAX_REDIRECTS,
  parseTargetUrl,
  TargetRejectedError,
  type TargetUrl
} from "../../src/shared/urlGuard.js";

const OUTBOUND_HEADERS = {
  accept: "text/html,application/xhtml+xml;q=0.9,image/svg+xml;q=0.8",
  "accept-encoding": "gzip, deflate",
  "user-agent": "ultimate-html-to-penpot/0.2 (+https://github.com/petercr/ultimate-html-penpot-ext)"
} as const;

export interface FetchLimits {
  /** Maximum decompressed body bytes accepted from the origin. */
  maxBytes: number;
  /** Wall-clock budget in ms for the whole chain including redirects. */
  timeoutMs: number;
  maxRedirects?: number;
}

export type FailureKind = "dns" | "connect" | "network" | "status" | "timeout" | "size" | "policy";

export class FetchFailure extends Error {
  readonly kind: FailureKind;
  /** Normalised machine-readable detail; safe to expose to clients. */
  readonly detail: string;
  readonly upstreamStatus?: number;
  readonly rejectionReason?: string;

  constructor(kind: FailureKind, detail: string, extra: { upstreamStatus?: number; rejectionReason?: string } = {}) {
    super(`${kind}: ${detail}`);
    this.name = "FetchFailure";
    this.kind = kind;
    this.detail = detail;
    this.upstreamStatus = extra.upstreamStatus;
    this.rejectionReason = extra.rejectionReason;
  }
}

export interface FetchedDocument {
  status: number;
  contentType: string;
  finalTarget: TargetUrl;
  body: Buffer;
}

interface Hop {
  status: number;
  contentType: string;
  contentLength?: number;
  location?: string;
  response: IncomingMessage;
  dispose(): void;
}

function hostHeaderFor(target: TargetUrl): string {
  return target.port === 80 || target.port === 443 ? target.hostname : `${target.hostname}:${target.port}`;
}

/**
 * Resolve every address for a hostname and require all of them to be public.
 * A mixed answer (one public record, one internal) is rejected outright:
 * round-robin could hand us the internal one.
 */
async function resolvePublicAddress(target: TargetUrl): Promise<string> {
  let records: Array<{ address: string }>;
  try {
    records = await lookup(target.hostname, { all: true, verbatim: true });
  } catch {
    throw new FetchFailure("dns", "the target host could not be resolved");
  }
  if (!records.length) throw new FetchFailure("dns", "the target host has no addresses");
  const approved = new Set<string>();
  for (const record of records) {
    const category = classifyIpAddress(record.address);
    if (category !== "public") {
      throw new FetchFailure("policy", "the target resolves to non-public address space", { rejectionReason: category });
    }
    approved.add(record.address);
  }
  return [...approved][0];
}

function decompressStream(response: IncomingMessage): Readable {
  const encoding = String(response.headers["content-encoding"] || "").toLowerCase().trim();
  if (encoding === "gzip") return response.pipe(createGunzip());
  if (encoding === "deflate") return response.pipe(createInflate());
  if (encoding === "br") return response.pipe(createBrotliDecompress());
  return response;
}

/** Read one full response while counting decompressed bytes; abort past cap. */
async function readBody(response: IncomingMessage, maxBytes: number, deadlineAt: number): Promise<Buffer> {
  const declaredLength = Number(response.headers["content-length"] || "");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new FetchFailure("size", "the response is larger than the allowed limit");
  }

  return await new Promise<Buffer>((resolve, reject) => {
    const source = decompressStream(response);
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (error?: FetchFailure, buffer?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(inactivityTimer);
      response.destroy();
      source.destroy();
      if (error) reject(error);
      else resolve(buffer!);
    };

    const inactivityTimer = setTimeout(
      () => finish(new FetchFailure("timeout", "the response stalled")),
      Math.max(deadlineAt - Date.now(), 1)
    );

    source.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        finish(new FetchFailure("size", "the response exceeded the allowed limit"));
        return;
      }
      chunks.push(chunk);
    });
    // Decompression or truncation errors surface here; keep details generic.
    source.on("error", () => finish(new FetchFailure("network", "the response body could not be decoded")));
    source.on("end", () => finish(undefined, Buffer.concat(chunks)));
  });
}

/** Perform one validated, pinned request hop and resolve with its head. */
function performHop(target: TargetUrl, address: string, deadlineAt: number): Promise<Hop> {
  const url = new URL(target.href);
  const secure = target.protocol === "https:";
  const request = (secure ? httpsRequest : httpRequest)({
    host: address,
    port: target.port,
    servername: secure ? target.hostname : undefined,
    method: "GET",
    path: `${url.pathname}${url.search}`,
    setHost: false,
    headers: { ...OUTBOUND_HEADERS, host: hostHeaderFor(target) },
    timeout: Math.max(Math.min(deadlineAt - Date.now(), 10_000), 1)
  });

  return new Promise<Hop>((resolve, reject) => {
    let settled = false;
    const responseHolder: { current?: IncomingMessage } = {};

    const wallClockTimer = setTimeout(() => fail(new FetchFailure("timeout", "the target did not respond in time")), Math.max(deadlineAt - Date.now(), 1));

    function fail(error: FetchFailure): void {
      if (settled) return;
      settled = true;
      clearTimeout(wallClockTimer);
      request.destroy();
      responseHolder.current?.destroy();
      reject(error);
    }

    request.on("error", (error: NodeJS.ErrnoException) =>
      fail(new FetchFailure("network", `the connection failed (${error.code || "unknown"})`))
    );
    request.on("timeout", () => fail(new FetchFailure("timeout", "the target socket timed out")));
    request.on("response", (response) => {
      responseHolder.current = response;
      if (settled) return;
      settled = true;
      clearTimeout(wallClockTimer);
      resolve({
        status: response.statusCode || 0,
        contentType: String(response.headers["content-type"] || ""),
        contentLength: Number.isFinite(Number(response.headers["content-length"]))
          ? Number(response.headers["content-length"])
          : undefined,
        location: typeof response.headers.location === "string" ? response.headers.location : undefined,
        response,
        dispose: () => {
          response.destroy();
          request.destroy();
        }
      });
    });
    request.end();
  });
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Fetch a page or asset through validated, pinned connections, following up to
 * `limits.maxRedirects` revalidated hops within one wall-clock budget.
 */
export async function fetchHardened(rawUrl: string, limits: FetchLimits): Promise<FetchedDocument> {
  const maxRedirects = limits.maxRedirects ?? MAX_REDIRECTS;
  const startedAt = Date.now();

  let current: TargetUrl;
  try {
    current = parseTargetUrl(rawUrl);
  } catch (error) {
    if (error instanceof TargetRejectedError) {
      throw new FetchFailure("policy", "the requested url was rejected", { rejectionReason: error.reason });
    }
    throw error;
  }

  for (let hopIndex = 0; ; hopIndex += 1) {
    if (Date.now() >= startedAt + limits.timeoutMs) {
      throw new FetchFailure("timeout", "the fetch ran out of time");
    }

    const address = await resolvePublicAddress(current);
    const hop = await performHop(current, address, startedAt + limits.timeoutMs);

    if (REDIRECT_STATUSES.has(hop.status)) {
      const location = hop.location;
      hop.dispose();
      if (!location) {
        throw new FetchFailure("status", `the server redirected without a destination (HTTP ${hop.status})`, { upstreamStatus: hop.status });
      }
      if (hopIndex >= maxRedirects) {
        throw new FetchFailure("status", "too many redirects", { upstreamStatus: hop.status });
      }
      let next: TargetUrl;
      try {
        next = parseTargetUrl(new URL(location, current.href).href);
      } catch (error) {
        if (error instanceof TargetRejectedError) {
          throw new FetchFailure("policy", "a redirect destination was rejected", { rejectionReason: error.reason });
        }
        throw new FetchFailure("network", "the redirect destination could not be parsed");
      }
      current = next;
      continue;
    }

    const body = await readBody(hop.response, limits.maxBytes, startedAt + limits.timeoutMs);
    hop.dispose();
    return { status: hop.status, contentType: hop.contentType, finalTarget: current, body };
  }
}
