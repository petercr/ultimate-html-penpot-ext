# Per-side borders

The importer captures all four computed CSS borders and reproduces differing
solid borders with editable Penpot paths. A bottom-only rule and a left accent
therefore keep their own edge instead of borrowing the top border's paint.
Uniform borders retain the existing native stroke representation.

The supported border geometry is verified in Penpot 2.18.1 at all three
default viewport widths. Representative desktop border appearances were also
compared with the browser reference.

## Supported subset

| CSS border case | Import behavior |
| --- | --- |
| Same color, width, and style on every side | One native inside stroke for `solid`, `dashed`, or `dotted`; existing corner radii are retained. |
| Differing sides with square corners | Each visible `solid` side becomes an editable filled path, with a diagonal join between neighboring sides. |
| Bottom-only or left-only border on an element containing text | The decorated container is retained, with a separate editable text child. |
| `none`, `hidden`, zero width, or transparent paint | The affected side produces no visible border path. A transparent solid side still retains its measured width in the scene. |
| Side color alpha and element `opacity` | Alpha stays on the side fill; element opacity applies once to the complete element composition. |
| Rotation and uniform scale | Paths follow the captured layer frame; capture scales every side width with the element. |
| Root body, clipping container, and image | Their borders use the same side data and editable decoration representation. Fitted image content uses the separate [image fit/position composition](importer-image-fit.md). |

This subset uses the fixed snapshot geometry described in
[Transformed geometry](importer-transforms.md). The imported borders do not
become native CSS rules that reflow when the element is resized.

## Scene contract and capture

`ScenePaint.borders` is an optional object containing every side:

```ts
borders: {
  top: { color: string, width: number, style: string },
  right: { color: string, width: number, style: string },
  bottom: { color: string, width: number, style: string },
  left: { color: string, width: number, style: string }
}
```

The extractor compares each side's computed color, width, and style. When any
value differs, it emits all four sides and leaves the legacy `borderColor`,
`borderWidth`, and `borderStyle` fields absent. When all sides match, it emits
only those legacy fields. Older scenes therefore continue to import through
the uniform border path. If a supplied scene includes both representations,
the explicit `borders` object takes precedence.

Widths are measured in page pixels after any supported uniform scale.
`SceneNode.rect` remains the border box; it includes the space occupied by the
borders. Computed `none` and `hidden` sides have zero width. Unsupported styles
and colors remain in the captured side data so diagnostics can describe the
source without substituting guessed paint.

Scene validation requires all four side objects when `borders` is present.
Every side requires a bounded color string, a finite nonnegative width within
the scene dimension limit, and a bounded style string.

Decoration detection considers every active side, so direct text with only a
bottom or left border keeps a container rather than becoming a text-only
layer. Text fitting uses the applicable right border width when calculating
the room inside an ancestor.

## Editable layer composition

Uniform borders remain native strokes aligned inside the captured box.
Differing square solid borders partition the space between the outer border
box and the inner box into four polygons. Each polygon joins the outer corner
to the corresponding inner corner, preserving different neighboring widths
and colors without overlapping translucent corner fills.

Each visible supported side is an editable Penpot path. Side colors and alpha
are applied as fills, with no centered stroke extending beyond the border
box. The paths use the element's own rotation and position. Backgrounds, text,
and descendants retain their captured geometry, while the element's opacity
belongs to their combined composition.

For ordinary containers, the background and border paths sit below the
descendants in one compositing group. Box leaves and legacy image nodes group
their base surface with the border paths. Newly captured fitted images use a
fixed outer board with a separate content clip; see
[Image fitting](importer-image-fit.md). The paths are named `<element name> <side>
border` and retain the importer, viewport, and source metadata plus a
`border-side` value so the added decoration can be traced to its source.

Penpot preserves existing sibling order when grouping. The importer therefore
appends descendants first, then borders, then the background, because each
append inserts at the back. For leaves, border paths are appended before the
base surface. A live check caught the background covering the border paths
when this order was reversed; focused tests now check the append order.

A square asymmetric clipping container uses two boards. The outer board keeps
the captured border box, background, border paths, and element opacity. A
transparent inner board clips descendants to the padding box, inset by all
four border widths; this keeps an oversized child from painting across the
borders. The inner board and border paths use opacity 1, allowing the outer
board to composite them once. Uniform and rounded clipping containers retain
their existing board representation.

The root body is represented by the responsive page board, with its border
paths inside that board. Transparent or unsupported sides still reserve their
width when constructing neighboring solid sides' corner joins.

