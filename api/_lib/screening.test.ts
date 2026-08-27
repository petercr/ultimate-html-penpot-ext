// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearScreeningCache, FetchFailure, screenTarget } from "./outbound.js";

const API_ENV = { SAFE_BROWSING_API_KEY: "test-key" };

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("screenTarget", () => {
  beforeEach(() => {
    clearScreeningCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.SAFE_BROWSING_API_KEY;
    delete process.env.FETCH_SCREENING_DISABLED;
    clearScreeningCache();
  });

  it("refuses URLs listed by a threat verdict", async () => {
    process.env.SAFE_BROWSING_API_KEY = API_ENV.SAFE_BROWSING_API_KEY;
    const fetchMock = vi.fn(async () => respond({ matches: [{ threatType: "MALWARE" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(screenTarget("https://evil.example/page")).rejects.toMatchObject({
      name: "FetchFailure",
      kind: "policy",
      rejectionReason: "threat"
    });
  });

  it("allows clean verdicts and caches them per URL", async () => {
    process.env.SAFE_BROWSING_API_KEY = API_ENV.SAFE_BROWSING_API_KEY;
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => respond({}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(screenTarget("https://fine.example/page")).resolves.toBeUndefined();
    await expect(screenTarget("https://fine.example/page")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1); // second verdict came from the cache
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.threatInfo.threatEntries[0].url).toBe("https://fine.example/page");
  });

  it("serves cached threat verdicts without further lookups", async () => {
    process.env.SAFE_BROWSING_API_KEY = API_ENV.SAFE_BROWSING_API_KEY;
    const fetchMock = vi.fn(async () => respond({ matches: [{ threatType: "SOCIAL_ENGINEERING" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(screenTarget("https://evil.example/again")).rejects.toBeInstanceOf(FetchFailure);
    await expect(screenTarget("https://evil.example/again")).rejects.toBeInstanceOf(FetchFailure);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails open with a metric when the screening API errors", async () => {
    process.env.SAFE_BROWSING_API_KEY = API_ENV.SAFE_BROWSING_API_KEY;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => respond({}, 500)));

    await expect(screenTarget("https://flaky.example/")).resolves.toBeUndefined();
    const degraded = logSpy.mock.calls.map((call) => String(call[0])).find((line) => line.includes('"outcome":"screening-degraded"'));
    expect(degraded).toContain('"reason":"http_500"');
  });

  it("fails open with a metric when the screening API is unreachable", async () => {
    process.env.SAFE_BROWSING_API_KEY = API_ENV.SAFE_BROWSING_API_KEY;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connect ECONNREFUSED"); }));

    await expect(screenTarget("https://dark.example/")).resolves.toBeUndefined();
    const degraded = logSpy.mock.calls.map((call) => String(call[0])).find((line) => line.includes('"outcome":"screening-degraded"'));
    expect(degraded).toContain('"reason":"network_error"');
  });

  it("is inactive without an API key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(screenTarget("https://anything.example/")).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is inactive when the operator disables screening", async () => {
    process.env.SAFE_BROWSING_API_KEY = API_ENV.SAFE_BROWSING_API_KEY;
    process.env.FETCH_SCREENING_DISABLED = "1";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(screenTarget("https://anything.example/")).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
