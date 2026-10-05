# HTML importer upgrade plan

Status: in progress.

## Objective

Improve visual fidelity and predictable imports first, then improve performance and native Penpot editability. Preserve the separation between browser capture, the scene document, and Penpot object creation.

This plan follows a code review of `src/capture`, `src/importer/penpot.ts`, the scene contracts and validation, and the plugin/UI lifecycle. The suite has focused capture/import behavior plus checked-in real-Chrome fixture evidence. The fixture imports have also been visually checked in Penpot; exact host/version/font metadata and undo observations still need to be recorded if this is delivered as formal evidence.

## Phase 1 — Regression fixtures and visual baseline

- [x] Add extraction tests that execute the sandbox and inspect the resulting scene, supplementing the generated-script string checks.
- [x] Create small HTML fixtures for root/container/reused background images, nested clipping, alpha/opacity, stacking, `display: contents`, whitespace, and failed assets. Existing color/opacity and overflow fixtures are retained and expanded with stable scene IDs.
- [x] Use bundled SVG assets plus unmodified licensed DejaVu Sans regular/bold files; keep the one local controlled-404 fixture separate from normal offline cases.
- [x] Capture reference screenshots at desktop 1440, tablet 768, and mobile 390 CSS widths, with `innerWidth`, device scale 1, and font readiness recorded in metadata.
- [x] Document a repeatable live Penpot comparison workflow, including host/browser versions, font install/availability, expected layer structure, and undo checks. The user confirmed the fixture imports look correct in Penpot; host/version/font metadata was not supplied.
- [x] Add focused behavioral capture/import coverage and scene evidence; retain the requirement that every later fidelity change adds its own focused regression.

Acceptance: each fidelity change has a focused behavioral test and a reproducible visual comparison. Tests validate output, not merely the presence of implementation strings. Phase 1 provides browser-reference evidence and a user-confirmed Penpot visual pass; formal host metadata and undo evidence remain documentation follow-ups.

## Phase 2 — Highest-impact fidelity fixes

### 2.1 Container and root background images

Relevant code: `createShape()`, `createContainerBackdrop()`, and root rendering in `src/importer/penpot.ts`.

- [x] Share asset-fill resolution between ordinary shapes, container backdrops, and root boards.
- [x] Preserve background color beneath image fills where supported.
- [x] Extend the scene contract to capture background size, position, and repeat for correctly placing repeating data-URI SVG backgrounds; materialize those backgrounds into viewport-sized tiled SVG assets.
- [x] Define handling for multiple background layers; preserve the topmost layer and report omitted lower layers explicitly.
- [x] Test a hero image behind a heading, a body background, and reuse of the same asset across viewports.

Acceptance: adding child content to an element does not cause its background image to disappear; supported background placement matches the fixture.

### 2.2 Nested overflow clipping

Relevant code: `applyPaint()` and the container branch of `render()` in `src/importer/penpot.ts`.

- [x] Verify the clipping surface of the installed Penpot API: `Board.clipContent` clips deterministically on both axes, while `Group.makeMask()` depends on child ordering, which is what made the earlier attempt hide content.
- [x] Verify the new clipping boards in the live Penpot host, including layer-tree readability. The user confirmed the fixture imports look correct; undo behavior was not separately recorded.
- [x] Use a clipping-capable container where CSS requires clipping, while retaining simple groups elsewhere. A clipping container is now a nested board that paints its own fill, border, radius, and shadow, rather than a group plus a backdrop rectangle.
- [x] Preserve source bounds independently of descendant bounds and keep child coordinates correct. A board keeps the captured element's box; a group would have grown to enclose an overflowing child.
- [x] Capture overflow axes separately; define and diagnose combinations that cannot be reproduced. `scroll` and `auto` clip like `hidden`; a single clipped axis is left unclipped and reported as `UNSUPPORTED_OVERFLOW`, because hiding content the browser shows is worse than leaving it visible.
- [x] Test oversized children, rounded cards, nested clips, and visible overflow.

