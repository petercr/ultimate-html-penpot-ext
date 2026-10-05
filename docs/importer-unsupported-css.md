# Unsupported CSS diagnostics

The importer is a viewport snapshot. Several visible CSS features have no
Penpot equivalent in that model, and before this change most were dropped
without a word, so a clean analysis implied more fidelity than the import
delivered. The capture now reports the features below. The layer is still
imported (as an ordinary, editable layer); the diagnostic says what the browser
shows that the Penpot layer does not.

Status: browser references, scene evidence, regressions, and a live Penpot
import are recorded; see [Verification](#verification).

## What is reported

| Code | Detected when | What the import does instead |
| --- | --- | --- |
| `UNSUPPORTED_OUTLINE` | A visible `outline` (style not `none`/`hidden`, width above 0, non-transparent color). | No outline ring. |
| `MULTIPLE_BOX_SHADOWS` | More than one `box-shadow` layer. | Only the first layer is imported. |
| `UNSUPPORTED_CLIP_PATH` | `clip-path` other than `none`. | The layer is not clipped to the shape. |
| `UNSUPPORTED_BACKGROUND_CLIP` | `background-clip: text`. | The whole box is filled and the (often transparent) text stays separate. |
| `UNSUPPORTED_BACKGROUND_BLEND_MODE` | A `background-blend-mode` other than `normal`. | Background layers are not blended. |
| `UNSUPPORTED_TEXT_SHADOW` | `text-shadow` on an element with its own text. | No shadow. |
| `UNSUPPORTED_TEXT_DECORATION` | Text with an overline, a decoration style other than solid, or a decoration color different from the text color. | A solid underline or line-through in the text color is the only supported decoration. |
| `UNSUPPORTED_WRITING_MODE` | Text in a vertical `writing-mode`, or `direction: rtl`. | Text is placed left to right. |
| `UNSUPPORTED_TEXT_TRUNCATION` | `text-overflow: ellipsis` that cut the text (`scrollWidth` above `clientWidth`) or a `line-clamp` that cut it (`scrollHeight` above `clientHeight`). | The full text, without the ellipsis. |
| `UNSUPPORTED_LIST_MARKER` | `display: list-item` with a `list-style-type` other than `none`. | No bullet or number. |
| `UNSUPPORTED_FORM_CONTROL` | A visible `input`, `select`, `progress`, or `meter`. | Only the box and its CSS decoration; value, placeholder, and native appearance are absent. |

Features that already had diagnostics are unchanged: transforms
(`UNSUPPORTED_TRANSFORM`), filters, backdrop filters, masks, and blend modes
(`UNSUPPORTED_SUBTREE` raster fallbacks), borders, colors, background layers,
overflow, `object-fit`/`object-position`, and pseudo-element content. The new
text checks also apply to generated text; the box checks apply to generated
boxes.

## Reporting rules

- **Once per code per viewport.** A feature repeated on many elements (every
  list item, every shadowed heading) is one diagnostic: its first source is the
  `source`, and the message adds `Affects N elements, including #a, #b, #c.`
  A page therefore cannot bury its other diagnostics.
- **Only what is visible.** Invisible outlines, a single shadow, and truncation
  that did not occur are not reported; text checks require the element to have
  its own text. A fully supported control (a single shadow, a solid underline,
  `list-style: none`) produces nothing.
- **No layer is replaced.** Unlike filter or mask, these features do not turn a
  subtree into a fallback; they are reported while the editable layer remains.
- **The panel lists them all.** The analysis panel de-duplicates the same
  finding across viewports and shows the first four, with the remainder in an
  expandable "+ N more diagnostics" section instead of only a count.

## Not detected

The following are still silent. They are either rare in captured pages or
cannot be observed from computed style:

- `::marker`, `::first-line`, `::first-letter`, `::placeholder`, `::selection`.
- `-webkit-text-stroke` and `font-variant-*`/`font-feature-settings`.
- 3D context (`perspective`, `transform-style`), `zoom`, multi-column fragments
  beyond what measured line rects capture.
- Animation or transition state beyond the settled snapshot, scroll offsets,
  `position: sticky` behavior, and shadow DOM contents.

## Verification

- Fixture [`unsupported-css.html`](../src/capture/fixtures/unsupported-css.html):
  fourteen tiles, one per feature (thirteen) plus a fully supported control. Browser
  references: `unsupported-css-*.png` at Desktop 1440, Tablet 768, and Mobile
  390 (three more; every earlier screenshot and scene is unchanged). The baseline
  runner asserts one diagnostic per code with the expected first source, that
  the three list items are counted in one, that the supported tile has none, and
  that nothing becomes a fallback.
- Capture regressions: `src/capture/extractor.unsupported.test.ts` (7 tests)
  covers each code, invisible and non-occurring cases, text-only checks,
  aggregation counts, and hidden or marker-less controls.
- UI: `src/DiagnosticList.test.tsx` covers cross-viewport de-duplication and the
  expandable remainder.
- Import: `penpot.test.ts` imports the fixture at all three viewports and checks
  that the text stays intact and nothing becomes an "Unsupported:" layer.
- Validation: all 415 tests pass; app, API, and Worker typechecks, the
  production build, and `npm run check:dist` pass. `npm run test:importer-fixtures`
  passes 294 tests in 14 files.
- Live host, 2026-10-05, Penpot 2.18.2 through Orca's embedded Windows
  Chromium 150: the tablet scene imported as 71 shapes with no importer
  diagnostics, and each diagnosed feature appears as documented: the clip-path
  tile stays a rectangle, the gradient-text tile is a gradient box, list
  markers and the input value are absent, the shadow and underline are plain.
  Undo, redo, and saved reload were not repeated: this change adds no importer
  behavior for these properties, and those paths were verified for the
  preceding pseudo-element import.
