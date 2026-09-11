# Importer fixture baselines

This is Phase 1 regression evidence. Browser reference screenshots and direct
extractor scene captures are checked in, and the user has confirmed that the
fixture imports look correct in Penpot. The exact host/version/font metadata
and undo observations were not supplied, so those fields remain open for a
formal test record.

## Regenerate the browser evidence

```sh
npm run test:importer-fixtures
npm run baseline:importer
```

`baseline:importer` starts a loopback-only fixture server on port 4175, starts real Google
Chrome through `--remote-debugging-pipe`, and uses CDP to set the plugin's default
viewports: `desktop` / Desktop 1440×900, `tablet` / Tablet 768×1024, and
`mobile` / Mobile 390×844.
It rejects every HTTP(S) request except its fixed `127.0.0.1:4175` origin; the
only intentional 404 is `assets/intentional-missing.png` in
`asset-failures.html`; a missing or blocked subresource in every other fixture
fails the run. Every CDP operation has a deadline, and Chrome or either
debugging-pipe stream exiting/errors/closes rejects pending work, so a missing
Chrome binary fails clearly instead of leaving the command running.

It injects the actual `buildExtractorScript()` into the real page after regular
and bold font readiness, so scene evidence exercises browser layout and the
capture extractor. This is direct capture only, not a source-preparation or
HTTP-import-proxy end-to-end test; the focused Vitest command covers those
separate paths and imports the checked-in generated scenes into a mocked host.

The focused command runs exactly `src/capture/extractor.test.ts`,
`src/capture/prepareDocument.test.ts`, `src/capture/source.test.ts`, and
`src/importer/penpot.test.ts`; the last includes the generated-scene importer
regressions for clipping ancestry/bounds, compositing opacity, and failed-asset
placeholders across all three boards.

The command rewrites these checked-in artifacts:

- `src/capture/fixtures/baselines/*-desktop-1440.png`
- `src/capture/fixtures/baselines/*-tablet-768.png`
- `src/capture/fixtures/baselines/*-mobile-390.png`
- `src/capture/fixtures/baselines/metadata.json`
- `src/capture/fixtures/baselines/scene-evidence.json`

`metadata.json` records the Chrome product/revision; HTML, extractor, font, and
SVG input hashes; exact `innerWidth`, `innerHeight`, `devicePixelRatio`; and
regular/bold loaded `DejaVu Sans` faces. It also records the CSS layout metrics,
an explicit full-page screenshot clip, and the decoded PNG dimensions. The
filenames retain their established `desktop-1440`, `tablet-768`, and
`mobile-390` suffixes even though the scene viewport IDs now match the plugin.
Regeneration fails unless every width and height matches the default viewport,
device scale is 1, and both faces are loaded. The checked-in run was made with
Chrome 153.0.8010.36; do not replace the metadata version with an assumption
when Chrome changes.

`scene-evidence.json` retains the actual scene documents. The runner also
fails if it cannot see root/container asset reuse, nested two-axis clips and
the single-axis warning, alpha/opacity samples, a surviving `display: contents`
child, whitespace sample, or the local shared failed-asset response. It does
not run source preparation or the HTTP import proxy: the fixture pages are
already local, static HTML. That boundary is intentional and is covered by the
existing source/preparation tests rather than pretending this direct capture
is an end-to-end remote-page test.

## Fixture map

| Fixture | Reference purpose | Import assertion / expected result |
| --- | --- | --- |
| `background-images.html` | Root background, container backgrounds, repeated tile URL, bundled SVG image | One scene asset is reused for the repeated container tile; root background and image asset are present. |
| `overflow-clipping.html` | Existing nested/rounded/scroll clips and single-axis exception | Nested clips capture as clipping; `#single-axis` remains unclipped with `UNSUPPORTED_OVERFLOW`. |
| `color-opacity.html` | Existing fill/border/shadow alpha, nested opacity, decorated text, transparent text | Parent compositing opacity is retained once; CSS Color 4 warnings remain explicit. |
| `stacking-contents-whitespace.html` | Negative/auto/zero/positive stacking, omitted wrapper, pre-wrap/inline spaces, NBSP, `<br>`, and a comment | Child of `display: contents` survives; this is a browser reference for currently deferred stacking and whitespace fidelity. |
| `asset-failures.html` | Explicitly separated repeated 404 image/background URL | One local failed URL is captured as one scene asset; import tests require a named placeholder for every affected image, while upload work is deduplicated. |

