# Ultimate HTML to Penpot

A Penpot plugin that turns pasted HTML or web page URLs into editable desktop, tablet, and mobile boards. It uses deterministic browser layout extraction; pasted HTML never leaves the browser.

## Run locally

1. Install dependencies with `npm install`.
2. Build once with `npm run build`.
3. Serve `dist` with `npm run preview`, or use `npm run dev` to rebuild and serve continuously.
4. In Penpot’s plugin manager, load the manifest URL printed by Vite.

### Windows + WSL

Penpot running on Windows can normally use `http://localhost:4173/manifest.json` while this project runs in WSL. If Windows localhost forwarding is disabled, use the WSL IP printed under Vite's **Network** line instead (for this workspace: `http://10.0.0.63:4173/manifest.json`). Keep `npm run dev` running while Penpot loads or uses the plugin.

If neither works, first build in WSL with `npm run build`, then run this command in Windows PowerShell 7:

```powershell
node \\wsl.localhost\Ubuntu\home\peterc\ultimate-html-penpot-ext\scripts\windows-static-server.mjs
```

Then load `http://localhost:4173/manifest.json` in Penpot. This starts the HTTP server on Windows itself and works around a broken WSL HTTP bridge.

## What v0.1 supports

- Pasted HTML/CSS, an optional HTTP(S) base URL for resolving relative assets, responsive viewport boards, and editable text, boxes, flex layouts, images, and inline SVG.
- Best-effort HTTP(S) page URLs when the target site permits credential-free browser requests through CORS.
- Trusted-source script execution as an explicit opt-in, inside an opaque sandbox.
- Diagnostics and placeholders for canvas/video/iframe content, filters, masks, blend modes, blocked assets, and other content that cannot be safely represented.

Pasting HTML is the reliable workflow. Direct page URLs and remote images, fonts, stylesheets, or SVG assets can fail when their host does not permit browser access. When running with `npm run dev`, URL imports first try the browser request and then use the local `/__html_to_penpot/fetch` proxy when the target does not allow CORS. That proxy is intended for local development only: 15-second timeout, 3 MB response limit, no credentials. Pasted HTML remains available everywhere; provide its URL as the Base URL to resolve relative assets.

## URL import service (v0.2)

When a build sets `VITE_FETCH_PROXY_ORIGIN` to the deployment origin, CORS-blocked page imports are retried through a deliberately constrained fetch service (`api/fetch-html.ts`, deployed as a Vercel serverless function next to the plugin). The service:

- Accepts only complete `http:`/`https:` URLs on ports 80/443 without embedded credentials.
- Resolves every hostname itself and refuses loopback, private, link-local, carrier-grade NAT, multicast, documentation, benchmarking, reserved, and other non-public IPv4/IPv6 space — including tunnelled addresses inside `::ffff:` and NAT64 forms.
- Pins each connection to an address validated immediately before dialling, so DNS rebinding cannot redirect a request into internal networks mid-flight.
- Follows at most three redirects, re-validating every hop (protocol, port, credentials, resolved addresses) before following it.
- Screens the target **and every redirect destination** against Google Safe Browsing (v4 Lookup API: malware, phishing, unwanted software) before dialling. Verdicts are cached per URL for 2 h (clean) or 30 min (listed), so typical requests add no lookup latency; listed targets are refused with HTTP 451 and the outcome is logged without the full URL. Screening is inactive until `SAFE_BROWSING_API_KEY` is set, and `FETCH_SCREENING_DISABLED=1` is the operator escape hatch. If the screening API itself is unreachable, requests fail **open** (deliberate availability trade-off) and a `screening-degraded` metric is logged as the alerting signal.
- Sends a fixed header set only; it never forwards user cookies, authorization headers, client IP headers, or anything else from the caller.
- Enforces one wall-clock budget of 15 seconds per chain and streams responses with a hard cap of 3 MB for pages (2 MB for SVG assets), counted after decompression and independent of declared `Content-Length`.
- Returns HTML/XHTML for pages and SVG for `mode=svg` requests only, plus the final validated upstream URL in `X-HTML-Source-URL` so relative assets resolve correctly.
- Rate limits per client (~20 requests/minute with small bursts), caps concurrent outbound fetches per instance, applies an instance-wide request ceiling, and throttles repeated fetches of a single target origin so the service cannot be used to hammer third parties; replies `429`/`503` with clear messages when exceeded. On Hobby (no Vercel WAF rate limiting), these checks run in-function *before* any outbound fetch — a flood still costs an invocation but almost no CPU/time. Set `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` to make the per-client and per-target limits global across instances (Upstash free tier); without them they remain per-instance memory backstops.
- Only serves requests carrying browser `Sec-Fetch-Site` metadata (the plugin always fetches same-origin), which cheaply rejects scripted clients; set `FETCH_SERVICE_ALLOW_ANY_CLIENT=1` when operating the service manually. `vercel.json` also issues an edge `challenge` when `Sec-Fetch-Site` is missing, so naive scripts are blocked *before* the function runs — this works on Hobby.
- Emits one structured metrics line per request — status, duration, byte count, rejection reason, hashed client bucket — and never logs full query strings, page contents, or raw client IPs. Nothing is cached or retained.
- Runs bounded at 512 MB memory / 20 s maximum duration via `vercel.json`, capping worst-case cost per invocation.
- Can be disabled instantly by setting the environment variable `FETCH_SERVICE_DISABLED=1` and redeploying.

