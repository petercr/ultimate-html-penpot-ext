// @vitest-environment node
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import handler, { mapFailure, MODES } from "./fetch-html.js";
import { FetchFailure } from "./_lib/outbound.js";

interface StubResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader(key: string, value: string): void;
}

function callHandler(url: string, init: { method?: string; forwardedFor?: string; realIp?: string; secFetchSite?: string; frontSecret?: string } = {}): Promise<StubResponse> {
  return new Promise((resolve, reject) => {
    const response: StubResponse = {
      statusCode: 0,
      headers: {},
      body: "",
      setHeader(key, value) {
        this.headers[key.toLowerCase()] = value;
      }
    };
    const headers: Record<string, string> = { "x-forwarded-for": init.forwardedFor || `${Math.random()}` };
    if (init.realIp) headers["x-real-ip"] = init.realIp;
    if (init.frontSecret) headers["x-fetch-front-secret"] = init.frontSecret;
    // The plugin fetches same-origin from its iframe; browsers always attach
    // Sec-Fetch-Site. Passing "" simulates a client that omits it entirely.
    if (init.secFetchSite !== "") headers["sec-fetch-site"] = init.secFetchSite || "same-origin";
    handler(
      {
        method: init.method || "GET",
        url,
        headers
      } as never,
      {
        set statusCode(value: number) {
          response.statusCode = value;
        },
        get statusCode() {
          return response.statusCode;
        },
        setHeader: (key: string, value: string) => response.setHeader(key, value),
        end: (body?: string) => {
          response.body = body || "";
          resolve(response);
        }
      } as never
    ).catch(reject);
  });
}

describe("mode contract", () => {
  it("exposes the documented asset modes with bounded sizes", () => {
    expect(Object.keys(MODES).sort()).toEqual(["asset", "css", "font", "html", "svg"]);
    expect(MODES.font.maxBytes).toBe(1_572_864);
    expect(MODES.css.maxBytes).toBe(2 * 1024 * 1024);
    expect(MODES.asset.maxBytes).toBe(3 * 1024 * 1024);
  });

  it("allows font content types including the common octet-stream misconfiguration", () => {
    expect(MODES.font.contentTypes).toContain("font/woff2");
    expect(MODES.font.contentTypes).toContain("font/woff");
    expect(MODES.font.contentTypes).toContain("application/vnd.ms-fontobject");
    expect(MODES.font.contentTypes).toContain("application/octet-stream");
    expect(MODES.font.contentTypes).not.toContain("text/html");
  });

  it("constrains css but lets trusted-mode assets pass any type", () => {
    expect(MODES.css.contentTypes).toEqual(["text/css"]);
    expect(MODES.asset.contentTypes).toBeNull();
  });
});

describe("mapFailure", () => {
  it("maps policy rejections by scope", () => {
    expect(mapFailure(new FetchFailure("policy", "x", { rejectionReason: "blocked-ip" })).status).toBe(403);
    expect(mapFailure(new FetchFailure("policy", "x", { rejectionReason: "blocked-hostname" })).status).toBe(403);
    expect(mapFailure(new FetchFailure("policy", "x", { rejectionReason: "credentials" })).status).toBe(400);
    expect(mapFailure(new FetchFailure("policy", "x", { rejectionReason: "port" })).status).toBe(400);
  });

  it("maps resource and upstream failures", () => {
    expect(mapFailure(new FetchFailure("size", "x")).status).toBe(413);
    expect(mapFailure(new FetchFailure("timeout", "x")).status).toBe(504);
    expect(mapFailure(new FetchFailure("dns", "x")).status).toBe(502);
    expect(mapFailure(new FetchFailure("network", "x")).status).toBe(502);
    expect(mapFailure(new FetchFailure("status", "x", { upstreamStatus: 403 })).message).toContain("403");
  });
});

