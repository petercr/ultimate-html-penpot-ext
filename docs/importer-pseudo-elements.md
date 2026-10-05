# Pseudo-element geometry

The importer now imports `::before` and `::after` generated content at its own
geometry. Previously a pseudo-element could only become one text layer placed on
its host's whole rectangle, and `content: ""` boxes (dots, rules, overlays,
icons) were dropped entirely.

Status: browser references, scene evidence, regressions, and a live Penpot pass
at all three viewports are recorded; see [Live verification](#live-verification).

## How geometry is obtained

A pseudo-element has no DOM node, so `getBoundingClientRect()` and `Range`
cannot reach it. Its computed style is readable, but the position of an
in-flow pseudo-element is not (it depends on the host's content, wrapping, and
flex or grid placement). The extractor therefore measures each rendered
pseudo-element directly:

1. A hidden-by-selector rule (`content: none !important`) switches off the real
   pseudo-element on that one host.
2. A `span` carrying the pseudo-element's computed style is inserted where it
   generates (first child for `::before`, last child for `::after`), with its
   generated string as text.
3. The stand-in's box and text lines are read exactly like any element's. The
   stand-in, the rule, and the host marker are then removed in a `finally`
   block, so the page is unchanged before traversal continues.
4. The host's box is read again. If the stand-in moved it (a selector such as
   `:empty` or `:first-child` reacted to it), the geometry is kept and
   `PSEUDO_ELEMENT_GEOMETRY_UNVERIFIED` is reported.

Chrome returns an empty `cssText` for computed styles, so the style is copied
property by property.

## Supported subset

| Generated content | Imported as |
| --- | --- |
| A box with a background color, gradient, image, border, shadow, or radius (`position: absolute`/`fixed`, block, inline-block, flex or grid item) | A `box` layer at the measured rect, with the same fill, border, radius, image, and opacity handling as an element. |
| String content, `attr()` (resolved by the browser), and CSS escapes | Text layers at the measured lines. `white-space` is honored, so `pre` line breaks and spacing are preserved; one layer per line. |
| String content inside a decorated box | A container for the box with the text lines as children. |
| Plain string content with no box and a single line | One text layer named `::before` or `::after`. |
| Rotation, uniform scale, translation, and the individual `rotate`/`scale`/`translate` properties | The same one-frame-per-layer composition as elements, including `transform-origin` and percentage translate (centering with `translate(-50%, -50%)` works). |
| `z-index` on a positioned pseudo-element | Its own stacking position; an unpositioned one paints in flow. |
| Hosts omitted from the scene (`display: contents`, zero-size) | The pseudo-element attaches to the nearest surviving ancestor, in source order around the wrapper's own children. |

`::before` is captured before its host's other children and `::after` after
them, so source order breaks stacking ties correctly. A host that generates a
pseudo-element becomes a container (the importer renders children of containers
only); an undecorated wrapper with a single child still collapses.

## Diagnosed or omitted

| Case | Result |
| --- | --- |
| `content: counter()`, `counters()`, `url()`, `image-set()`, `open-quote`/`close-quote`, or any other non-string token | `UNSUPPORTED_PSEUDO_CONTENT`. Any string parts and the box are still imported; the token itself is not. A pseudo-element with only such content creates no layer. |
| Skew, mirroring, non-uniform scale, or 3D transform | The browser's transformed bounds, no rotation, `UNSUPPORTED_TRANSFORM`. |
| Measuring moved the host | Geometry kept, `PSEUDO_ELEMENT_GEOMETRY_UNVERIFIED`. |
| `filter`, mask, or blend mode | A fallback layer with `UNSUPPORTED_SUBTREE`, as for elements. |
| Multiple background layers, unsupported border styles, CSS Color 4 paint | The existing diagnostics, with the source `#host ::before`. |
| `display: none`, `visibility: hidden`, `opacity: 0`, an empty `content`, or a box that paints nothing (an undecorated `content: ""` clearfix, or a decorated box with no area) | No layer and no diagnostic. |
| Pseudo-elements of replaced or void hosts (`img`, `input`, `br`, `svg`, and similar) | Not captured; they do not render in the browser either. |

