import { describe, expect, it } from "vitest";
import {
  classifyIpAddress,
  classifyIpv4,
  classifyIpv6,
  isFetchableIp,
  MAX_URL_LENGTH,
  parseIpv4,
  parseTargetUrl,
  resolveRedirectTarget,
  TargetRejectedError
} from "./urlGuard";

describe("parseTargetUrl", () => {
  const accepted = (value: string) => parseTargetUrl(value);

  it("accepts complete http(s) URLs", () => {
    expect(accepted("https://example.com/page?x=1").hostname).toBe("example.com");
    expect(accepted("http://example.com").port).toBe(80);
    expect(accepted("https://example.com:443/a").port).toBe(443);
  });

  it("rejects empty, whitespace and oversized values", () => {
    expect(() => accepted("")).toThrow(TargetRejectedError);
    expect(() => accepted("   ")).toThrow(TargetRejectedError);
    expect(() => accepted("https://ex ample.com")).toThrow(/whitespace/);
    expect(() => accepted(`https://example.com/${"a".repeat(MAX_URL_LENGTH)}`)).toThrow(/must not exceed/);
  });

  it("rejects non-http schemes", () => {
    for (const value of [
      "ftp://example.com/file",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "gopher://example.com",
      "//example.com/no-scheme",
      "not a url"
    ]) {
      expect(() => accepted(value), value).toThrow(TargetRejectedError);
    }
  });

  it("rejects embedded credentials", () => {
    expect(() => accepted("https://user:pass@example.com/")).toThrow(/credentials/i);
    expect(() => accepted("https://user@example.com/")).toThrow(/credentials/i);
  });

  it("restricts ports to 80 and 443", () => {
    expect(() => accepted("http://example.com:22/")).toThrow(/ports? 80 and 443/);
    expect(() => accepted("https://example.com:8443/")).toThrow(/ports? 80 and 443/);
  });

  it("blocks localhost-style hostnames before DNS", () => {
    for (const host of ["localhost", "sub.localhost", "printer.local", "box.home.arpa", "host.invalid", "site.example", "x.test"]) {
      expect(() => accepted(`https://${host}/`), host).toThrow(TargetRejectedError);
    }
  });

  it("rejects IPv6 zone ids", () => {
    // WHATWG URL parsing rejects zone ids outright; the explicit % check in
    // parseTargetUrl is defense-in-depth for values that reach it unencoded.
    expect(() => accepted("http://[fe80::1%25eth0]/")).toThrow(TargetRejectedError);
    expect(() => accepted("http://[fe80::1%eth0]/")).toThrow();
  });

  it("rejects address literals pointing at non-public space", () => {
    expect(() => accepted("http://127.0.0.1/")).toThrow(/not allowed/);
    expect(() => accepted("https://[::1]/")).toThrow(/not allowed/);
    expect(() => accepted("https://[::ffff:10.0.0.1]/")).toThrow(/not allowed/);
    expect(() => accepted("http://169.254.169.254/latest/meta-data/")).toThrow(/not allowed/);
    // Public literals are fine and keep their bare hostname.
    expect(accepted("http://1.2.3.4/").hostname).toBe("1.2.3.4");
  });
});

describe("parseIpv4", () => {
  it("parses strict dotted quads", () => {
    expect(parseIpv4("192.0.2.1")).toBe(192 * 2 ** 24 + 2 * 2 ** 8 + 1);
    expect(parseIpv4("255.255.255.255")).toBe(0xffffffff);
  });

  it("rejects hex/octal/leading-zero/overflow forms used in SSRF bypasses", () => {
    for (const value of ["0x7f.0.0.1", "0177.0.0.1", "127.1", "2130706433", "256.1.1.1", "01.02.03.04", "1.2.3", "a.b.c.d", ""]) {
      expect(parseIpv4(value), value).toBeUndefined();
    }
  });
});

describe("classifyIpv4", () => {
  const blocked = (ip: string, expectedCategory?: string) => {
    const parsed = parseIpv4(ip)!;
    expect(classifyIpv4(parsed), ip).not.toBe("public");
    if (expectedCategory) expect(classifyIpv4(parsed), ip).toBe(expectedCategory);
    expect(isFetchableIp(ip)).toBe(false);
  };

  it("blocks loopback", () => {
    blocked("127.0.0.1", "loopback");
    blocked("127.255.255.254", "loopback");
  });

  it("blocks RFC1918 private ranges", () => {
    blocked("10.0.0.1", "private");
    blocked("10.255.255.255", "private");
    blocked("172.16.0.1", "private");
    blocked("172.31.255.255", "private");
    blocked("192.168.1.1", "private");
  });

  it("does not block public addresses adjacent to private ranges", () => {
    expect(isFetchableIp("11.0.0.1")).toBe(true);   // just outside 10/8
    expect(isFetchableIp("172.32.0.1")).toBe(true); // just outside 172.16/12
    expect(isFetchableIp("172.15.255.255")).toBe(true); // below 172.16/12
    expect(isFetchableIp("192.169.0.1")).toBe(true); // outside 192.168/16
    expect(isFetchableIp("100.63.255.255")).toBe(true); // below CGNAT
    expect(isFetchableIp("100.128.0.1")).toBe(true); // above CGNAT
  });

  it("blocks carrier-grade NAT 100.64/10", () => {
    blocked("100.64.0.1", "carrier-grade-nat");
    blocked("100.127.255.254", "carrier-grade-nat");
  });

  it("blocks link-local 169.254/16 (cloud metadata)", () => {
    blocked("169.254.169.254", "link-local");
    blocked("169.254.1.1", "link-local");
  });

  it("blocks documentation ranges", () => {
    blocked("192.0.2.9", "documentation");
    blocked("198.51.100.7", "documentation");
    blocked("203.0.113.99", "documentation");
  });

  it("blocks benchmarking, IETF assignments, this-network, multicast and reserved", () => {
    blocked("198.18.0.5", "benchmarking");
    blocked("198.19.255.5", "benchmarking");
    blocked("192.0.0.1", "ietf-protocol-assignments");
    blocked("0.0.0.0", "this-network");
    blocked("0.1.2.3", "this-network");
    blocked("224.0.0.1", "multicast");
    blocked("239.255.255.255", "multicast");
    blocked("240.0.0.1", "reserved");
    blocked("255.255.255.255", "reserved");
  });

  it("allows representative public addresses", () => {
    expect(isFetchableIp("1.1.1.1")).toBe(true);
    expect(isFetchableIp("93.184.216.34")).toBe(true);
    expect(isFetchableIp("203.1.113.5")).toBe(true); // outside TEST-NET-3
  });
});

