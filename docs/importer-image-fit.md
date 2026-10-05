# Image object-fit and object-position

The importer now sizes an `img` inside its CSS content box and clips the result
without changing the element's border box. All five `object-fit` values and
resolved percentage/pixel positions are supported for raster images and the
supported SVG subset. Backgrounds, borders, padding, rotation, and element
opacity remain part of the same composition.

The supported subset is verified in Penpot 2.18.1 at all three default
viewports, including geometry after a saved reload. Representative desktop
image appearances and mobile undo/redo also pass. The redacted
[live evidence](../src/capture/fixtures/baselines/image-fit-position-live.json)
records source hashes, geometry, host constraints, and persistence results.

## Supported sizing and positions

Sizing follows the concrete object size rules in
[CSS Images 3: object-fit](https://www.w3.org/TR/css-images-3/#the-object-fit).

| CSS value | Fitted object geometry |
| --- | --- |
| `fill` | The object viewport has the content box's width and height. A raster image stretches to that ratio. |
| `contain` | The intrinsic ratio is preserved and the complete image fits inside the content box. |
| `cover` | The intrinsic ratio is preserved and the image covers the content box; excess content is clipped. |
| `none` | The image retains its natural CSS-pixel dimensions, including any supported uniform CSS transform scale. |
| `scale-down` | The smaller of `none` and `contain` is used; the image is never enlarged beyond its natural size. |

Capture uses the browser's computed `object-position`: percentages, pixel
lengths, `left`/`center`/`right` and `top`/`center`/`bottom`, edge offsets such
as `right 12px bottom 8px`, and linear percentage-plus-pixel `calc()` values.
Each axis becomes a fraction of the remaining space plus a pixel offset:

```text
objectStart = contentStart + (contentSize - objectSize) * percentage + offset
```

The same rule applies when `cover` or `none` leaves negative remaining space.
Positions outside 0–100% are valid. A position the extractor cannot represent
is centered with an explicit diagnostic while preserving the supported fit.

The content box subtracts each active border width and each padding value from
the captured border box. Transparent borders still reserve their width;
`none` and `hidden` do not. Overlarge insets in supplied scenes are bounded so
an empty content box cannot cross its outer frame. An empty content box creates
no fitted image child.

These are fixed viewport snapshots. Resizing the imported board does not
recompute CSS fit, position, padding, or responsive rules. See
[Transformed geometry](importer-transforms.md) for supported transforms.

## Additive scene metadata

`SceneNode.image` is optional and is only valid on an image node with an
existing asset reference:

```ts
image: {
  fit: "cover",
  position: {
    x: { percentage: 0.25, offset: 0 },
    y: { percentage: 0.75, offset: 0 }
  },
  intrinsicWidth: 240,
  intrinsicHeight: 120,
  scale: 1
}
```

Natural dimensions come from `naturalWidth`/`naturalHeight` in CSS pixels,
including the browser's `srcset` density correction. They remain unscaled;
`scale` records the supported composed uniform transform and defaults to 1.
Padding, borders, and position offsets already include that transform scale.
The node rectangle remains the element's border box.

The protocol version stays 1. Older scenes without `image` continue through
the existing image import path. Validation requires both position axes,
finite bounded numbers, a recognized fit, positive intrinsic dimensions and
scale, and a valid image asset. Derived fitted geometry and the normalized
SVG viewport are also bounded before any host objects are created.

## Layer composition and editability

Each fitted image has a fixed outer clipping board for its border box,
background, border decoration, shadow, and element opacity. A transparent
inner clipping board defines the content box. Both boards retain the captured
rotation and page position, including composition with ancestor transforms.
The fitted object sits inside the content board at its resolved size and
offset. Per-side borders remain separately editable paths; see
[Per-side borders](importer-borders.md).

Raster content is an editable rectangle with an uploaded image fill. Its
native `keepAspectRatio` is explicitly false because fit has already been
resolved in the rectangle's geometry. Element opacity applies once on the
outer board, with opacity 1 on the content board and raster fill.

For SVG images, `object-fit` resolves the outer SVG viewport. The SVG source's
own `viewBox` and `preserveAspectRatio` then control the vector content inside
that viewport. Thus `fill` does not override an SVG's internal aspect rule;
the default `xMidYMid meet` can retain empty space inside a stretched object
viewport.

The internal SVG alignment and meet/slice rules follow
[SVG 2: preserveAspectRatio](https://www.w3.org/TR/SVG2/coords.html#PreserveAspectRatioAttribute).

Simple SVG sources retain editable vector groups when their converted bounds
match the source extent. The importer supports a numeric root `viewBox`, all
`xMin`/`xMid`/`xMax` and `YMin`/`YMid`/`YMax` alignments with `meet` or `slice`,
and `none`. A source without `viewBox` may use numeric or `px` root width and
height; its user units stay CSS pixels. A separate transparent board clips at
the fitted SVG viewport, and the native group is positioned using the source
aspect rule. Source vector opacity remains on its converted layers.

Nested SVG viewports, root transforms, root inline CSS sizing/transforms,
invalid or unsupported root geometry, changed no-viewBox percentage geometry,
and converted bounds that do not match the source extent use an uploaded SVG
image fallback. The inlined source's root viewport is normalized for the
fitted size while retaining its `viewBox` and aspect rule. The image remains
movable and resizable, but its vectors are not individually editable; this
fallback is reported. Ordinary inline SVG nodes retain their existing native
conversion path.

An SVG whose source bytes were not inlined cannot have its internal viewport
resolved reliably. It uses the captured object frame and reports
`UNSUPPORTED_SVG_VIEWPORT`. Missing uploads retain a named placeholder.

## Rounded content and diagnostics

Equal border-plus-padding insets preserve the inner rounded content clip:
each captured corner radius is reduced by that inset and bounded at zero.
The fixture's radius 28 px and inset 12 px therefore produce four inner radii
of 16 px. Unequal insets need elliptical inner corners; that case retains the
outer rounded clip and a square content clip with an explicit warning.
Existing elliptical-radius and asymmetric rounded-border limitations remain.

| Diagnostic | Result |
| --- | --- |
| `IMAGE_DIMENSIONS_UNAVAILABLE` | Missing, broken, or unusable natural dimensions retain the legacy element-bounds image path. |
| `UNSUPPORTED_OBJECT_FIT` | An unrecognized fit retains the legacy element-bounds path. |
| `UNSUPPORTED_OBJECT_POSITION` | The fitted image is centered. |
| `UNSUPPORTED_IMAGE_RADIUS` | Unequal insets use the outer rounded clip and a square content clip. |
| `UNSUPPORTED_SVG_VIEWPORT` | A non-inlined SVG uses its captured object frame without a resolved internal aspect rule. |
| `ASSET_IMPORT_FAILED` | Reports an SVG media fallback when editable conversion cannot retain the viewport, or a visible placeholder when upload fails. The diagnostic message distinguishes these outcomes. |

Unsupported skew, mirroring, non-uniform scale, and 3D transforms retain the
existing browser-bounds fallback and `UNSUPPORTED_TRANSFORM` warning.

## Fixture and verification record

`src/capture/fixtures/image-fit-position.html` contains 16 images: 13 raster
uses and three SVG uses. It covers every fit, both `scale-down` branches,
percentage/pixel/edge positions, differing intrinsic ratios, decoration and
opacity, rotation, a rounded content clip, uniform scale, and responsive
widths. The local raster `image-fit-grid.png` is 240 × 120 px with labeled
corners and edges; `fixture-illustration.svg` is 160 × 112. The sources are
reused rather than uploaded separately for each case.

The baseline suite now has eight fixtures and 24 browser references. This
step adds three image references; the existing 21 screenshots are
byte-for-byte unchanged. Capture assertions require every image's fit and
natural dimensions, normalized positions, decoration, transform metadata,
two reused source assets, and no diagnostics. Capture, geometry, importer,
and validation regressions cover clipping, opacity, native fill behavior,
SVG fallback, legacy compatibility, and malformed scene metadata.

Validation on 2026-10-04: all 390 tests pass, including the image, SVG root
geometry, and scene validation regressions. App, API, and Worker typechecks
also pass. The focused `npm run test:importer-fixtures` command passes 272
tests in 12 files, including SVG root geometry and image validation. The
production build and `npm run check:dist` pass; the normal production plugin
was reopened in the host after the temporary live harness.

For the live host procedure, build the
[local live harness](importer-assets-and-persistence.md#local-live-harness-procedure)
with `PHASE5_FIXTURE=image-fit-position.html`, import each size, inspect that
import's page, and save the resulting status JSON. Verify it with:

```sh
node scripts/importer-image-fit-verify.mjs /tmp/image-fit-status.json
```

The verifier compares all 16 border, content, and object frames plus three
SVG vector frames with the pure geometry helpers. It checks parentage,
composed rotation and page-board origin, three SVG viewport boards and
editable groups, 13 raster rectangles, the four 16 px content radii,
opacity, native fill aspect settings, one deduplicated upload, and no
diagnostics. Tolerances are 0.005 px and 0.001°. Its summary omits private
page, board, and media IDs.

The live host was Penpot 2.18.1 at `https://design.penpot.app`, through Orca's
embedded Windows Chromium 150.0.7871.250. Each viewport has 75 scene nodes,
140 host shapes including the page root, 51 checked frames, one PNG upload,
and no diagnostics. All 35 image clipping boards have `clipContent: true`.

| Viewport | Maximum corner error | Maximum size error | Maximum rotation error | Saved reload |
| --- | --- | --- | --- | --- |
| Desktop 1440 | 0.0001375 px | 0.0000276 px | 0° | 140 shapes; geometry passed |
| Tablet 768 | 0.0001388 px | 0.00005374 px | 0° | 140 shapes; geometry passed |
| Mobile 390 | 0.00024419 px | 0.00011901 px | 0° | 140 shapes; geometry passed |

The desktop visual comparison covered the raster fits and positions, SVG
fill/contain/cover, borders/padding/background/opacity, rotation, rounded
content, and uniform scale. On mobile, one Undo reduced 140 host shapes to
the page root; one Redo restored all 140 and passed the geometry verifier
again. All three boards retained their geometry after the final reload.

Desktop and mobile saves returned HTTP 200. Two earlier tablet autosaves
reported `Failed to fetch`, and a later undo/redo save also had no recorded
response. A fresh tablet import subsequently returned HTTP 200 and survived
reload. The evidence file retains all six request sizes and observed statuses.
The earlier failure cause remains unknown; the fill-write consolidation does
not establish causation, and a live upper persistence limit remains unverified.

`DejaVu Sans` is unavailable in this Penpot host; its observed fallback is
Inter. This record establishes the image subset and representative image
appearance. Typography and complete pixel equality at every viewport remain
outside its scope.
