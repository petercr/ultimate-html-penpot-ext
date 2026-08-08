# Ultimate HTML to Penpot

A browser-only Penpot plugin that turns one pasted HTML page into editable desktop, tablet, and mobile boards. It uses deterministic browser layout extraction; no LLM or backend is involved.

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

- Pasted HTML/CSS or a complete HTTP(S) page URL, an optional HTTP(S) base URL for pasted markup, responsive viewport boards, and editable text, boxes, flex layouts, images, and inline SVG.
- Trusted-source script execution as an explicit opt-in, inside an opaque sandbox.
- Diagnostics and placeholders for canvas/video/iframe content, filters, masks, blend modes, blocked assets, and other content that cannot be safely represented.

Source remains in the browser. Remote assets are loaded directly from their host and can fail because of ordinary network or CORS constraints. This release imports one initial rendered state; it does not recreate interactions, hover states, or linked pages.

When running with `npm run dev`, URL imports first try the browser request and then use the local `/__html_to_penpot/fetch` proxy when the target does not allow CORS. The proxy is intended for local development, has a 15-second timeout and 10 MB response limit, and does not send credentials. A deployed plugin needs an equivalent HTTPS proxy (or the target must allow CORS). Pasted HTML remains available everywhere; provide its URL as the Base URL to resolve relative assets.
