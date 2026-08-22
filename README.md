# Ultimate HTML to Penpot

A browser-only Penpot plugin that turns pasted HTML into editable desktop, tablet, and mobile boards. It uses deterministic browser layout extraction; no LLM or production backend is involved in v0.1.0.

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

Pasting HTML is the reliable v0.1.0 workflow. Direct page URLs and remote images, fonts, stylesheets, or SVG assets can fail when their host does not permit browser access. This release imports one initial rendered state; it does not recreate interactions, hover states, or linked pages.

When running with `npm run dev`, URL imports first try the browser request and then use the local `/__html_to_penpot/fetch` proxy when the target does not allow CORS. The proxy is intended for local development, has a 15-second timeout and 10 MB response limit, and does not send credentials. A deployed plugin needs an equivalent HTTPS proxy (or the target must allow CORS). Pasted HTML remains available everywhere; provide its URL as the Base URL to resolve relative assets.

## Production deployment

The v0.1.0 release is designed for static hosting on Vercel. Netlify, Cloudflare Pages, or any HTTPS static host that supports response headers also works.

### Vercel

1. Import this repository into Vercel (Other framework preset).
2. Use `npm ci && npm run build` as the build command.
3. Set the output directory to `dist`.
4. Keep the generated production hostname stable; the install URL is `https://<hostname>/manifest.json`.
5. Install that manifest URL in a fresh Penpot account before submitting it to Penpot Hub.

The committed `vercel.json` sends `Access-Control-Allow-Origin: *` for every path so Penpot can load the manifest and bundle cross-origin, applies short caching to `manifest.json` and `plugin.js`, and caches hashed UI assets immutably.

### Cloudflare Pages or Netlify

Use the same build command (`npm ci && npm run build`) and publish the `dist` directory. The committed `public/_headers` file carries the identical CORS and cache policy for those hosts.

Pull requests and pushes to `main` run tests and the production build in GitHub Actions, including a bundle check that validates the manifest paths, permissions, icon, CORS headers, and the Vercel configuration.

## Privacy and security

- Pasted HTML is parsed and rendered inside the plugin's browser sandbox. It is not uploaded to a service operated by this project.
- Remote assets are requested directly from the asset's original host without credentials. Those hosts receive ordinary network request metadata such as the user's IP address.
- Direct page URL imports also use credential-free browser requests. In local development only, a local proxy can fetch a page when browser CORS prevents the direct request.
- Running scripts is off by default and should be enabled only for trusted source HTML.
- The plugin requests Penpot's `content:write` permission so it can create editable boards and layers.

Do not paste confidential HTML or enable scripts from an untrusted source. A hardened production URL-fetch service is intentionally deferred beyond v0.1.0.

## Support

Report bugs and request features through [GitHub Issues](https://github.com/petercr/ultimate-html-penpot-ext/issues). Include the browser, Penpot version, input type (pasted HTML or URL), and any diagnostics shown by the plugin. Do not attach confidential source HTML to a public issue.

## License

[MIT](LICENSE)