Reference evidence: `npm run baseline:importer` uses Chrome's DevTools pipe and `Emulation.setDeviceMetricsOverride`; `src/capture/fixtures/baselines/metadata.json` records verified 1440/768/390 `innerWidth` values and device scale 1, while `scene-evidence.json` records the clipping nodes and single `UNSUPPORTED_OVERFLOW` diagnostic per viewport. The checked-in screenshots are browser references. The user confirmed the clipping boards look correct in Penpot; undo evidence remains unrecorded.

Acceptance: content stays within the intended clip, including supported rounded corners, without shifting descendants.

### 2.3 Color alpha and element opacity

Relevant code: `cssColor()`, `cssGradient()`, `applyPaint()`, `createText()`, and `appendText()`.

- [x] Represent color and alpha separately for fills, strokes, shadows, and gradient stops.
- [x] Apply CSS element opacity once to the appropriate shape or compositing container.
- [x] Remove duplicated parent opacity from synthetic direct-text children.
- [x] Preserve percentage gradient stop positions and alpha for supported linear and radial gradients; length-based stop positions retain interpolated offsets.
- [x] Define capture diagnostics for CSS Color 4 formats outside the supported parser; unsupported gradient stops now omit the whole gradient rather than silently changing it.
- [x] Test translucent fills, borders, shadows, nested opacity, transparent text, and decorated text at 50% opacity.

Reference evidence: `npm run baseline:importer` uses Chrome's DevTools pipe and verifies 1440/768/390 `innerWidth` values rather than relying on raw `--window-size=390`. The color/opacity scene evidence retains the decorated parent at opacity 0.5, direct text at opacity 1, and the expected CSS Color 4 diagnostics. Screenshots are checked in; the user confirmed the color/opacity fixture looks correct in Penpot.

Acceptance: color alpha and element opacity combine correctly; a solid element with `opacity: .5` is not unintentionally reduced to .25.

## Phase 3 — Capture correctness and paint order

### 3.1 Visible descendants

- [x] Separate whether an element produces a scene node from whether its descendants should be visited.
- [x] Traverse `display: contents` and zero-sized wrappers with visible descendants.
- [x] Preserve subtree suppression for `display: none` and fully transparent compositing groups.
- [x] Handle descendants that override an ancestor's `visibility: hidden`.
- [x] Assign children to the correct surviving scene ancestor when a wrapper has no node.
- [x] Stop an undecorated single-child container from taking over its child's identity. The importer collapses such a wrapper onto its only child and then applies the wrapper's name and source to it, so the child's own name is lost. Since Phase 2.2 that child can be a clipping board, which makes the layer tree name a clip after the wrapper around it. This is long-standing behavior, not a Phase 2.2 regression; the collapse itself is worth keeping, only the metadata overwrite is wrong.

Acceptance: visible descendants survive wrapper omission, hidden subtrees remain absent, and a collapsed wrapper does not rename the layer it collapses into.

Reference evidence: `src/capture/extractor.test.ts` ("parents omitted-wrapper children to the surviving scene ancestor") covers nested `display: contents` omission with DOM order and `visibility: hidden` override parenting; `src/importer/penpot.test.ts` ("keeps the surviving child's identity when an undecorated wrapper collapses") covers a wrapper collapsing onto a clipping board without renaming it, and the generated opacity scene test now asserts the collapsed wrapper leaves no rename trace while compositing opacity still applies once.

### 3.2 Stacking order

- [x] Preserve `z-index: auto` separately from numeric zero; avoid substituting traversal sequence for explicit zero.
- [x] Capture enough stacking-context information to reproduce supported CSS paint order.
- [x] Order siblings and context contents with stable source-order tie breaking.
- [x] Verify that Penpot grouping preserves the intended backdrop and child order.
- [x] Test negative, zero, and positive z-index; positioned overlaps; and nested contexts caused by opacity or transforms.

Acceptance: overlap fixtures match browser paint order without globally sorting unrelated stacking contexts.

