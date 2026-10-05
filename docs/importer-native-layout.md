# Native flex layouts (opt-in)

By default every board the importer creates is a fixed snapshot of the viewport:
each layer sits at the position the browser measured, so the result matches the
page but does not respond when you edit it. **Native flex layouts** is an opt-in
setting (Advanced capture, off by default) that turns simple flex containers
into Penpot flex boards, so resizing the board, resizing a child, or adding a
layer reflows its children. Anything the conversion cannot reproduce exactly
stays a fixed snapshot. Nothing about the default import changes.

Status: unit, fixture, and importer regressions are checked in, and a live
Penpot pass covers geometry at all three viewports, resizing and editing,
undo/redo, and a saved reload; see [Verification](#verification).

## How a container is chosen

The conversion is decided in two stages, both against the same small model
(`predictFlex` in `src/importer/flexLayout.ts`) of how a flex container places
fixed-size children.

1. **Before import (browser snapshot).** A container qualifies only when the
   model, fed the browser's own child sizes, reproduces the browser's child
   positions within 1 px. Margins, `flex-grow`, `order`, auto margins, and
   anything else the model cannot express fail this check on their own, so
   unsupported CSS cannot silently shift layers.
2. **After import (host check).** Penpot applies a layout asynchronously, and in
   live passes the first layout on a freshly opened page did not run at all.
   The importer therefore piles the children at the board origin before adding
   the layout, waits for the host to settle, and requires the host's positions
   to match the model fed the host's current sizes. A layout that never ran, or
   ran differently, is removed and the children return to their captured
   offsets, with a `NATIVE_LAYOUT_REVERTED` diagnostic.

Text may reflow in Penpot's substituted font, which is why the host check uses
the host's sizes rather than the browser's.

## Supported subset

| CSS | Penpot |
| --- | --- |
| `display: flex` / `inline-flex`, `flex-direction: row` or `column` | A board with a flex layout of the same direction. |
| `gap` | Row and column gap. |
| `padding` (plus a uniform border) | Board padding. A uniform border is a native inside stroke and does not move children, so its width is added to the padding. |
| `justify-content`: `flex-start`, `center`, `flex-end`, `space-between`, `space-around`, `space-evenly` | The matching justification. Centering and spacing require the children to fit. |
| `align-items`: `flex-start`, `center`, `flex-end`, and the default `stretch` | Start, center, end. Captured children already have their stretched size, so start alignment reproduces `stretch`. |
| Absolutely positioned children | Flagged as outside the flow and kept at their captured offset. They are appended first so they stay topmost. |
| Nested flex containers | Each converts on its own merits. |
| Fill, border, radius, shadow, opacity, background image | Painted by the board as for any container. |

Children keep their captured size, and the board keeps its captured size: there
is no hug, `flex-grow`, or `flex-shrink` conversion. Penpot lays children out in
the order they were appended, first appended first, whereas paint order appends
the topmost first. The flow is therefore appended in source order.

## Kept as fixed geometry

A container that does not qualify is imported exactly as before. One
`NATIVE_LAYOUT_SKIPPED` diagnostic per viewport counts the containers and groups
them by reason.

| Reason | Why |
| --- | --- |
| `flex-wrap: wrap`, `row-reverse`, `column-reverse` | Wrapping and reversed order depend on `align-content` and on how Penpot orders reversed layouts. |
| `align-items: baseline`, other justifications (`left`, `right`, and similar) | No Penpot equivalent. |
| Per-side borders | They are drawn as separate paths that would become layout children. |
| Rotated container or child | Layout positions are axis-aligned. |
| In-flow children that differ in stacking (z-index, mixed positioned and static) | Penpot orders by layer, so paint order must equal source order. |
| An absolute child behind the content, or positioned flow children with absolute siblings | The layering cannot be reproduced. |
| Centering or spacing with overflowing children | The browser and Penpot place overflow differently. |
| Margins, `order`, `flex-grow`, auto margins | The browser positions do not fit the model. |
| A stack of plain text layers | See below. |

**Text-only items do not always qualify.** The scene records a text layer's
glyph rectangle, not its element's line box, so a column of bare text lines
(a heading above a caption, for instance) differs from the model by the line
leading and falls back to fixed geometry. Text inside a box, button, or card
qualifies because the box is the flex item. Recording the line box would let
these convert too.

## Grid

Assessed, not converted. Penpot has a grid layout with typed tracks and per-child
cell placement, but the capture records only that a container is a grid and its
gaps; it does not record track templates or item placement, and there is no
verified model of how Penpot sizes auto and fractional tracks. Grid needs those
captured first, then the same model-and-verify approach used here.

## Verification

- Fixture [`flex-layouts.html`](../src/capture/fixtures/flex-layouts.html): six
  supported containers (basic, space-between, column, centered, a decorated card
  with a nested flex column, an absolute badge) and five kept fixed (wrap, row
  reverse, auto margin, `order`, baseline), with three real-Chrome references
  (every earlier screenshot and scene unchanged). The baseline runner pins the
  captured flex semantics.
- `src/importer/flexLayout.test.ts` (13 tests) covers the model, each
  justification, the border-plus-padding rule, and every rejection reason.
  `flexLayout.fixture.test.ts` runs the planner over the real browser scenes at
  all three viewports. `nativeLayout.test.ts` (7 tests) drives the host step with
  a simulated Penpot: a layout that runs, reflows around changed sizes, never
  runs, runs wrongly, absolute children, missing children, and configuration.
  `penpot.test.ts` imports the fixture with the option off (no layout requested),
  on (supported boards converted at the captured positions), and with a host
  that never applies layouts (full fallback).
- Validation: all 442 tests pass; app, API, and Worker typechecks, the
  production build, and `npm run check:dist` pass. `npm run test:importer-fixtures`
  passes 321 tests in 17 files.
- Live host, 2026-10-05, Penpot 2.18.2 through Orca's embedded Windows Chromium:
  all three viewport imports converted 29 boards (the six containers plus the
  23 boxes inside them), kept five fixed, and reverted none. For the 38
  non-text layers, position and size matched the browser within 1 px, except
  the page's `main` wrapper and the unconverted `#card-text` group, whose group
  bounds follow the substituted font and are identical in a snapshot import.
  The import used 81 shapes against 110 for the snapshot, because a board
  replaces each group-plus-backdrop pair.
  - **Resizing and editing** (tablet): widening a space-between row from 300 to
    360 px moved the second and third boxes from 110/221 to 140/281; resizing a
    child from 60 to 100 px shifted its following sibling by 40; making a column
    child taller shifted the siblings below it; a layer appended to a row
    flowed to the end after the gap; editing the card's text to a longer string
    grew the text and its group and the card kept its layout.
  - **Undo, redo, reload** (tablet): one Undo removed all 81 shapes and every
    layout (81 to 1); one Redo restored 81 shapes and 29 layouts; after a saved
    reload there were still 81 shapes and 29 layouts, with the same geometry.
  - Hosts substitute Inter for `DejaVu Sans`, so text widths differ slightly;
    box geometry does not depend on the font.

Observations from the host used to design this, recorded with the
`flex-probe` and `flex-edit-probe` harness actions:

- A layout is applied asynchronously, within about 100 ms of configuration, and
  the first layout on a newly opened page was not applied at all in two runs;
  this is why the host check exists.
- The first appended child is first in a row or column; `board.children` lists
  them in the opposite order.
- Removing a layout leaves children where it last placed them, so a revert
  must restore the captured offsets.
- An absolute child (`layoutChild.absolute`) keeps its position and is excluded
  from the flow. A `fill` child sizing grows to the remaining space; this is
  available for later `flex-grow` support.

## Limits

- Fixed sizing only: a converted board does not hug its content, so editing
  text that grows past its container does not resize the container.
- The native layouts reflow with the host's fonts; the reflow is real
  behavior, not a defect.
- Containers are not converted when the model cannot reproduce them; there is no
  partial conversion of a container.
