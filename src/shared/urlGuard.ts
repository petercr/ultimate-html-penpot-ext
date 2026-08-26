/**
 * URL and IP address validation for outbound page fetching.
 *
 * These checks are deliberately strict: they exist to keep a hosted fetch
 * service from becoming an open proxy into private networks. Every rule here
 * has one of two purposes:
 *  1. Only well-formed public HTTP(S) URLs are ever fetched.
 *  2. No resolved address may point at loopback, private, link-local,
 *     carrier-grade NAT, multicast, documentation, benchmarking, reserved or
 *     otherwise non-public space, in IPv4 or IPv6.
 */

export const MAX_URL_LENGTH = 2048;
export const MAX_REDIRECTS = 3;
export const ALLOWED_PORTS = [80, 443] as const;

export type RejectionReason =
  | "empty"
  | "too-long"
  | "scheme"
  | "credentials"
  | "hostname"
  | "port"
  | "zone-id"
  | "blocked-hostname"
  | "blocked-ip";

export class TargetRejectedError extends Error {
  readonly reason: RejectionReason;
  constructor(reason: RejectionReason, message: string) {
    super(message);
    this.name = "TargetRejectedError";
    this.reason = reason;
  }
}

export interface TargetUrl {
  href: string;
  protocol: "http:" | "https:";
  /** Lowercase hostname without brackets or zone id; an IP literal stays literal. */
  hostname: string;
  port: number;
}

const BLOCKED_HOSTNAME_SUFFIXES = [
  ".localhost",
  ".local",
  ".home.arpa",
  ".invalid",
  ".example",
  ".test"
];

function reject(reason: RejectionReason, message: string): never {
  throw new TargetRejectedError(reason, message);
}

/** Parse a raw value into an approved absolute HTTP(S) target. */
export function parseTargetUrl(value: string): TargetUrl {
  const trimmed = value.trim();
  if (!trimmed) reject("empty", "The url parameter is required.");
  if (/\s/.test(trimmed)) reject("empty", "The url must be a single URL without whitespace.");
  if (trimmed.length > MAX_URL_LENGTH) reject("too-long", `The url must not exceed ${MAX_URL_LENGTH} characters.`);

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    reject("scheme", "The url must be an absolute http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    reject("scheme", "Only http: and https: URLs are supported.");
  }
  if (parsed.username || parsed.password) {
    reject("credentials", "URLs with embedded credentials are not supported.");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) reject("hostname", "The url must include a hostname.");

  let port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    reject("port", "The url port is invalid.");
  }
  if (!(ALLOWED_PORTS as readonly number[]).includes(port)) {
    reject("port", "Only ports 80 and 443 are supported.");
  }

  // Zone ids (fe80::1%eth0) never make sense for outbound web requests.
  if (hostname.includes("%")) reject("zone-id", "IPv6 zone ids are not supported.");

  // Reject public/private verdicts for address literals right away; brackets
  // are how WHATWG URLs spell IPv6 hosts.
  const bareHost = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (bareHost.includes(":") || parseIpv4(bareHost) !== undefined) {
    if (!isFetchableIp(bareHost)) {
      reject("blocked-ip", `The address ${bareHost} is not allowed.`);
    }
  }

  if (
    bareHost === "localhost" ||
    BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => bareHost.endsWith(suffix))
  ) {
    reject("blocked-hostname", `The host ${bareHost} is not allowed.`);
  }

  return { href: parsed.href, protocol: parsed.protocol, hostname: bareHost, port };
}

/* ------------------------------------------------------------------ */
/* IPv4                                                                */
/* ------------------------------------------------------------------ */

/** Strict dotted-quad parse; rejects hex/octal/leading-zero forms. */
export function parseIpv4(value: string): number | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!match) return undefined;
  let result = 0;
  for (const part of match.slice(1)) {
    if (part.length > 1 && part.startsWith("0")) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    result = (result << 8) | octet;
  }
  return result >>> 0;
}

/** Classify an unsigned 32-bit IPv4 address; "public" means fetchable. */
export function classifyIpv4(address: number): string {
  const inRange = (cidr: [number, number]) => {
    const [network, bits] = cidr;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    // >>> 0 normalises the signed int32 result of & before comparing.
    return (((address & mask) >>> 0) === ((network & mask) >>> 0));
  };
  const ranges: Array<[string, [number, number]]> = [
    ["this-network", [0x00000000, 8]],
    ["private", [0x0a000000, 8]],          // 10/8
    ["carrier-grade-nat", [0x64400000, 10]], // 100.64/10
    ["loopback", [0x7f000000, 8]],         // 127/8
    ["link-local", [0xa9fe0000, 16]],      // 169.254/16
    ["private", [0xac100000, 12]],         // 172.16/12
    ["ietf-protocol-assignments", [0xc0000000, 24]], // 192.0.0/24
    ["documentation", [0xc0000200, 24]],   // 192.0.2/24 TEST-NET-1
    ["benchmarking", [0xc6120000, 15]],    // 198.18/15
    ["documentation", [0xc6336400, 24]],   // 198.51.100/24 TEST-NET-2
    ["documentation", [0xcb007100, 24]],   // 203.0.113/24 TEST-NET-3
    ["private", [0xc0a80000, 16]],         // 192.168/16
    ["multicast", [0xe0000000, 4]],        // 224/4
    ["reserved", [0xf0000000, 4]]          // 240/4 incl. broadcast
  ];
  for (const [category, range] of ranges) {
    if (inRange(range)) return category;
  }
  return "public";
}

/* ------------------------------------------------------------------ */
/* IPv6                                                                */
/* ------------------------------------------------------------------ */