describe("classifyIpv6", () => {
  it("blocks unspecified and loopback", () => {
    expect(classifyIpv6("::")).toBe("unspecified");
    expect(classifyIpv6("::1")).toBe("loopback");
    expect(isFetchableIp("0:0:0:0:0:0:0:1")).toBe(false);
  });

  it("blocks unique-local, link-local and multicast", () => {
    expect(classifyIpv6("fc00::1")).toBe("unique-local");
    expect(classifyIpv6("fd12:3456:789a::1")).toBe("unique-local");
    expect(classifyIpv6("fe80::1")).toBe("link-local");
    expect(classifyIpv6("ff02::1")).toBe("multicast");
    expect(classifyIpv6("ff05::1:3")).toBe("multicast");
  });

  it("blocks documentation, teredo, 6to4, discard-only and local NAT64", () => {
    expect(classifyIpv6("2001:db8::1")).toBe("documentation");
    expect(classifyIpv6("2001::1")).toBe("teredo");
    expect(classifyIpv6("2001:0:1234::1")).toBe("teredo");
    expect(classifyIpv6("2002:c000:204::1")).toBe("6to4");
    expect(classifyIpv6("100::1")).toBe("discard-only");
    expect(classifyIpv6("64:ff9b:1::1")).toBe("nat64-local");
  });

  it("checks embedded IPv4 inside mapped and NAT64 forms", () => {
    expect(classifyIpv6("::ffff:169.254.169.254")).toBe("tunnelled-link-local");
    expect(classifyIpv6("64:ff9b::7f00:1")).toBe("tunnelled-loopback");
    expect(classifyIpv6("64:ff9b::192.0.2.17")).toBe("tunnelled-documentation");
    expect(isFetchableIp("::ffff:a9fe:a9fe")).toBe(false); // 169.254.169.254 mapped
  });

  it("allows global unicast addresses including mapped publics", () => {
    expect(isFetchableIp("2606:4700:4700::1111")).toBe(true);
    expect(isFetchableIp("2001:4860:4860::8888")).toBe(true);
    expect(classifyIpv6("::ffff:1.2.3.4")).toBe("public");
    expect(classifyIpv6("64:ff9b::101:203")).toBe("public"); // 1.2.0.3
  });

  it("reports malformed literals as invalid", () => {
    expect(classifyIpv6("gggg::1")).toBe("invalid");
    expect(classifyIpv6("1:2:3:4:5:6:7:8:9")).toBe("invalid");
    expect(classifyIpv6("1::2::3")).toBe("invalid");
    expect(classifyIpv6("::::")).toBe("invalid");
    expect(classifyIpv6("1:2:3")).toBe("invalid");
    expect(classifyIpv6("::ffff:300.1.1.1")).toBe("invalid");
  });
});

describe("classifyIpAddress", () => {
  it("strips zone ids before classifying", () => {
    expect(classifyIpAddress("fe80::1%eth0")).toBe("link-local");
  });

  it("returns invalid for non-address strings", () => {
    expect(classifyIpAddress("example.com")).toBe("invalid");
    expect(classifyIpAddress("")).toBe("invalid");
  });
});

describe("resolveRedirectTarget", () => {
  const base = parseTargetUrl("https://example.com/start");

  it("resolves relative redirects against the current URL", () => {
    const next = resolveRedirectTarget(base, "/next?page=2");
    expect(next.href).toBe("https://example.com/next?page=2");
  });

  it("revalidates absolute redirects with every rule", () => {
    expect(resolveRedirectTarget(base, "http://other-domain.org/path").protocol).toBe("http:");
    expect(() => resolveRedirectTarget(base, "ftp://example.com/x")).toThrow(/http\(s\)/);
    expect(() => resolveRedirectTarget(base, "http://user:pw@example.com/")).toThrow(/credentials/i);
    expect(() => resolveRedirectTarget(base, "http://localhost/")).toThrow(/not allowed/);
    expect(() => resolveRedirectTarget(base, "http://[::1]/")).toThrow();
    expect(() => resolveRedirectTarget(base, "http://10.0.0.9/")).toThrow();
  });

  it("rejects malformed location headers", () => {
    expect(() => resolveRedirectTarget(base, "http://exa mple.com")).toThrow(TargetRejectedError);
  });
});