The fixture font files are unmodified `DejaVuSans.ttf` and
`DejaVuSans-Bold.ttf` under `src/capture/fixtures/assets/`, with their hashes
and Bitstream Vera/DejaVu license notice in `DEJAVU-LICENSE.txt`. SVG assets
are bundled beside them. There are no CDN, webfont-provider, or external-image
dependencies.

## Live Penpot comparison procedure

1. In one terminal, run `npm run serve:importer-fixtures`. It serves the
   fixtures from `http://127.0.0.1:4174` with CORS headers; keep it running.
   For each fixture, copy its source HTML into the plugin and set its Base URL
   to the exact served page, for example
   `http://127.0.0.1:4174/background-images.html`. This step is required:
   raw pasted HTML alone cannot resolve its relative images or fixture font.
2. Capture the source browser at Desktop 1440×900, Tablet 768×1024, and Mobile
   390×844, device scale 1, and compare it with the matching checked-in
   screenshot at 100% zoom. Record `google-chrome --version`; the initial
   references report the exact Chrome version in `metadata.json`.
3. Before importing text, make `DejaVu Sans` regular and bold available to
   the actual Penpot host. For a self-hosted deployment, use that deployment's
   documented custom-font installation path and restart/reload it; for a
   hosted or desktop host, record whether this family is actually available.
   Do not infer host availability from the browser's successful `@font-face`
   load. Record the exact font files/version or the unavailable result.
4. Import all three viewport boards into a disposable Penpot file and compare
   at 100% zoom. Record the Penpot host URL/build/version, plugin build/commit,
   browser version, host font result, fixture name, date, and every mismatch.
   Keep screenshot or exported-file evidence with that record; none is checked
   in here because the user confirmation did not include host metadata or
   exported Penpot evidence.
5. Inspect the layer tree, not just pixels. Expect one top-level board per
   viewport; clipping samples create nested clipping boards only for two-axis
   clips, with ordinary groups for visible overflow; alpha/decorated text has a
   parent compositing group with direct text below it; `display: contents` has
   no wrapper layer but does have the surviving child; failed images show a
   separately named placeholder at every use. Background/image assets may be
   represented as fills or editable SVG groups according to the host API.
6. Verify undo without assuming a single global transaction: the importer
   currently completes one undo block per responsive board. Undo until every
   newly imported board is removed, redo the same number of steps, and verify
   no residual placeholder, group, or board remains. Record the observed undo
   count and host behavior.

Use this record template for a live pass:

| Fixture / viewport | Chrome | Penpot host/build | Plugin commit | Host `DejaVu Sans` regular/bold | Layer tree / pixels | Undo / redo | Mismatches |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | |

## Known Phase 1 mismatches and future policy

- The screenshots are browser references, not imported-Penpot screenshots.
  The user confirmed the fixture imports look correct in Penpot; exact host
  metadata and undo evidence are still pending documentation.
- CSS stacking order is not fully faithful yet: `z-index: auto` and numeric
  zero are not preserved as distinct paint-order values. Do not approve the
  stacking fixture as an importer fidelity pass until that later-phase work is
  complete.
- Whitespace capture still compacts repeated spaces/newlines in places;
  `pre-wrap`, indentation, tabs, NBSP boundaries, `<br>` line breaks, and a
  comment boundary are intentionally visible in the fixture so later work has
  a stable browser reference. Do not update the screenshot to hide an import
  mismatch.
- Local image/font URLs are correct only while the fixture server is running
  and supplied as the Base URL. A missing Base URL is a test setup failure,
  not a fixture regression.

For every future fidelity change, add or extend a minimal fixture, make a
behavioral assertion against its scene/import result, rerun the focused test
and `baseline:importer`, and review the changed browser screenshots plus scene
evidence. Refresh a checked-in reference only when the browser appearance is
intentionally changed and the metadata version/font checks are still present;
do not use reference updates to bless an untested live-host divergence.