The importer bounds externally supplied widths when opposite borders exceed
the box size so that the inner box cannot cross itself. This is a guard for
scene input; normal browser captures already contain their borders.

## Diagnostics and omitted decoration

| Diagnostic | Condition | Result |
| --- | --- | --- |
| `UNSUPPORTED_BORDER_STYLE` | An active asymmetric side uses a style other than `solid`, or a uniform border uses a style other than `solid`, `dashed`, or `dotted`. | That unsupported border is omitted; supported asymmetric solid sides remain. |
| `UNSUPPORTED_BORDER_RADIUS` | A differing border has any active side and a nonzero corner radius. | All border sides are omitted; the background retains its captured corner radii. |
| `UNSUPPORTED_BORDER_IMAGE` | CSS `border-image-source` is not `none`. | The border image is omitted and the ordinary CSS border fallback is retained. |
| `UNSUPPORTED_COLOR_FORMAT` | An active border side has a CSS Color 4 value that the importer color parser cannot represent. | The affected side's paint is omitted; other supported side colors remain. |

`none` and `hidden` do not produce unsupported style diagnostics. A CSS Color 4
value on the right, bottom, or left side is inspected even when the top side
has no visible border.

## Fixture and validation record

`src/capture/fixtures/per-side-borders.html` uses bundled DejaVu Sans fonts and
SVG assets. It covers the root body, bottom-only decorated text, a left accent,
four widths and colors with color alpha and element opacity, an oversized
clipped child, rotated and scaled boxes, an image, transparent/hidden/none
sides, uniform and borderless controls, rounded asymmetric borders,
unsupported side styles, a non-top CSS Color 4 color, and a border image.

`scripts/importer-visual-baselines.mjs` registers the fixture for all three
default viewports and asserts the captured side fields, frame dimensions,
text parenting, clipping ancestry, image asset, uniform compatibility, and
expected diagnostics. Regeneration uses the procedure in
[Importer fixture baselines](importer-visual-baselines.md).

Validation on 2026-10-04:

- `npm test`: all 267 tests passed in 22 files, including the capture, validation,
  importer, and generated fixture regressions.
- `npx tsc --noEmit`, `npm run check:api`, `npm run check:worker`,
  `npm run build`, and `npm run check:dist`: passed.
- `npm run baseline:importer`: regenerated 21 browser references and scene
  evidence. The existing 18 screenshots are byte-for-byte unchanged; the
  whitespace fixture now captures its previously omitted left accent border.

The live host was Penpot 2.18.1 at `https://design.penpot.app`, through Orca's
embedded Windows Chromium 150.0.7871.250. The checked-in
[`per-side-borders-live.json`](../src/capture/fixtures/baselines/per-side-borders-live.json)
records source hashes, viewport counts, geometry errors, alpha, save
observations, and undo/redo results.

To repeat the host pass, follow the
[local live-harness procedure](importer-assets-and-persistence.md#local-live-harness-procedure),
building it with `PHASE5_FIXTURE=per-side-borders.html`. Run `fixture 0`,
`fixture 1`, and `fixture 2` for desktop, tablet, and mobile. The `inspect`
action returns side metadata, path data, fills, opacity, and frame geometry.
Restore the production plugin afterward with `npm run build`.

| Viewport | Scene nodes | Host shapes, including page root | Border paths | Observed import time |
| --- | --- | --- | --- | --- |
| Desktop 1440 | 48 | 96 | 29 | 6.691 s |
| Tablet 768 | 48 | 96 | 29 | 6.326 s |
| Mobile 390 | 64 | 112 | 29 | 8.739 s |

Across all three imports, every border path's rotation matched its scene,
corner error was below 0.00003 px, and size error below 0.00011 px. The content
clip measured 246 × 80 px; the four-color group retained opacity 0.8, with
side fill alpha 0.5 and 0.75. Each import produced a save notification. These
times are observations from this fixture, not a performance comparison.

The desktop visual pass covered bottom-only and accent borders, unequal
corner joins, alpha, clipped content, rotation, uniform scale, and image border
geometry. At the time of this border pass, image content used the existing
asset sizing and could stretch underneath its border. The later
[image fit/position implementation](importer-image-fit.md) addresses that
content geometry and tracks its own verification. Typography, a complete pixel
comparison at every viewport, and persistence after reload were not established
by this border pass.

On the mobile validation page, one Edit > Undo removed the entire import,
leaving only the page root. One Edit > Redo restored all 112 host shapes,
including all 29 border paths. The normal production plugin was rebuilt after
the temporary live harness was used.
