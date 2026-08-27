#!/usr/bin/env node
/**
 * Configure Vercel WAF rate limiting for /api/fetch-html.
 *
 * Hobby plan: vercel.json already challenges naive scripts at the edge (no
 * function cost). True edge rate limiting requires Pro WAF or Cloudflare in
 * front of Vercel — this script is the Pro path.
 *
 * Pro: creates a WAF rate-limit rule at the edge (30 req/min per IP) that
 * blocks floods *before* they hit the serverless function. In-function limits
 * remain as second layer.
 *
 * Usage:
 *   node scripts/setup-firewall.mjs            # check status
 *   node scripts/setup-firewall.mjs --apply    # create + publish rule (requires Pro + `vercel` login)
 *
 * Hobby workaround without Pro:
 *   1. Keep the in-function limits (already global via Upstash if
 *      UPSTASH_REDIS_REST_URL/TOKEN are set, else per-instance).
 *   2. Front Vercel with Cloudflare (free): DNS → proxied (orange cloud),
 *      then Cloudflare Dashboard > Security > Rate Limiting Rules > Create rule:
 *      - URL contains /api/fetch-html
 *      - Rate: 30 requests per 1 minute per IP, block for 1 minute.
 *   Both are documented in README "URL import service".
 */

import { execSync } from "node:child_process";

const RATE_LIMIT_RULE = {
  name: "Rate limit fetch-html per IP",
  condition: { type: "path", op: "pre", value: "/api/fetch-html" },
  windowSec: 60,
  maxRequests: 30,
};

function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    return error.stdout?.toString() || error.message;
  }
}

const apply = process.argv.includes("--apply");

console.log("Firewall status:");
console.log(run("npx vercel firewall rules list --json 2>&1 | head -c 2000") || "(no output)");

if (!apply) {
  console.log(`
Dry run. To create the edge rate-limit rule (requires Vercel Pro):

  npx vercel firewall rules add "${RATE_LIMIT_RULE.name}" \\
    --condition '${JSON.stringify(RATE_LIMIT_RULE.condition)}' \\
    --action rate_limit \\
    --rate-limit-window ${RATE_LIMIT_RULE.windowSec} \\
    --rate-limit-requests ${RATE_LIMIT_RULE.maxRequests} \\
    --rate-limit-keys ip --yes

  npx vercel firewall publish

Or apply automatically:

  node scripts/setup-firewall.mjs --apply

Hobby: skip this — rely on vercel.json edge challenge (already deployed)
+ in-function limits, or front with Cloudflare as described above.
`);
  process.exit(0);
}

// Apply path — attempt to create rule via CLI
console.log(`\nCreating WAF rate-limit rule "${RATE_LIMIT_RULE.name}"...`);
const createCmd = [
  `npx vercel firewall rules add "${RATE_LIMIT_RULE.name}"`,
  `--condition '${JSON.stringify(RATE_LIMIT_RULE.condition)}'`,
  `--action rate_limit`,
  `--rate-limit-window ${RATE_LIMIT_RULE.windowSec}`,
  `--rate-limit-requests ${RATE_LIMIT_RULE.maxRequests}`,
  `--rate-limit-keys ip`,
  `--yes`,
].join(" ");

const out = run(createCmd + " 2>&1");
console.log(out);

if (out.includes("rate_limit") || out.includes("Rate limit") || out.includes("created")) {
  console.log("\nPublishing firewall changes...");
  console.log(run("npx vercel firewall publish 2>&1"));
  console.log("Done. Verify with: npx vercel firewall rules list --expand");
} else {
  console.log("\nRule creation may have failed (likely Hobby plan without WAF rate limiting).");
  console.log("This is expected on Hobby — use the Cloudflare/in-function workaround instead.");
  process.exit(1);
}