### Hobby front proxy

Vercel Hobby does not provide edge rate-limiting rules. This repository includes a small Cloudflare Worker at `cloudflare/front-proxy.ts` that can run on the free `workers.dev` hostname instead. It only accepts the fetch endpoint, applies a Cloudflare Worker Rate Limiting binding (30 requests/minute per IP per Cloudflare location), forwards to the fixed Vercel origin, and strips all inbound headers except the browser signal needed for admission. Cloudflare Workers Free currently allows 100,000 Worker requests/day; the Vercel function's global Upstash limit remains the second layer.

Deploy it with `npm run deploy:worker` after setting the Worker secret `FETCH_FRONT_SHARED_SECRET`. Set the same secret as a sensitive Vercel Production and Preview variable. Then set `VITE_FETCH_PROXY_ORIGIN` to the resulting `https://<worker>.<account-subdomain>.workers.dev` URL and redeploy the plugin. The secret is never included in browser code. When the secret is configured, direct requests to the Vercel function are rejected; only the Worker can reach it.

The Worker URL is intentionally used instead of a customer-owned custom domain. A Route 53 record by itself would not provide Cloudflare proxying, and `capecod.world` remains on Vercel DNS for its existing project.

Every request through the service is disclosed in the plugin UI error text ("the import service"), and the plugin always attempts a credential-free direct browser fetch first, using the service only when the direct request is blocked by CORS or network failure.

Hosting costs scale with usage; the rate limits above cap worst-case bandwidth per instance. Review Vercel function quotas before enabling the service publicly.

## Production deployment

The v0.1.0 release is designed for static hosting on Vercel. Netlify, Cloudflare Pages, or any HTTPS static host that supports response headers also works.

### Vercel

1. Import this repository into Vercel (Other framework preset).
2. Use `npm ci && npm run build` as the build command.
3. Set the output directory to `dist`.
4. To enable the URL import service, set `VITE_FETCH_PROXY_ORIGIN` to the deployed Worker URL so plugin builds use the rate-limited front proxy, and keep `FETCH_SERVICE_DISABLED` unset.
5. Keep the generated production hostname stable; the install URL is `https://<hostname>/manifest.json`.
6. Install that manifest URL in a fresh Penpot account before submitting it to Penpot Hub.

The committed `vercel.json` sends CORS and security headers for every static path while excluding `/api`, where the fetch service manages its own headers, and adds an edge `challenge` for `/api/fetch-html` when `Sec-Fetch-Site` is missing (Hobby-compatible; blocks naive scripts before function cost). Optionally set `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` (Upstash free tier) for global rate limiting across instances. Optionally set `SAFE_BROWSING_API_KEY` (Google Safe Browsing Lookup API, free tier) to enable target reputation screening. The included Cloudflare Worker provides the free edge rate limit without requiring Vercel Pro WAF. Static caching applies to `manifest.json`, `plugin.js`, and hashed UI assets.

### Cloudflare Pages or Netlify

Use the same build command (`npm ci && npm run build`) and publish the `dist` directory. The committed `public/_headers` file carries the identical CORS and cache policy for those hosts. The URL import service requires a runtime host (Vercel functions today); without one, builds simply omit it and URL imports rely on browser CORS alone.

Pull requests and pushes to `main` run tests, the API typecheck (`npm run check:api`), and the production build in GitHub Actions, including a bundle check that validates the manifest paths, permissions, icon, CORS headers, and the Vercel configuration.

## Privacy and security

- Pasted HTML is parsed and rendered inside the plugin's browser sandbox. It is not uploaded to a service operated by this project.
- Remote assets are requested directly from the asset's original host without credentials. Those hosts receive ordinary network request metadata such as the user's IP address.
- Direct page URL imports also use credential-free browser requests. When they are blocked by CORS **and** the hosted fetch service is configured, the requested page URL is sent to this project's service so it can fetch the page server-side: the service receives the URL, fetches only its HTML/SVG within the limits described above, and returns the bytes to the plugin. It does not receive user identity beyond IP-derived rate limiting (stored only as a hash), does not retain content, and never forwards credentials. Pasted HTML is never sent through the service.
- Remote SVG inlining uses the same constrained service path (`mode=svg`) when direct fetching fails.
- Running scripts is off by default and should be enabled only for trusted source HTML.
- The plugin requests Penpot's `content:write` permission so it can create editable boards and layers.

Threat model summary for the service: it is an abuse-resistant partial web proxy for public pages only. SSRF defenses (address classification, pinned connections, redirect revalidation) protect internal networks; size/time/rate caps limit resource abuse; fixed outbound headers and no-forward rules prevent credential propagation; structured logs contain no page content or raw client IPs and are subject to the hosting platform's log retention. Do not paste confidential HTML or enable scripts from an untrusted source.

## Support

Report bugs and request features through [GitHub Issues](https://github.com/petercr/ultimate-html-penpot-ext/issues). Include the browser, Penpot version, input type (pasted HTML or URL), and any diagnostics shown by the plugin. Do not attach confidential source HTML to a public issue.

## License

[MIT](LICENSE)