describe("fetch-html endpoint", () => {
  let server: Server;
  let origin = "";

  beforeAll(async () => {
    delete process.env.FETCH_SERVICE_DISABLED;
    server = createServer((request, response) => {
      if (request.url === "/json") {
        response.setHeader("content-type", "application/json");
        response.end("{}");
        return;
      }
      if (request.url === "/style.css") {
        response.setHeader("content-type", "text/css");
        response.end("body{color:red}");
        return;
      }
      if (request.url === "/font.woff2") {
        response.setHeader("content-type", "font/woff2");
        response.end(Buffer.from([0x77, 0x4f, 0x46, 0x32]));
        return;
      }
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<!doctype html><main>Local fixture</main>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.FETCH_SERVICE_DISABLED;
  });

  it("answers CORS preflights", async () => {
    const response = await callHandler("/", { method: "OPTIONS" });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
  });

  it("rejects non-GET methods", async () => {
    const response = await callHandler("/?url=https://example.com/", { method: "POST" });
    expect(response.statusCode).toBe(405);
  });

  it("requires a url parameter", async () => {
    const response = await callHandler("/");
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/required/i);
  });

  it("refuses loopback targets before dialling them", async () => {
    // Default-port loopback is rejected during URL validation alone.
    const response = await callHandler(`/?url=${encodeURIComponent("http://127.0.0.1/")}`);
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error).toContain("not reachable");
  }, 20_000);

  it("restricts outbound ports even for allowed addresses", async () => {
    // A live local fixture on an ephemeral port must still be unreachable.
    const response = await callHandler(`/?url=${encodeURIComponent(origin + "/")}`);
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toContain("ports");
  });

  it("reports unresolvable hosts as bad gateways without details", async () => {
    const response = await callHandler("/?url=" + encodeURIComponent("https://no-such-host-9f21c4.kubernetes/"));
    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body).error).toContain("could not be found");
    expect(response.body).not.toMatch(/\b\d+\.\d+\.\d+\.\d+\b/); // no internal detail leaks
  }, 20_000);

  it("honours the kill switch", async () => {
    process.env.FETCH_SERVICE_DISABLED = "1";
    try {
      const response = await callHandler("/?url=https://example.com/");
      expect(response.statusCode).toBe(503);
      expect(response.headers["retry-after"]).toBe("3600");
    } finally {
      delete process.env.FETCH_SERVICE_DISABLED;
    }
  });

  it("rejects scripted clients that do not present browser fetch metadata", async () => {
    const response = await callHandler("/?url=http://127.0.0.1/", { secFetchSite: "" });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error).toContain("only available to the plugin");
  });

  it("allows non-browser clients when explicitly enabled", async () => {
    process.env.FETCH_SERVICE_ALLOW_ANY_CLIENT = "1";
    try {
      const response = await callHandler("/?url=http://127.0.0.1/", { secFetchSite: "" });
      expect(JSON.parse(response.body).error).not.toContain("only available to the plugin");
      expect(JSON.parse(response.body).error).toContain("not reachable");
    } finally {
      delete process.env.FETCH_SERVICE_ALLOW_ANY_CLIENT;
    }
  });

  it("requires the trusted front channel when configured", async () => {
    process.env.FETCH_FRONT_SHARED_SECRET = "test-front-secret";
    try {
      const direct = await callHandler("/?url=http://127.0.0.1/", { secFetchSite: "same-origin" });
      expect(direct.statusCode).toBe(403);
      expect(JSON.parse(direct.body).error).toContain("only available to the plugin");

      const proxied = await callHandler("/?url=http://127.0.0.1/", { frontSecret: "test-front-secret" });
      expect(proxied.statusCode).toBe(403);
      expect(JSON.parse(proxied.body).error).toContain("not reachable");
    } finally {
      delete process.env.FETCH_FRONT_SHARED_SECRET;
    }
  });

  it("maps reputation rejections to 451", () => {
    const mapped = mapFailure(new FetchFailure("policy", "x", { rejectionReason: "threat" }));
    expect(mapped.status).toBe(451);
    expect(mapped.message).toContain("blocklist");
  });

  it("refuses targets listed by the screening service", async () => {
    process.env.SAFE_BROWSING_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ matches: [{ threatType: "MALWARE" }] }), { status: 200 })));
    try {
      const response = await callHandler("/?url=https://example.com/");
      expect(response.statusCode).toBe(451);
      expect(JSON.parse(response.body).error).toContain("blocklist");
    } finally {
      vi.unstubAllGlobals();
      delete process.env.SAFE_BROWSING_API_KEY;
    }
  });

  it("ignores spoofed forwarding hops when deriving the rate-limit identity", async () => {
    // Same platform-set x-real-ip, rotating fake XFF values: must still share
    // one bucket and exhaust it.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await callHandler("/?url=http://127.0.0.1/", {
        realIp: "203.0.113.50",
        forwardedFor: `10.${attempt}.0.1, 203.0.113.50`
      });
    }
    const exhausted = await callHandler("/?url=http://127.0.0.1/", {
      realIp: "203.0.113.50",
      forwardedFor: `10.99.99.99, 203.0.113.50`
    });
    expect(exhausted.statusCode).toBe(429);
  });

  it("returns rate-limit responses with retry guidance", async () => {
    const sharedIp = "198.51.100.7"; // documentation range as a stable bucket key
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await callHandler("/?url=https://example.com/", { forwardedFor: sharedIp }); // may be 403s, fine
    }
    const exhausted = await callHandler("/?url=https://example.com/", { forwardedFor: sharedIp });
    expect(exhausted.statusCode).toBe(429);
    expect(exhausted.headers["retry-after"]).toBe("60");
  });
});