Reference evidence: the scene contract carries `zIndexAuto` (auto stored as 0, explicit zero without the flag) and `layout.positioned`; synthetic text runs inherit their element's stacking position instead of a fractional offset. The importer sorts each parent's children by paint order (negative, in-flow, positioned auto/zero, positive) with a source-order tie break and never across contexts. Siblings append topmost-first because Penpot's default plugin flags insert each `appendChild` at index 0 behind existing children (see `app.plugins.shape` in penpot/penpot), leaving live shapes in browser back-to-front order; group members run back-to-front with the backdrop behind. An earlier bottom-first append order rendered the stacking fixture exactly inverted in live Penpot (negative on top, positive behind); corrected after a live screenshot showed the inversion. `stacking-contents-whitespace.html` lists its layers positive-first in DOM order with pixel-identical screenshots, and the importer test asserts the topmost-first append order across all three viewports; unit tests cover positioned overlaps and an opacity-nested context.

### 3.3 Text whitespace and placement

- [x] Respect computed `white-space` rather than compacting all text unconditionally.
- [x] Preserve meaningful spaces across inline element boundaries, nonbreaking spaces, preformatted indentation, and explicit line breaks.
- [x] Capture all direct text nodes, including text separated by comments or other non-rendered nodes.
- [x] Use measured text bounds consistently for single-line and multiline content.
- [x] Add fixtures for mixed formatting, centered text, padded text, code blocks, and font fallback.
- [x] Define whether line-preserving text remains the default and document its editing tradeoff.

Acceptance: fixture text retains its content, spacing, and line placement without missing runs or accidental reflow.

Reference evidence: the extractor processes text per computed `white-space` (`pre` keeps spaces/newlines with tabs expanded to 8-space stops, `pre-line` keeps newlines while collapsing spaces, normal collapsing matches the old output except NBSP is never collapsed), combines comment-separated runs before processing, and measures every run individually for line splitting and bounds. `stacking-contents-whitespace.html` adds mixed-formatting, centered, padded, tab-indented code, and font-stack samples with runner assertions on indentation, tab stops, NBSP, and run content; the importer test asserts the same preserved content across all three viewports. Line-preserving text stays the default; see "Text capture policy" in `docs/importer-visual-baselines.md` for the editing tradeoff. Generated pseudo-element text now follows the same policy (Phase 5).

## Phase 4 — Reliable assets and import lifecycle

### 4.1 Asset failures and diagnostics

- [x] Inline absolute, lazy-loaded, `srcset`, extensionless, and SVG-embedded image references before sandbox capture.
- [x] Normalize serialized SVG namespaces/presentation styles (including CSS classes from external SVG `<img>` assets) and keep each SVG as one scene asset to avoid duplicate layers.
- [x] Cache both successful and failed asset resolutions across responsive boards.
- [x] Render a visible, named placeholder when an image cannot be imported.
- [x] Return import-time diagnostics to the UI, including asset source and failure reason.
- [x] Distinguish editable SVG success, raster fallback, and complete failure.
- [x] Test a repeated failing URL and cancellation during an asset operation.

Acceptance: one failing shared asset does not trigger repeated uploads, silently disappear, or prevent unrelated layers from importing.

Reference evidence: failed media uploads remain cached and render named placeholders. The importer now emits `ASSET_IMPORT_FAILED` diagnostics for every affected layer, including its captured source, source asset, viewport, and Penpot upload reason; the plugin forwards those diagnostics to the active UI run. `src/importer/penpot.test.ts` covers a shared failed URL across boards, asserts both source URL and upload reason are returned, and holds a media upload open to verify cancellation removes the partial board after that operation completes.

### 4.2 Scene validation and workload limits

- [x] Validate paint, text styles, layouts, asset fields, and diagnostics before host mutation.
- [x] Reject duplicate node IDs and cycles; reject missing parents, conflicting child references, duplicate assets, and missing asset references.
- [x] Bound total scene count, aggregate layers, dimensions, and payload size for the whole import.
- [x] Enforce capture limits during traversal so oversized documents stop before constructing and posting an excessive scene.
- [x] Show actionable errors and verify invalid scenes create no Penpot objects.

