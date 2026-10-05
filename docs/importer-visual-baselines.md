# Importer fixture baselines

This records the original Phase 1 fixtures and later CSS fidelity changes.
Browser reference screenshots and direct extractor scene captures are checked
in. The user confirmed the original fixture imports look correct in Penpot;
their exact host/version/font metadata and undo observations remain open for
a formal test record. Later fixtures have separate validation records:
[Transformed geometry](importer-transforms.md) includes a live pass.
[Per-side borders](importer-borders.md) records all three live viewport geometry
checks, a representative desktop visual pass, and mobile undo/redo.
[Image fitting](importer-image-fit.md) records all three saved-reload geometry
checks, a representative desktop visual comparison, mobile undo/redo, and
the host fallback-font and recovered save-failure observations.

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
capture extractor. The extractor replaces the transform of every supported
element with an identity matrix while it measures, so each screenshot and its
layout metrics are taken before the extractor runs; a screenshot taken afterwards
would show transformed layers unrotated. This is direct capture only, not a source-preparation or
HTTP-import-proxy end-to-end test; the focused Vitest command covers those
separate paths and imports the checked-in generated scenes into a mocked host.

The focused command runs exactly `src/capture/extractor.test.ts`,
`src/capture/extractor.transforms.test.ts`, `src/capture/extractor.borders.test.ts`,
`src/capture/extractor.images.test.ts`, `src/capture/prepareDocument.test.ts`,
`src/capture/source.test.ts`, `src/importer/penpot.test.ts`,
`src/importer/penpot.borders.test.ts`, `src/importer/images.test.ts`,
`src/importer/penpot.images.test.ts`, `src/importer/svgImage.test.ts`, and
`src/shared/validation.images.test.ts`; the importer tests include
the generated-scene importer regressions for clipping ancestry/bounds,
compositing opacity, failed-asset placeholders, transformed layers, and per-side borders across
all three boards, plus image fit/position, content clips, raster aspect
settings, and editable SVG viewport geometry. SVG root geometry and image
metadata validation tests cover unsupported sources and malformed payloads.

The command rewrites these checked-in artifacts:

- `src/capture/fixtures/baselines/*-desktop-1440.png`
- `src/capture/fixtures/baselines/*-tablet-768.png`
- `src/capture/fixtures/baselines/*-mobile-390.png`
- `src/capture/fixtures/baselines/metadata.json`
- `src/capture/fixtures/baselines/scene-evidence.json`

`metadata.json` records the Chrome product/revision; HTML, extractor, font,
SVG, and PNG input hashes; exact `innerWidth`, `innerHeight`, `devicePixelRatio`; and
regular/bold loaded `DejaVu Sans` faces. It also records the CSS layout metrics,
an explicit full-page screenshot clip, and the decoded PNG dimensions. The
filenames retain their established `desktop-1440`, `tablet-768`, and
`mobile-390` suffixes even though the scene viewport IDs now match the plugin.
Regeneration fails unless every width and height matches the default viewport,
device scale is 1, and both faces are loaded. The checked-in run was made with
Chrome 153.0.8010.52; do not replace the metadata version with an assumption
when Chrome changes.

`scene-evidence.json` retains the actual scene documents. The runner also
fails if it cannot see root/container asset reuse, nested two-axis clips and
the single-axis warning, alpha/opacity samples, negative/auto/zero/positive
stacking values with their positioned flags, a surviving `display: contents`
child, whitespace sample, the local shared failed-asset response, transformed
layers with their own size and rotation, no node for a collapsed element, or
the `UNSUPPORTED_TRANSFORM` warnings on the skewed and mirrored samples. The
border fixture also requires all four computed side values, scaled widths,
decorated text parenting, clipping ancestry, its bundled image asset, uniform
legacy fields without a per-side payload, and the expected unsupported style,
radius, image, and color diagnostics. It does
not run source preparation or the HTTP import proxy: the fixture pages are
already local, static HTML. That boundary is intentional and is covered by the
existing source/preparation tests rather than pretending this direct capture
is an end-to-end remote-page test.

The image fixture requires all 16 images' fit and natural dimensions,
percentage/pixel/edge positions, border/padding and compositing opacity,
rotation and uniform scale metadata, two reused successful source assets,
and no diagnostics. The current suite contains eight fixtures and 24
references. Image fitting added three references; the previous 21 screenshots
are byte-for-byte unchanged.

## Fixture map