`::marker`, `::first-line`, `::first-letter`, `::placeholder`, and `::selection`
are not captured. Inline pseudo-elements that wrap across lines import as one
text layer per line; any box decoration uses the stand-in's union bounds.

## Fixture and verification record

[`pseudo-elements.html`](../src/capture/fixtures/pseudo-elements.html) has 13
sample tiles covering every row above. The baseline runner asserts, at all three
viewports, that each generated box keeps its own measured size (for example the
corner dot is 18 × 18 while its host is 300 × 48), that `::before` precedes the
host text, that the diamond keeps its own 28 × 28 size with a 45° rotation,
that counter content and the skewed box are diagnosed, that hidden and empty
content creates nothing, and that no measurement stand-in leaks into the scene.

- Browser references: three new screenshots (`pseudo-elements-*.png`) at
  Desktop 1440, Tablet 768, and Mobile 390. The 24 earlier screenshots and all
  earlier scene evidence are byte-for-byte unchanged.
- Capture regressions: `src/capture/extractor.pseudo.test.ts` (12 tests) covers
  the stand-in lifecycle (style copied, real pseudo-element hidden, DOM and head
  restored), source order, string decoding, alternative text, decorated and
  multi-line text, rotation and skew, host drift, empty and hidden content,
  omitted wrappers, and stacking.
- Import regression: `src/importer/penpot.test.ts` imports the generated scenes
  at all three viewports and checks the box sizes, the rotation, the text layers,
  that hidden content creates no shape, and that the overlay paints above the
  in-flow text.
- Validation: all 404 tests pass; app, API, and Worker typechecks, the
  production build, and `npm run check:dist` pass. `npm run test:importer-fixtures`
  passes 286 tests in 13 files.

The benchmark fixtures contain no generated content, so
[the measured timings](importer-performance.md) do not change. A page with
many pseudo-elements pays two forced layouts per rendered one (insert, then
remove); this has not been separately benchmarked.

## Live verification

Recorded on 2026-10-05 against Penpot 2.18.2 at `https://design.penpot.app`,
through Orca's embedded Windows Chromium 150.0.7871.250, with the
[local live harness](importer-assets-and-persistence.md#local-live-harness-procedure)
built with `PHASE5_FIXTURE=pseudo-elements.html`.

| Viewport | Scene nodes | Host shapes (with page root) | Checked boxes | Saved reload |
| --- | --- | --- | --- | --- |
| Desktop 1440 | 58 | 78 | 9 | not repeated |
| Tablet 768 | 58 | 78 | 9 | 78 shapes; geometry unchanged |
| Mobile 390 | 58 | 78 | 9 | not repeated |

Each import reported no importer diagnostics. For every non-text generated box,
the live shape's size was compared with the scene rect, and its page-relative
corner with the scene position for unrotated layers. All nine matched within
0.5 px; the diamond kept its 28 × 28 size at exactly 45°, the dot stayed 18 × 18
and hung off the corner, and the skewed box kept the browser's 112.4 × 34
bounds. The only difference was the multi-line text group (49 vs 74 px wide),
which follows the substituted font rather than box geometry. `hidden-controls`
created only its host rectangle, group, and text.

The tablet import was compared visually with `pseudo-elements-tablet-768.png`:
the dot, ★ and ◆ prefixes, rule, translucent overlay, diamond, NEW chip,
`attr()` text, two-line text, counter remainder (`.`), zero-size-host square,
image box, and skewed box all appear as in the browser. On tablet, one Undo
reduced 78 shapes to the page root; one Redo restored all 78 and the geometry
check passed again; a saved reload kept 78 shapes with the same geometry.

The pass found one defect, fixed in this change: a box whose background is an
SVG (the image box, `opacity: 0.6`) was converted to a vector group without the
element's opacity, so it rendered fully opaque. The importer now applies the
element's compositing opacity to the converted group
(`applyVectorOpacity`), covered by a regression in `penpot.test.ts`; after the
fix the live pixel matched the browser reference within one level per channel.

Not covered: save-request status codes were not recorded, and the Inter
fallback for `DejaVu Sans` changes text widths (and the counter's `1.` appears
as `.`, as documented). Run `npm run build` afterwards to restore the
production plugin.
