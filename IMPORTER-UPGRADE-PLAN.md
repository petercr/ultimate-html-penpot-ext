# HTML importer upgrade plan

Status: in progress.

## Objective

Improve visual fidelity and predictable imports first, then improve performance and native Penpot editability. Preserve the separation between browser capture, the scene document, and Penpot object creation.

This plan follows a code review of `src/capture`, `src/importer/penpot.ts`, the scene contracts and validation, and the plugin/UI lifecycle. The baseline suite passes: 124 tests across 14 files. The findings are code-based; live browser and Penpot validation remains to be done.

## Phase 1 — Regression fixtures and visual baseline

- [ ] Add browser-based extraction tests that execute the sandbox and inspect the resulting scene, supplementing the existing generated-script string checks.
- [ ] Create small HTML fixtures for background images, nested clipping, alpha/opacity, stacking, `display: contents`, whitespace, and failed assets.
- [ ] Use bundled assets and fonts for deterministic fixtures; keep network-failure cases separate.
- [ ] Capture reference screenshots at desktop, tablet, and mobile widths.
- [ ] Document a repeatable live Penpot comparison workflow, including host version, font availability, and expected layer structure.
- [ ] Add regression coverage with each fix below; avoid requiring all future fixtures before starting implementation.

Acceptance: each fidelity change has a focused behavioral test and a reproducible visual comparison. Tests validate output, not merely the presence of implementation strings.

## Phase 2 — Highest-impact fidelity fixes

### 2.1 Container and root background images

Relevant code: `createShape()`, `createContainerBackdrop()`, and root rendering in `src/importer/penpot.ts`.

- [x] Share asset-fill resolution between ordinary shapes, container backdrops, and root boards.
- [x] Preserve background color beneath image fills where supported.
- [ ] Extend the scene contract to capture background size, position, and repeat when needed for correct placement.
- [ ] Define handling for multiple background layers; report unsupported combinations explicitly.
- [ ] Test a hero image behind a heading, a body background, and reuse of the same asset across viewports.

Acceptance: adding child content to an element does not cause its background image to disappear; supported background placement matches the fixture.

### 2.2 Nested overflow clipping

Relevant code: `applyPaint()` and the container branch of `render()` in `src/importer/penpot.ts`.

- [ ] Verify available clipping and masking behavior in the installed Penpot API and live host.
- [ ] Use a clipping-capable container where CSS requires clipping, while retaining simple groups elsewhere. (Deferred: the initial `Group.makeMask()` implementation hid content in live Penpot mobile output; verify mask ordering and coordinate behavior before retrying.)
- [ ] Preserve source bounds independently of descendant bounds and keep child coordinates correct.
- [ ] Capture overflow axes separately; define and diagnose combinations that cannot be reproduced.
- [ ] Test oversized children, rounded cards, nested clips, and visible overflow.

Acceptance: content stays within the intended clip, including supported rounded corners, without shifting descendants.

### 2.3 Color alpha and element opacity

Relevant code: `cssColor()`, `cssGradient()`, `applyPaint()`, `createText()`, and `appendText()`.

- [x] Represent color and alpha separately for fills, strokes, shadows, and gradient stops.
- [x] Apply CSS element opacity once to the appropriate shape or compositing container.
- [x] Remove duplicated parent opacity from synthetic direct-text children.
- [ ] Preserve gradient stop positions and alpha for supported gradients.
- [ ] Define normalization or diagnostics for color formats outside the supported parser.
- [ ] Test translucent backgrounds, shadows, nested opacity, and decorated text at 50% opacity.

Acceptance: color alpha and element opacity combine correctly; a solid element with `opacity: .5` is not unintentionally reduced to .25.

## Phase 3 — Capture correctness and paint order

### 3.1 Visible descendants

- [x] Separate whether an element produces a scene node from whether its descendants should be visited.
- [x] Traverse `display: contents` and zero-sized wrappers with visible descendants.
- [x] Preserve subtree suppression for `display: none` and fully transparent compositing groups.
- [x] Handle descendants that override an ancestor's `visibility: hidden`.
- [ ] Assign children to the correct surviving scene ancestor when a wrapper has no node.

Acceptance: visible descendants survive wrapper omission, and hidden subtrees remain absent.

### 3.2 Stacking order

- [ ] Preserve `z-index: auto` separately from numeric zero; avoid substituting traversal sequence for explicit zero.
- [ ] Capture enough stacking-context information to reproduce supported CSS paint order.
- [ ] Order siblings and context contents with stable source-order tie breaking.
- [ ] Verify that Penpot grouping preserves the intended backdrop and child order.
- [ ] Test negative, zero, and positive z-index; positioned overlaps; and nested contexts caused by opacity or transforms.

Acceptance: overlap fixtures match browser paint order without globally sorting unrelated stacking contexts.

### 3.3 Text whitespace and placement