Acceptance: malformed or oversized scenes fail predictably before import rather than producing incomplete trees or host API errors.

Reference evidence: the extractor checks document width/height before traversing, then reserves capacity before every element, text-run, pseudo-element, and distinct asset. It emits an actionable `CAPTURE_ERROR` rather than posting a partial scene when one of the 20,000-node/asset or 100,000px limits is exceeded. `extractor.test.ts` covers width and node-limit failures; the plugin validates before calling the importer, and `penpot.test.ts` confirms a malformed parent reference is rejected while no Penpot objects are created. Browser baseline regeneration completed without pixel changes.

### 4.3 Capture, cancellation, and stale results

- [x] Use one capture deadline that accounts for font/image waits, user settle delay, and DOM settling.
- [x] Ensure iframe listeners and timers are cleaned up on preparation errors as well as success and timeout.
- [x] Add cancellation to source preparation and viewport capture where supported.
- [x] Prevent an older capture from replacing results after the user changes input or starts another run.
- [x] Guard against concurrent imports and correlate progress/completion with the active run.
- [x] Verify cancellation and failure cleanup, including undo behavior in live Penpot.

Reference evidence: analysis has a single 30-second deadline beginning before source preparation, so remote HTML, stylesheet/font/image inlining, the requested settle delay, DOM settling, and all viewport captures share one budget. `AbortController` reaches direct/proxied source fetches and capture iframes; `src/capture/sandbox.test.ts` verifies an in-flight capture removes its iframe on cancellation, while `source.test.ts` verifies a cancelled fetch is not retried through the proxy. Each UI capture and import has a fresh run ID. Input changes abort the old capture; UI ignores plugin messages whose run ID is no longer active; and the plugin declines concurrent imports and tags progress/completion/error messages with the active run ID. The user manually confirmed cancellation cleanup and undo/redo behavior in their local Penpot test.

Acceptance: cancelled or superseded work cannot mark a newer run complete, leave capture resources behind, or retain partial imported boards.

## Phase 5 — Performance and remaining CSS fidelity