interface ParsedIpv6 {
  groups: number[]; // eight 16-bit groups
}

/** Parse an IPv6 literal into eight 16-bit groups. Rejects zone ids upstream. */
export function parseIpv6(value: string): ParsedIpv6 | undefined {
  let input = value;

  // Trailing dotted-quad form, e.g. ::ffff:192.0.2.128 or 64:ff9b::203.0.113.7
  const tailMatch = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(input);
  if (tailMatch) {
    const v4 = parseIpv4(tailMatch[1]);
    if (v4 === undefined) return undefined;
    input =
      input.slice(0, tailMatch.index) +
      ":" +
      ((v4 >>> 16) & 0xffff).toString(16) +
      ":" +
      (v4 & 0xffff).toString(16);
  }

  const sections = input.split("::");
  if (sections.length > 2) return undefined;
  const groupsOf = (section: string) => (section ? section.split(":") : []);
  const head = groupsOf(sections[0]);
  const tail = sections.length === 2 ? groupsOf(sections[1]) : [];
  const fill = 8 - (head.length + tail.length);
  if (fill < 0 || (sections.length === 1 && fill !== 0)) return undefined;

  const groups: number[] = [];
  for (const group of [...head, ...tail]) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
    groups.push(parseInt(group, 16));
  }
  groups.splice(head.length, 0, ...new Array(fill).fill(0));
  return { groups };
}

function ipv6PrefixMatches(groups: number[], prefixGroups: number[], bits: number): boolean {
  let remaining = bits;
  for (let index = 0; index < prefixGroups.length && remaining > 0; index += 1) {
    const take = Math.min(16, remaining);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if ((groups[index] & mask) !== (prefixGroups[index] & mask)) return false;
    remaining -= take;
  }
  return true;
}

const V6 = (values: number[]) => values;

/**
 * Classify an IPv6 literal; "public" means fetchable. Embedded IPv4 tails
 * (mapped, NAT64) inherit the verdict of the embedded IPv4 address so tunnelled
 * private addresses cannot slip through.
 */
export function classifyIpv6(literal: string): string {
  const parsed = parseIpv6(literal.toLowerCase());
  if (!parsed) return "invalid";

  const { groups } = parsed;
  const matches = (prefix: number[], bits: number) => ipv6PrefixMatches(groups, prefix, bits);

  if (matches(V6([0, 0, 0, 0, 0, 0, 0, 0]), 128)) return "unspecified";       // ::
  if (matches(V6([0, 0, 0, 0, 0, 0, 0, 1]), 128)) return "loopback";          // ::1

  // IPv4-mapped ::ffff:0:0/96 and well-known NAT64 64:ff9b::/96
  if (matches(V6([0, 0, 0, 0, 0, 0xffff, 0, 0]), 96)) return classifyEmbedded(groups, 96);
  if (matches(V6([0x0064, 0xff9b, 0, 0, 0, 0, 0, 0]), 96)) return classifyEmbedded(groups, 96);

  if (matches(V6([0x0100, 0, 0, 0, 0, 0, 0, 0]), 64)) return "discard-only";  // 100::/64
  if (matches(V6([0x2001, 0, 0, 0, 0, 0, 0, 0]), 32)) return "teredo";        // 2001::/32 embeds v4
  if (matches(V6([0x2001, 0x0db8, 0, 0, 0, 0, 0, 0]), 32)) return "documentation";
  if (matches(V6([0x2002, 0, 0, 0, 0, 0, 0, 0]), 16)) return "6to4";          // 2002::/16 embeds v4
  if (matches(V6([0x0064, 0xff9b, 1, 0, 0, 0, 0, 0]), 48)) return "nat64-local";
  if (matches(V6([0xfc00, 0, 0, 0, 0, 0, 0, 0]), 7)) return "unique-local";   // fc00::/7
  if (matches(V6([0xfe80, 0, 0, 0, 0, 0, 0, 0]), 10)) return "link-local";    // fe80::/10
  if (matches(V6([0xff00, 0, 0, 0, 0, 0, 0, 0]), 8)) return "multicast";      // ff00::/8
  if (groups[0] & 0xe000) return "public";                                    // global unicast 2000::/3
  return "reserved";
}

function classifyEmbedded(groups: number[], offsetBits: number): string {
  const high = groups[offsetBits / 16];
  const low = groups[offsetBits / 16 + 1];
  const address = ((high << 16) | low) >>> 0;
  const category = classifyIpv4(address);
  return category === "public" ? "public" : `tunnelled-${category}`;
}

/**
 * Full check for any address literal returned by DNS or present in the URL.
 * Returns the category name, or "public" when the address is fetchable.
 */
export function classifyIpAddress(literal: string): string {
  const bare = literal.replace(/%\w+$/, "");
  if (bare.includes(":")) return classifyIpv6(bare);
  const v4 = parseIpv4(bare);
  return v4 === undefined ? "invalid" : classifyIpv4(v4);
}

export function isFetchableIp(literal: string): boolean {
  return classifyIpAddress(literal) === "public";
}

/**
 * Decide whether a redirect from an already-approved target may be followed.
 * The Location header is resolved against the current URL and re-checked with
 * every rule that applies to first-party targets.
 */
export function resolveRedirectTarget(current: TargetUrl, locationHeader: string): TargetUrl {
  let next: URL;
  try {
    next = new URL(locationHeader, current.href);
  } catch {
    throw new TargetRejectedError("scheme", "The redirect location was not a valid URL.");
  }
  if (next.protocol !== "http:" && next.protocol !== "https:") {
    throw new TargetRejectedError("scheme", "Redirects must stay on http(s).");
  }
  return parseTargetUrl(next.href);
}
