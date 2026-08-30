// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./front-proxy";

afterEach(() => vi.unstubAllGlobals());

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://fetch.example.workers.dev/api/fetch-html?mode=asset&url=https%3A%2F%2Fexample.com%2Fstyle.css", { headers });
}

describe("fetch front proxy", () => {
  it("returns CORS headers for an opaque sandbox origin", async () => {
    const response = await worker.fetch(new Request("https://fetch.example.workers.dev/api/fetch-html", {
      method: "OPTIONS",
      headers: { Origin: "null" }
    }), {} as never);

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("null");
  });

  it("forwards opaque-origin GETs only when browser metadata is present", async () => {
    const upstream = vi.fn(async () => new Response("body{}", {
      status: 200,
      headers: { "Content-Type": "text/css" }
    }));
    vi.stubGlobal("fetch", upstream);
    const env = {
      VERCEL_ORIGIN: "https://ultimate-html-penpot-ext.vercel.app",
      FETCH_FRONT_SHARED_SECRET: "test-secret",
      FETCH_IP_LIMITER: { limit: vi.fn(async () => ({ success: true })) }
    } as never;

    const accepted = await worker.fetch(request({ Origin: "null", "Sec-Fetch-Site": "cross-site" }), env);
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("Access-Control-Allow-Origin")).toBe("null");
    expect(await accepted.text()).toBe("body{}");
    expect(upstream).toHaveBeenCalledTimes(1);

    const rejected = await worker.fetch(request({ Origin: "null" }), env);
    expect(rejected.status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