- [x] Measure capture and import time by phase, node count, and asset count using small, medium, and large fixtures. The first benchmark uses the actual opaque capture sandbox in Chrome and a mocked Penpot API; live host upload/persistence timings remain a follow-up.
- [x] Reduce repeated style and geometry reads within a capture pass. Cache element styles for the synchronous traversal, reuse measured wrapped-text layouts, and avoid geometry reads for suppressed subtrees.
- [x] Optimize per-character text measurement while preserving verified line boundaries and Unicode text. Single-line runs use existing Range rectangles; wrapped runs stream whole graphemes, with a code-point fallback for older browsers.
- [x] Replace unconditional per-layer yielding with a measured batch/time budget that keeps progress and cancellation responsive. Yield after 4 ms or 100 visited nodes, including empty and clipping containers; check cancellation during host settling and the final board flush.
- [x] Evaluate bounded asset concurrency; preserve deduplication and import order. Up to three media uploads share in-flight promises and cached failures; creation and SVG conversion remain serial. Controlled benchmark output hashes match and regression tests verify cancellation, rollback of unattached layers, and draining active host calls.
- [x] Verify persistence limits on large single boards. Boards with at least 500 scene nodes now wait for save notifications every 250 nodes and after remaining mutations. A live 1,000-node board survives a confirmed saved reload; all five save requests return HTTP 200 and stay below 2 MB. Mock workloads pass through 20,000 nodes. A live 500-node board imports in one undo block: one undo removes it, one redo restores it, and both saves return HTTP 200. The live upper limit is deferred and remains unverified; node batching does not impose a byte ceiling on complex shapes or SVGs.
- [x] Correct transformed geometry using untransformed dimensions plus transforms, avoiding rotation of an already transformed bounding box. Rotation, uniform scale, translation, and the individual `rotate`/`scale`/`translate` properties compose, with nesting and `transform-origin`, into one frame per layer: its own size plus a clockwise rotation about its top-left corner. Skew, mirroring, non-uniform scale, and 3D keep browser bounds with an `UNSUPPORTED_TRANSFORM` warning, and collapsed elements import nothing.
- [x] Add per-side borders in a fixture-backed change. Differing square solid sides become editable border paths; uniform solid/dashed/dotted borders retain native inside strokes. Unsupported styles, asymmetric rounded corners, and border images report diagnostics. All three viewport imports have verified border geometry in Penpot 2.18.1, with a representative desktop visual pass and mobile undo/redo ([border evidence](docs/importer-borders.md)).
- [x] Add image object-fit/object-position in a separate, fixture-backed change. All five fits, percentage/pixel/edge positions, content-box clips, raster sizing, and editable SVG viewport geometry are supported for the defined subset. The 16-case fixture adds three references while the previous 21 screenshots are unchanged. All three live viewport geometries survive a saved reload, with a representative desktop visual comparison and mobile undo/redo. SVG fallback, unequal-inset rounding, host font substitution, and recovered save failures are documented ([image evidence](docs/importer-image-fit.md)).
- [x] Add pseudo-element geometry in a separate, fixture-backed change. Each rendered `::before`/`::after` is measured by briefly standing a real element with its computed style in its place, so positioned, block, inline, flex-item, and `display: contents`/zero-size-host cases all take the browser's own box. Boxes keep fill, border, radius, image, opacity, and similarity transforms; generated text lands at its measured lines, with `white-space` preserved. Counter, image, and quote `content` is reported (`UNSUPPORTED_PSEUDO_CONTENT`). Browser references, regressions, and a live Penpot pass at all three viewports (geometry, visual, tablet undo/redo and saved reload) are recorded; the pass also caught and fixed SVG-background opacity ([pseudo-element evidence](docs/importer-pseudo-elements.md)).
- [x] Diagnose unsupported CSS instead of silently implying full fidelity. Outlines, extra box shadows, `clip-path`, `background-clip: text`, `background-blend-mode`, text shadows, decoration styles, vertical or right-to-left text, ellipsis/line-clamp truncation, list markers, and form-control values are reported once per feature with the first source and a count, while the layer stays editable. The panel de-duplicates findings across viewports and expands the remainder. A 14-tile fixture adds three references with every earlier screenshot and scene unchanged, and the tablet scene imported live. Undetected gaps are listed ([unsupported CSS evidence](docs/importer-unsupported-css.md)).

Acceptance: publish before/after timings from the same fixtures, with no visual regression or reduction in cancellation responsiveness. Each added CSS feature has a defined supported subset.

First-batch evidence: [Importer performance measurements](docs/importer-performance.md) records three runs of each fixture size across the default viewports, raw measurements, scene hashes, and cancellation/heartbeat probes. All 15 existing browser screenshots and all generated fixture scenes are unchanged. The benchmark measures this repository's import processing with a mock host; it does not establish Penpot's persistence limits or constitute a new live Penpot visual pass. [Asset and persistence evidence](docs/importer-assets-and-persistence.md) adds matching output hashes with 33–62% faster controlled uploads and a successful saved reload in the live host. [Transformed geometry evidence](docs/importer-transforms.md) covers the new `transforms.html` fixture, its scene and screenshot baselines, unit and importer tests, and a live Penpot 2.18.1 pass in which every rotation and corner on the imported board matched. [Per-side border evidence](docs/importer-borders.md) records the supported subset, browser references, passing regressions, all three live viewport border geometry checks, a representative desktop visual pass, and mobile undo/redo. [Image fitting](docs/importer-image-fit.md) records the completed supported subset, browser references, regressions, all three saved-reload geometry checks, a representative desktop visual comparison, mobile undo/redo, and SVG/rounding/font limitations. [Pseudo-element geometry](docs/importer-pseudo-elements.md) records the measured-stand-in approach, the supported subset, its diagnostics, three browser references, regressions, and the live pass. [Unsupported CSS](docs/importer-unsupported-css.md) records the eleven diagnosed features, the repeat-counting and panel behavior, the three-viewport fixture, the live tablet import, and the features still not detected. Every Phase 5 item is complete; the only open caveat is the deferred live upper persistence limit.