| Fixture | Reference purpose | Import assertion / expected result |
| --- | --- | --- |
| `background-images.html` | Root background, container backgrounds, repeated tile URL, bundled SVG image | One scene asset is reused for the repeated container tile; root background and image asset are present. |
| `overflow-clipping.html` | Existing nested/rounded/scroll clips and single-axis exception | Nested clips capture as clipping; `#single-axis` remains unclipped with `UNSUPPORTED_OVERFLOW`. |
| `color-opacity.html` | Existing fill/border/shadow alpha, nested opacity, decorated text, transparent text | Parent compositing opacity is retained once; CSS Color 4 warnings remain explicit. |
| `stacking-contents-whitespace.html` | Negative/auto/zero/positive stacking, omitted wrapper, pre-wrap/inline spaces, NBSP, `<br>`, a comment, mixed formatting, centered/padded text, tab-indented code, and a font-stack sample | Stacking layers import in browser paint order even though the fixture DOM order differs; child of `display: contents` survives; whitespace imports with per-`white-space` spacing, NBSP, and tab stops preserved as content. |
| `asset-failures.html` | Explicitly separated repeated 404 image/background URL | One local failed URL is captured as one scene asset; import tests require a named placeholder for every affected image, while upload work is deduplicated. |
| `transforms.html` | Rotated box and card, corner `transform-origin`, translate, uniform scale, the individual `rotate`/`scale`/`translate` properties with a percentage translate, nested rotations, a rotated clip, a −90° label, a rotated image, skew, mirror, a collapsed element, and an inline span | Each rotated layer keeps its own size and has a clockwise `rotation` about its top-left corner; skew and mirror stay unrotated with `UNSUPPORTED_TRANSFORM`; the collapsed element creates no nodes. See [Transformed geometry](importer-transforms.md). |
| `per-side-borders.html` | Root borders, bottom-only decorated text, a left accent, four widths/colors with alpha and opacity, clipped child, rotation/scale, image borders, transparent/hidden/none sides, uniform/borderless controls, and unsupported radius/style/color/border-image cases | Differing sides retain all four computed border records; widths scale with the frame; uniform borders keep legacy paint fields. Unsupported border styles, asymmetric rounded corners, border images, and CSS Color 4 paints report explicit diagnostics. Border geometry is verified in all three live viewport imports, with a representative desktop visual pass and mobile undo/redo. See [Per-side borders](importer-borders.md). |
| `image-fit-position.html` | All five fits, both scale-down branches, percentages/pixels/edge offsets, raster and SVG sources, decoration/opacity, rotation, rounded content, uniform scale, and responsive widths | All 16 images retain intrinsic dimensions and normalized fit/position metadata. Import uses content clips, 13 raster rectangles, and three editable SVG viewport/group compositions. All three live viewports retain verified geometry after reload, with a representative desktop visual comparison and mobile undo/redo. See [Image fitting](importer-image-fit.md). |

The fixture font files are unmodified `DejaVuSans.ttf` and
`DejaVuSans-Bold.ttf` under `src/capture/fixtures/assets/`, with their hashes
and Bitstream Vera/DejaVu license notice in `DEJAVU-LICENSE.txt`. SVG assets
and the generated 240 × 120 px `image-fit-grid.png` are bundled beside them.
The raster's labeled corners and edges make crops visible. There are no CDN,
webfont-provider, or external-image dependencies.

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
5. Inspect the layer tree, not just pixels. For transforms, check that a
   rotated layer keeps its own width and height and shows the same rotation
   in the design panel (Penpot normalizes rotation to 0-360, so −8° reads
   352°). Expect one top-level board per
   viewport; clipping samples create nested clipping boards only for two-axis
   clips, with ordinary groups for visible overflow; alpha/decorated text has a
   parent compositing group with direct text below it; `display: contents` has
   no wrapper layer but does have the surviving child; failed images show a
   separately named placeholder at every use. Background/image assets may be
   represented as fills or editable SVG groups according to the host API.
   Per-side solid borders add separately editable paths below ordinary
   descendants; square asymmetric clipping containers add an inner transparent
   padding-box clip while retaining their original outer border box. Compare
   the clipped child's edges and the diagonal joins as well as the layer tree.
   Fitted images keep an outer border-box board, an inner content-box clip,
   and a separately sized/positioned image object. Supported SVG images add
   their own clipped viewport and editable vector group. Check content radii,
   crop edges, background through empty space, and opacity once on the outer
   board; [Image fitting](importer-image-fit.md) includes a live geometry verifier.
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
- CSS stacking order is faithful for the supported subset: `z-index: auto` is
  captured distinctly from numeric zero, siblings import in per-context paint
  order with stable source-order tie breaking, and the fixture DOM order
  differs from paint order so the regression has teeth.
- Whitespace is captured per computed `white-space`: `pre`/`pre-wrap` keep
  indentation and newlines (tabs expand to 8-space stops), `pre-line` keeps
  newlines while collapsing spaces, and normal text collapses runs without
  touching nonbreaking spaces. Comment-separated runs are combined as CSS
  renders them. The fixture covers mixed formatting, centered and padded
  text, a tab-indented code block, and a font-stack fallback sample.
- Pseudo-element content keeps its old compacted form; only element text runs
  follow the per-`white-space` policy above.
- Local image/font URLs are correct only while the fixture server is running
  and supplied as the Base URL. A missing Base URL is a test setup failure,
  not a fixture regression.

For every future fidelity change, add or extend a minimal fixture, make a
behavioral assertion against its scene/import result, rerun the focused test
and `baseline:importer`, and review the changed browser screenshots plus scene
evidence. Refresh a checked-in reference only when the browser appearance is
intentionally changed and the metadata version/font checks are still present;
do not use reference updates to bless an untested live-host divergence.

## Text capture policy

Line-preserving text remains the default: every source line becomes its own
non-wrapping text layer at its measured position, so the import matches the
browser even when the Penpot host substitutes wider fallback fonts. The
tradeoff is editability: editing one line never reflows its neighbors, and
the layer tree has one layer per line instead of one per paragraph. This is
the snapshot-importer contract, not a layout conversion; native reflowing
text belongs to the Phase 6 layout milestone.

Per-line layers carry measured bounds (`textMaxWidth`, `textFitScale`) so an
overflowing fallback font shrinks toward its source width instead of painting
over neighboring content. Runs longer than 20,000 characters skip
per-character measurement and import as a single collapsed layer.

Whitespace-only text, including nonbreaking spaces, is preserved as content.
When its captured name is empty or only whitespace, the importer names the
layer `Text` so Penpot accepts it. Other blank layer names use `Layer`.
