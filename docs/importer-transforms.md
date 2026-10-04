# Transformed geometry

The importer reproduces CSS rotation, uniform scale, and translation as Penpot
layer geometry. It never rotates a bounding box the browser has already
transformed: a layer keeps its own unrotated size, and a rotation is applied
about it. Transforms that Penpot layers cannot represent keep their previous
behavior and now report a diagnostic.

## Scene contract

`SceneNode.rect` is the layer's own size after any uniform scale, with `x`/`y`
at the page position of its top-left corner **after** every transform.
`SceneNode.rotation` is the clockwise turn in degrees about that corner, within
±360. It is omitted for an untransformed layer and for rotations of 0.005° or
less. Because every node carries its own composed frame, groups and boards stay
unrotated; each layer turns on its own.

## Capture

The extractor reads an element's computed `translate`, `rotate`, `scale`, and
`transform` and composes them in CSS order, about `transform-origin`. The result
is flat and transformable only when it is a similarity: rotation, uniform scale,
and translation, with a positive determinant. Percentages in `translate`
resolve against the layer's own measured box.

For a supported element, the extractor:

1. records its transform and replaces it with an identity matrix, so that the
   element and every descendant are measured in untransformed layout space;
2. multiplies it into the cumulative matrix of its ancestors, so nested
   transforms compose;
3. after traversal, replaces each node's layout rect with its frame: size
   scaled by the matrix, corner at the transformed position, and `rotation`.

An identity matrix, rather than `none`, keeps the element the containing block
for absolute and fixed descendants, so layout does not change while measuring.
Text lines and pseudo-element text take the matrix of the element they belong to.
A uniform scale also scales the borders, corner radii, padding, font size,
letter spacing, and text width limit that travel with the layer.

| Case | Result |
| --- | --- |
| `rotate`, uniform `scale`, `translate`, or `transform` built from them | Own size plus rotation, exact |
| Nested transforms | Composed into one frame per descendant |
| `transform-origin` | Honored, including corner origins |
| Skew, mirror (negative determinant), non-uniform scale, 3D, `rotate` with an axis, `calc()` translate | Browser's transformed bounds, no rotation, `UNSUPPORTED_TRANSFORM` warning |
| Scale to zero or any matrix that collapses to a line or point | Element and subtree skipped; the browser paints nothing |
| Non-replaced `display: inline` box | Transform ignored, as the browser ignores it |

`display: contents` elements have no box and are never transformed.

## Import

Penpot turns a layer about its center, reports `x`/`y` as the rotated bounding
box, and keeps `width`/`height` unrotated. `applyGeometry` therefore:

1. sets position and size from the frame,
2. sets `rotation`,
3. writes `x`/`y` again from `rotatedBoundsOrigin`, which computes the bounding
   box that places the rotated corner exactly where the scene says.

A position write that follows a prompt rotation is exact, so the final write
also absorbs any pixel snapping from the rotation step.

Constraints learned on Penpot 2.18.1:

- **Rotate text at creation.** Rotating a text layer after its layout has
  settled (roughly 600 ms later), by setter, by `rotate()`, or by rotating a
  group that contains it, froze the whole browser tab. Rotation in the creating
  turn, or within about 100 ms, is safe. `createText` does not await, so the
  importer rotates synchronously. Do not add an `await` between creating a text
  layer and rotating it.
- **Place before awaiting uploads.** Image-filled layers, clipping boards, and
  container backgrounds are appended and positioned before their media upload
  is awaited, so their rotation never lands late. The fill is applied after.
- **Late rotation is unreliable.** In one tab state the host snapped the
  rotated bounds to whole pixels and ignored later position writes when a
  rotation arrived more than about 1.2 s after the layer was created. In
  another state the same operations were exact at every delay. The cause was
  not established, and the importer does not depend on the host state.
- **Text growth.** Auto-width text growth keeps the unrotated top-left fixed
  and re-centers the rotation, so rotated text lines are re-anchored after the
  fit passes. The ancestor edge clamp is skipped for rotated lines, since it
  compares unrotated edges.
- `resize()` on an already rotated layer does not preserve its center, which is
  why sizing happens before rotation.

## Evidence

- `src/capture/fixtures/transforms.html` covers a 30° box, a −8° decorated
  card, a top-left origin, translate, uniform scale, the individual
  `rotate`/`scale`/`translate` properties with a percentage translate, nested
  rotations, a rotated `overflow: hidden` clip, a −90° label, a rotated image,
  skew, mirror, a collapsed element, and an inline span. The three
  `transforms-*.png` references and its scene evidence are checked in; the
  fixture is documented in [Importer fixture baselines](importer-visual-baselines.md).
- `src/capture/extractor.transforms.test.ts` checks the frame arithmetic,
  composition, origins, percentages, the unsupported cases, and collapsed
  subtrees against a browser double.
- `src/importer/penpot.test.ts` checks the `rotatedBoundsOrigin` values; the
  size, rotation, position order; single rotation of text; the ancestor clamp;
  early placement before uploads; and that the generated scenes import with
  diagnostics for the skewed and flipped elements only.
- Live, on Penpot 2.18.1 at `https://design.penpot.app` through Orca's
  embedded Chromium 150: the 18 rotated layers of the imported desktop board
  matched their scene rotation exactly and their corners within 0.03 px. The
  rotated, nested, clipped, vertical, and image tiles matched the browser
  reference visually, and the skewed and flipped tiles imported unrotated as
  documented. A separate `rotated-image` run covers a rotated image fill, a
  rotated background-image box, and a rotated plain control. After image-filled
  layers were moved ahead of their uploads, a repeat on the same host reported
  exact rotations (25°, −15°, and 40°), unrotated sizes, and corner errors of
  0.0 px for all three, with both uploads applied and no diagnostics.
- The `rotation-probe`, `pivot-probe`, `late-rotation-probe`, and `delay-probe`
  harness actions record the host primitives this design depends on: rotation
  direction and normalization, rotation about a corner, rotation inside boards
  and groups, and the effect of delaying a rotation. Their results are the basis
  for the host constraints above.

Mock-host tests do not exercise the host's rotation snapping or the text
freeze, so a change to `applyGeometry` or to the order of text creation should
be re-run through the live harness described in
[Asset uploads and single-board validation](importer-assets-and-persistence.md#local-live-harness-procedure).
The fixture's `fixture 0` action imports the desktop scene from the checked-in
scene evidence, and `rotated-image` imports the image and background-image
cases.

## Not covered

- Skew, mirroring, non-uniform scale, and 3D transforms keep browser bounds and
  warn. Mapping skew or mirroring onto Penpot's flip and transform matrix is a
  separate change.
- Only the CSS transform of an inline `<svg>` element itself becomes a layer
  rotation. Transforms inside its markup stay in the serialized SVG for the
  host's SVG import to handle.
- Capture reads computed values at the moment it runs, so an element that is
  mid-animation imports at its current transform.