describe("shared Upstash limits", () => {
  const upstashEnv = { UPSTASH_REDIS_REST_URL: "https://example.upstash.io", UPSTASH_REDIS_REST_TOKEN: "test-token" };

  function pipelineMock(results: number[][]) {
    const bodies: string[] = [];
    const mock = vi.fn(async (_url: string | URL, init?: { body?: string }) => {
      const body = init?.body || "";
      bodies.push(body);
      const commands = JSON.parse(body).length as number;
      const response = results.shift() || Array.from({ length: commands }, () => 1);
      return new Response(JSON.stringify(response.map((result) => ({ result }))), { status: 200 });
    });
    return { mock, bodies };
  }

  it("denies a client via the shared store before any outbound work", async () => {
    const { mock, bodies } = pipelineMock([[1, 1], [26, 1]]); // instance slot ok, client slot exhausted
    vi.stubGlobal("fetch", mock);
    Object.assign(process.env, upstashEnv);
    try {
      const denied = await callHandler("/?url=https://example.com/", { realIp: "203.0.113.88" });
      expect(denied.statusCode).toBe(429);
      expect(denied.headers["retry-after"]).toBe("60");
      expect(mock).toHaveBeenCalledTimes(2); // instance + client slots; no target slot, no outbound fetch
      expect(bodies[0]).toContain("fetch-html:global:instance:");
      expect(bodies[1]).toContain("fetch-html:client:");
      expect(bodies[1]).not.toContain("203.0.113.88"); // identity is hashed, never raw
    } finally {
      vi.unstubAllGlobals();
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
    }
  });

  it("consults the shared per-origin counter and enforces it", async () => {
    const { mock, bodies } = pipelineMock([[1, 1], [1, 1], [31, 1]]); // instance, client, target exhausted
    vi.stubGlobal("fetch", mock);
    Object.assign(process.env, upstashEnv);
    try {
      const denied = await callHandler("/?url=https://example.com/", { realIp: "203.0.113.89" });
      expect(denied.statusCode).toBe(429);
      expect(denied.headers["retry-after"]).toBe("60");
      expect(bodies[2]).toContain("fetch-html:target:");
      expect(bodies[2]).not.toContain("https://example.com"); // only the origin hash is stored
    } finally {
      vi.unstubAllGlobals();
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
    }
  });

  it("degrades to in-memory limits and logs a metric when the store is unreachable", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("store down"); }));
    Object.assign(process.env, upstashEnv);
    try {
      const response = await callHandler("/?url=http://127.0.0.1/", { realIp: "203.0.113.90" });
      expect(response.statusCode).toBe(403); // request still evaluated via in-memory slots
      expect(JSON.parse(response.body).error).toContain("not reachable");
      const degraded = logSpy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('"outcome":"store-degraded"'));
      expect(degraded.length).toBeGreaterThan(0);
      expect(degraded[0]).toContain('"store":"upstash"');
      expect(degraded[0]).toContain('"reason":"network_error"');
      expect(degraded[0]).not.toContain("203.0.113.90");
    } finally {
      vi.unstubAllGlobals();
      logSpy.mockRestore();
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
    }
  });
});
