// @vitest-environment node
// Exercises the real outbound chain against example.org when the network is
// available; skipped automatically in hermetic environments.
import { describe, expect, it } from "vitest";
import { fetchHardened, FetchFailure } from "./outbound";

const online = await fetch("https://example.org", { signal: AbortSignal.timeout(5_000) })
  .then((response) => response.ok)
  .catch(() => false);

describe.skipIf(!online)("fetchHardened against the public web", () => {
  it("fetches a public page and reports its final URL", async () => {
    const document = await fetchHardened("https://example.org/", { maxBytes: 1024 * 1024, timeoutMs: 15_000 });
    expect(document.status).toBe(200);
    expect(document.contentType).toContain("text/html");
    expect(document.finalTarget.hostname).toBe("example.org");
    expect(document.body.toString()).toContain("Example Domain");
  }, 20_000);

  it("follows http to https redirects with revalidation", async () => {
    const document = await fetchHardened("http://github.com/", { maxBytes: 1024 * 1024, timeoutMs: 15_000 });
    expect(document.status).toBe(200);
    expect(document.finalTarget.protocol).toBe("https:");
  }, 20_000);

  it("enforces streaming byte limits below the true body size", async () => {
    const attempt = fetchHardened("https://example.org/", { maxBytes: 16, timeoutMs: 15_000 });
    await expect(attempt).rejects.toMatchObject({ kind: "size" as const });
  }, 20_000);

  it("refuses hostnames whose DNS answers point back inside", async () => {
    // localtest.me is a public name that resolves to 127.0.0.1.
    await expect(fetchHardened("http://localtest.me/", { maxBytes: 1024, timeoutMs: 10_000 })).rejects.toMatchObject({
      kind: "policy" as const
    });
  }, 20_000);

  it("fails fast when the wall-clock budget is already spent", async () => {
    const error = await fetchHardened("https://example.org/", { maxBytes: 1024, timeoutMs: 0 }).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(FetchFailure);
    expect((error as FetchFailure).kind).toBe("timeout");
  });
});