- [ ] Respect computed `white-space` rather than compacting all text unconditionally.
- [ ] Preserve meaningful spaces across inline element boundaries, nonbreaking spaces, preformatted indentation, and explicit line breaks.
- [ ] Capture all direct text nodes, including text separated by comments or other non-rendered nodes.
- [ ] Use measured text bounds consistently for single-line and multiline content.
- [ ] Add fixtures for mixed formatting, centered text, padded text, code blocks, and font fallback.
- [ ] Define whether line-preserving text remains the default and document its editing tradeoff.

Acceptance: fixture text retains its content, spacing, and line placement without missing runs or accidental reflow.

## Phase 4 — Reliable assets and import lifecycle

### 4.1 Asset failures and diagnostics

- [ ] Cache both successful and failed asset resolutions across responsive boards.
- [ ] Render a visible, named placeholder when an image cannot be imported.
- [ ] Return import-time diagnostics to the UI, including asset source and failure reason.
- [ ] Distinguish editable SVG success, raster fallback, and complete failure.
- [ ] Test a repeated failing URL and cancellation during an asset operation.

Acceptance: one failing shared asset does not trigger repeated uploads, silently disappear, or prevent unrelated layers from importing.

### 4.2 Scene validation and workload limits

- [ ] Validate paint, text styles, layouts, asset fields, and diagnostics before host mutation.
- [ ] Reject duplicate node IDs and cycles; define consistent handling of missing parents and conflicting child references.
- [ ] Bound total scene count, aggregate layers, dimensions, and payload size for the whole import.
- [ ] Enforce capture limits during traversal so oversized documents stop before constructing and posting an excessive scene.
- [ ] Show actionable errors and verify invalid scenes create no Penpot objects.

Acceptance: malformed or oversized scenes fail predictably before import rather than producing incomplete trees or host API errors.

### 4.3 Capture, cancellation, and stale results

- [ ] Use one capture deadline that accounts for font/image waits, user settle delay, and DOM settling.
- [ ] Ensure iframe listeners and timers are cleaned up on preparation errors as well as success and timeout.
- [ ] Add cancellation to source preparation and viewport capture where supported.
- [ ] Prevent an older capture from replacing results after the user changes input or starts another run.
- [ ] Guard against concurrent imports and correlate progress/completion with the active run.
- [ ] Verify cancellation and failure cleanup, including undo behavior in live Penpot.

Acceptance: cancelled or superseded work cannot mark a newer run complete, leave capture resources behind, or retain partial imported boards.

## Phase 5 — Performance and remaining CSS fidelity

- [ ] Measure capture and import time by phase, node count, and asset count using small, medium, and large fixtures.
- [ ] Reduce repeated style and geometry reads within a capture pass.
- [ ] Optimize per-character text measurement while preserving verified line boundaries and Unicode text.
- [ ] Replace unconditional per-layer yielding with a measured batch/time budget that keeps progress and cancellation responsive.
- [ ] Evaluate bounded asset concurrency; preserve deduplication and import order.
- [ ] Verify persistence limits on large single boards; the current per-board undo block does not bound an individual large transaction.
- [ ] Correct transformed geometry using untransformed dimensions plus transforms, avoiding rotation of an already transformed bounding box.
- [ ] Add per-side borders, image object-fit/object-position, and pseudo-element geometry in separate, fixture-backed changes.
- [ ] Diagnose unsupported CSS instead of silently implying full fidelity.

Acceptance: publish before/after timings from the same fixtures, with no visual regression or reduction in cancellation responsiveness. Each added CSS feature has a defined supported subset.

## Phase 6 — Optional native layout conversion

- [ ] Keep the fixed snapshot representation available for visual fidelity.
- [ ] Define a conservative subset of flex layouts that can map to native Penpot layout.
- [ ] Convert direction, gap, padding, alignment, sizing, and absolute children only where their semantics are supported.
- [ ] Fall back to captured geometry when conversion would change the initial appearance.
- [ ] Test resizing and text editing after import, not just initial rendering.
- [ ] Assess grid conversion separately after the flex subset is stable.
- [ ] Update UI and README language to distinguish viewport snapshots from layouts that respond to editing and resizing.

Acceptance: supported native layouts preserve their initial appearance and behave predictably when edited; unsupported structures retain a usable snapshot.

## Delivery checklist

- [ ] Ship focused changes in phase order, with Phase 1 fixtures added alongside the relevant fixes.
- [ ] Run focused regression tests during development and the complete existing suite before each delivery.
- [ ] Run the production build and relevant typechecks for changed components.
- [ ] Compare affected fixtures in a real browser and live Penpot before declaring visual fixes complete.
- [ ] Update support documentation and diagnostics for any remaining limitation.
- [ ] Record completed checklist items, validation evidence, and any deferred scope in the change description.

Recommended first batch: browser fixtures plus container/root background images, nested clipping, and alpha/opacity fixes. Native layout conversion is a later milestone, after the snapshot importer reliably preserves appearance.