## Phase 6 — Optional native layout conversion

- [x] Keep the fixed snapshot representation available for visual fidelity. It stays the default; native layouts are an opt-in Advanced setting, and everything the conversion cannot reproduce stays a fixed snapshot.
- [x] Define a conservative subset of flex layouts that can map to native Penpot layout. Row and column containers with gap, padding, supported justification and alignment, nested containers, and absolute children; wrap, reverse, baseline, rotation, mixed stacking, and per-side borders stay fixed.
- [x] Convert direction, gap, padding, alignment, sizing, and absolute children only where their semantics are supported. Sizing stays fixed (no hug, grow, or shrink); a uniform border is added to the padding; absolute children are flagged and kept at their offset.
- [x] Fall back to captured geometry when conversion would change the initial appearance. A container must match a flex model against the browser's positions, and the host's result is verified after import; a layout that did not run or ran differently is removed and the captured offsets restored.
- [x] Test resizing and text editing after import, not just initial rendering. Live: widening, child resizing, appending, and text editing all reflow as expected; one Undo, one Redo, and a saved reload preserve 29 layouts.
- [x] Assess grid conversion separately after the flex subset is stable. Assessed and deferred: the capture does not record grid tracks or item placement.
- [x] Update UI and README language to distinguish viewport snapshots from layouts that respond to editing and resizing. ([native layout evidence](docs/importer-native-layout.md))

Acceptance: supported native layouts preserve their initial appearance and behave predictably when edited; unsupported structures retain a usable snapshot.

Phase 6 evidence: [Native flex layouts](docs/importer-native-layout.md) records the model, the supported and kept-fixed subsets, the fixture, the live host observations, and the known limits (fixed sizing, and bare text columns that fall back).

## Delivery checklist

- [ ] Ship focused changes in phase order, with Phase 1 fixtures added alongside the relevant fixes.
- [ ] Run focused regression tests during development and the complete existing suite before each delivery.
- [ ] Run the production build and relevant typechecks for changed components.
- [ ] Compare affected fixtures in a real browser and live Penpot before declaring visual fixes complete.
- [ ] Update support documentation and diagnostics for any remaining limitation.
- [ ] Record completed checklist items, validation evidence, and any deferred scope in the change description.

Next batch: every planned phase is implemented. Native flex layouts ([evidence](docs/importer-native-layout.md)) ship opt-in with fixed sizing; follow-ups, if pursued, are recording text line boxes so bare text columns convert, `flex-grow` as fill sizing, wrapping and reverse directions, and grid after its tracks are captured. Phase 5 is complete apart from the deferred live upper persistence limit. Unsupported-CSS diagnostics are implemented ([evidence](docs/importer-unsupported-css.md)): 415 tests, typechecks, the production build, and three new browser references pass with every earlier reference unchanged. Pseudo-element geometry is implemented and fixture-backed ([evidence](docs/importer-pseudo-elements.md)): 404 tests, typechecks, the production build, and three new browser references pass with every earlier reference unchanged, and its live Penpot pass is recorded (geometry at all three viewports, visual comparison, tablet undo/redo and saved reload). The image object-fit/object-position step is complete for its defined subset: [Image fitting](docs/importer-image-fit.md) records 390 passing tests, focused fixture regressions, typechecks and build checks, all three saved-reload geometry checks, a representative desktop visual comparison, and mobile undo/redo. Earlier tablet and undo/redo save requests failed without a recorded response; a fresh tablet import saved successfully, and every viewport survived reload. The failure cause remains unknown. The host uses Inter in place of unavailable DejaVu Sans, so typography is outside the image verification scope. Prior border and transform steps retain their completed live records. Bounded asset uploads and single-board persistence are complete apart from the deferred live upper limit ([evidence](docs/importer-assets-and-persistence.md)); broader unsupported-CSS diagnostics remain. Native layout conversion is a later milestone.
