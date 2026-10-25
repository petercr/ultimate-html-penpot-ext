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
undo/redo, and a saved reload; see [Verification](#verification). The text box,
fill, wrap, and reverse additions (#49) have their own live pass on Penpot
2.18.4, which also found that Penpot justifies reversed layouts on the physical
axis and wraps a reversed sequence differently from CSS. A trial on twelve
real pages (#51) converted 62% of their flex containers, found and fixed a
defect with undecorated container items, and kept the setting opt-in; see
[Real-page trial](#real-page-trial-51).

## How a container is chosen

The conversion is decided in two stages, both against the same small model
(`predictFlex` in `src/importer/flexLayout.ts`) of how a flex container places
its children: lines broken in source order, free space distributed by
`justify-content` and `align-content`, reversed axes mirrored, growing items
sharing the free space equally, and each layer inset in its item by a margin.

1. **Before import (browser snapshot).** A container qualifies only when the
   model, fed the browser's own child sizes, reproduces the browser's child
   positions and sizes within 1 px. Margins, `order`, auto margins, and
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
| `display: flex` / `inline-flex`, `flex-direction: row`, `column`, `row-reverse`, or `column-reverse` | A board with a flex layout of the same direction. Penpot reverses only the order and keeps justification on the physical axis, so a reversed container's justification is mirrored (CSS `flex-start` becomes Penpot `end`). CSS `start` and `end` follow the writing mode and need no mirroring. |
| `flex-wrap: wrap` (not reversed) | Wrap, with `align-content` (`normal`/`stretch`, `flex-start`, `center`, `flex-end`, and the `space-*` values) as the matching line alignment. Centered or spaced lines must fit. |
| `gap` | The main-axis gap between items and the cross-axis gap between lines. |
| `padding` (plus a uniform border) | Board padding. A uniform border is a native inside stroke and does not move children, so its width is added to the padding. |
| `justify-content`: `flex-start`, `center`, `flex-end`, `space-between`, `space-around`, `space-evenly` | The matching justification. Centering and spacing require the children to fit. |
| `align-items`: `flex-start`, `center`, `flex-end`, and the default `stretch` | Start, center, end. Captured children already have their stretched size, so start alignment reproduces `stretch`. |
| Text items | The element box, not the glyph line: the inset of the glyphs in the box becomes the text layer's margins. |
| `flex-grow` | `fill` sizing along the main axis when the browser shared the free space equally (for example `flex: 1` siblings or a single growing item). Otherwise the item keeps its captured size. |
| Absolutely positioned children | Flagged as outside the flow and kept at their captured offset. They are appended first so they stay topmost. |
| Nested flex containers | Each converts on its own merits. |
| Fill, border, radius, shadow, opacity, background image | Painted by the board as for any container. |

Apart from growing items, children keep their captured size, and the board keeps
its captured size: there is no hug, cross-axis stretch, or `flex-shrink`
conversion. The capture records `flex-grow`, `flex-shrink`, and `flex-basis` for
every element; a shrunk item already has its shrunk size in the snapshot, and an
unequal grow ratio or a basis that changes the shares keeps the captured sizes,
which still reproduce the browser. Growth inside a wrapping line and on text
layers is not converted. Penpot lays children out in
the order they were appended, first appended first, whereas paint order appends
the topmost first. The flow is therefore appended in source order.

## Kept as fixed geometry

A container that does not qualify is imported exactly as before. One
`NATIVE_LAYOUT_SKIPPED` diagnostic per viewport counts the containers and groups
them by reason.

| Reason | Why |
| --- | --- |
| `flex-wrap: wrap-reverse` | Lines stack from the cross-axis end; not modelled. |
| `flex-wrap: wrap` with `row-reverse` or `column-reverse` | Penpot reverses the whole sequence and then breaks lines, so its lines hold different items from the browser's, which breaks lines in source order. |
| `align-content` other than those listed (`baseline`, `left`, and similar) | No Penpot equivalent. |
| Centered or spaced wrapped lines that overflow the container | The browser and Penpot place overflow differently. |
| A text line wider than its element's box | Penpot margins cannot be negative. |
| `align-items: baseline`, other justifications (`left`, `right`, and similar) | No Penpot equivalent. |
| Per-side borders | They are drawn as separate paths that would become layout children. |
| Rotated container or child | Layout positions are axis-aligned. |
| In-flow children that differ in stacking (z-index, mixed positioned and static) | Penpot orders by layer, so paint order must equal source order. |
| An absolute child behind the content, or positioned flow children with absolute siblings | The layering cannot be reproduced. |
| Centering or spacing with overflowing children | The browser and Penpot place overflow differently. |
| Margins, `order`, auto margins | The browser positions do not fit the model. |

**Text items.** A single-line text element becomes a text layer at its glyph
line, which sits inside the element's box by the line's leading. The capture
also records that box (`box` on the scene node), and the planner lays out the
box: the glyph inset becomes the text layer's top, right, bottom, and left
margins, so a column of bare text (a heading above a caption) now converts.
Anonymous text runs directly inside a flex container still use their glyph
line; a centered run is within the tolerance, which is why text inside a box,
button, or card already qualified.

## Real-page trial (#51)

The fixtures show that the conversion is exact. They do not show how much of a
real page it reaches, or what keeps the rest fixed. On 2026-10-24, twelve public
pages were run through the production plugin UI, and the scenes it would post
to Penpot were tallied with the importer's own planner (`planSceneFlex`):

```sh
npm run build && npx vite preview --port 4173 --strictPort &
node scripts/importer-native-trial.mjs <output-dir>   # capture + analyze
node scripts/importer-native-trial.mjs <output-dir> analyze
```

The script loads the real UI in headless Chrome, inside a same-origin frame so
the UI is not standalone. It enters each URL, analyzes at the three default
viewports with scripts off, presses Import, and keeps the `IMPORT` message's
scenes. Stripe and Linear exceeded the UI's 30-second analysis deadline at three
viewports and are not counted.

| Page | Kind | Flex containers (desktop / tablet / mobile) | Converted |
| --- | --- | ---: | ---: |
| vite.dev | landing | 90 / 65 / 62 | 61% / 52% / 55% |
| tailwindcss.com | landing | 145 / 144 / 139 | 68% / 65% / 67% |
| github.com | landing | 145 / 137 / 137 | 67% / 70% / 71% |
| Bootstrap dashboard example | dashboard | 24 / 24 / 8 | 79% / 71% / 50% |
| Bootstrap pricing example | dashboard | 9 / 9 / 9 | 56% each |
| MDN `flex` reference | docs | 160 / 32 / 32 | 12% / 56% / 56% |
| docs.python.org | docs | 5 / 6 / 6 | 40% / 50% / 50% |
| Vite guide | docs | 106 / 21 / 18 | 89% / 71% / 72% |
| Bootstrap cheatsheet | components | 115 / 109 / 109 | 38% / 41% / 44% |
| ui.shadcn.com | components | 220 / 142 / 17 | 88% / 84% / 76% |

Overall, **1,400 of 2,245 flex containers (62%) convert**: 698 of 1,064 on
landing pages, 55 of 83 on dashboards, 185 of 386 in docs, and 462 of 712 in
component libraries. Of the converted containers, 522 hold text items, 131
use `fill`, 90 wrap, and none are reversed. The same pages have 375 grid
containers, which are never converted.

The 845 containers kept fixed, by reason:

| Kept fixed because | Containers | Share of kept |
| --- | ---: | ---: |
| Child positions do not match the model | 397 | 47% |
| In-flow children differ in stacking | 147 | 17% |
| Per-side borders | 142 | 17% |
| No in-flow children (nothing to lay out) | 73 | 9% |
| Positioned flow children beside absolute ones | 37 | 4% |
| A text line overflows its element's box | 29 | 3% |
| A rotated child | 15 | 2% |
| Centered or spaced children overflow | 4 | <1% |
| `align-items: baseline` | 1 | <1% |

The mismatch bucket was split by geometry: 239 have uneven main-axis spacing
from item margins (often a `::before` icon with a right margin), 54 have one
auto margin pushing items to the far end, 14 start with a leading margin, 31
plus 4 are offset on the cross axis, 21 are wrapped lines, 16 overflow the main
axis, 4 are reordered with `order`, and 14 are unclassified. **Item margins,
auto margins included, account for about 307 of the 845 kept containers**:
the capture records margins only for text items, through their element box.

### Live import of the real pages

Nine of those scenes were imported into Penpot 2.18.4-RC5 through Orca's
embedded Chromium, each twice: as a snapshot and with native layouts. The
harness takes the captured scenes with
`PHASE5_SCENES=<scenes.json> node scripts/importer-live-harness.mjs`.
`compare <snapshotPage> <nativePage>` pairs every layer by viewport, source,
and type (nearest first when several layers share a source, as border sides
and text runs do) and counts those that moved or resized by more than 1 px.
Groups are counted separately, since a group draws nothing itself.
`reflow-probe <page>` grows every native board 40 px along its main axis,
checks that the host's child positions match the model at the new size,
restores the size, and checks again.

**The trial found a conversion defect.** The first Bootstrap dashboard import
converted 19 containers, reverted none, and moved 381 layers 24 px left. The
sidebar-and-content row has the padded `<main>` as a flex item. An undecorated
container is imported as a group, or collapsed onto its single child, and a
group's bounds shrink to its content. Penpot's layout then places those
bounds, not the element box, at the item's slot, so the padding vanished. The
host check missed it because it predicts from the host's own layer sizes. Two
changes fix it:

- A container laid out by a native flex board is imported as a non-clipping
  board at its element box, as the flex board itself is (the `#padded-item`
  fixture tile).
- The host check also requires every non-text, non-filling layer to keep its
  captured size, so a layer whose bounds are not its item (an SVG drawn inside
  its viewport, say) reverts its container instead of moving.

Results after the fix:

| Scene | Layers | Converted | Reverted | Layers moved > 1 px (in native layouts) | Reflow: boards matching the model (grown / restored) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Bootstrap dashboard, desktop | 276 | 19 | 0 | 0 of 417 | 19 / 19 of 19 |
| docs.python.org, desktop | 249 | 2 | 0 | 0 of 210 | 2 / 2 of 2 |
| vite.dev, desktop | 328 | 55 | 0 | 5 of 381 (3) | 55 / 55 of 55 |
| Vite guide, desktop | 956 | 94 | 0 | 2 of 941 (2) | 94 / 94 of 94 |
| tailwindcss.com, mobile | 1,813 | 93 | 0 | 12 of 1,408 (11) | 93 / 93 of 93 |
| github.com, desktop | 694 | 97 | 0 | (no snapshot import) | 97 / 97 of 97 |
| github.com, mobile | 684 | 97 | 0 | (no snapshot import) | 97 / 97 of 97 |
| ui.shadcn.com, desktop | 562 | 192 | 1 | (no snapshot import) | 186 / 191 of 192 |

Every converted count equals the planner's count for that scene, except one
shadcn container that the host check reverted.

Every layer that moved is text, or follows text that reflowed in Penpot's
substituted font: the `kbd` key hints after the search label on both Vite
pages (2.4 and 3.4 px), a row of Tailwind captions (1 to 8.5 px), and one
image 1.06 px. This is the reflow the host check is meant to allow. A snapshot
import leaves the same text at its captured position but at its host width.

Native layouts added 1 to 11 seconds to the import: 24.6 to 26.7 s for the
Python docs, 36.7 to 41.1 s for the dashboard, 42.3 to 53.6 s for vite.dev, and
237.7 to 238.9 s for the Vite guide.

In the reflow probe, six shadcn boards missed the model after growing. All six
are wrapping rows whose items no longer fit the board's height once the lines
reflowed, and Penpot centers lines that overflow the cross axis where CSS
starts them at the top (compare the overlapping lines under
[Limits](#limits)). One centered button was off by 1.0 px after the restore.

Two failures are not native-layout defects, and they happen with either
setting. The Bootstrap cheatsheet fails to import because Penpot rejects the
image fill made from `form-select`'s URL-encoded SVG chevron (`Value not
valid … :fills`). The snapshot imports of the GitHub (both viewports) and
shadcn scenes failed six of six times with "Penpot did not confirm saving this
board within 30 seconds", while the native imports of the same scenes saved.
Those three rows therefore have no snapshot comparison; their native imports
were checked by the reflow probe and against the planner's counts. Both
failures are recorded for the evidence and persistence follow-ups (#52).

### Decision

**Stay opt-in, labelled experimental.** The trial supports the conversion:
after the fix, nothing it converted moved except text reflowing in Penpot's
fonts, and every board it kept reflowed as the model predicts. It does not yet
support making native layouts the default:

- The trial found a defect that silently moved a whole page region and that
  the host check could not see. It is fixed and now caught, but a single round
  of twelve pages is not enough evidence that nothing similar remains.
- About a third of real flex containers still stay fixed, so a default-on
  import would be a mix of responsive and fixed boards that users cannot tell
  apart without the diagnostics.
- A native import is slightly less faithful at rest: text that reflows in
  Penpot's fonts moves the items after it (up to 8.5 px here), where a snapshot
  keeps them at the browser's positions.
- It costs up to about a quarter more import time on flex-heavy pages.

Revisit the default once item margins are captured and a second trial on new
pages shows no unexplained moves.

**Follow-ups, ranked by the containers they would convert:**

1. **Item margins, including auto margins**, about 307 of the 845 kept
   containers (36%). The capture should record each item's computed margins,
   and the planner should pass them through as layout-child margins, as it
   already does for text. `auto` margins need Penpot's equivalent or should
   stay fixed.
2. **Per-side borders**, 142 (17%). The side paths could become absolutely
   positioned children of the layout board instead of blocking the conversion.
3. **Stacking differences among in-flow children**, 147 (17%) and 37 more
   beside absolute children. These are harder: Penpot's layer order is its
   layout order.
4. **Grid (#50).** The same pages have 375 grid containers against 2,245 flex
   containers, and grids often hold whole page sections. It has the largest
   effect per container but the most work.
5. Wrapped-line mismatches (21), main-axis overflow (16), and `order` (4) are
   minor.

## Grid

Assessed, not converted. Penpot has a grid layout with typed tracks and per-child
cell placement, but the capture records only that a container is a grid and its
gaps; it does not record track templates or item placement, and there is no
verified model of how Penpot sizes auto and fractional tracks. Grid needs those
captured first, then the same model-and-verify approach used here.

## Verification

- Fixture [`flex-layouts.html`](../src/capture/fixtures/flex-layouts.html):
  sixteen supported containers (basic, space-between, column, centered, a
  decorated card with a nested text column, an absolute badge, wrapping, row
  reverse, text beside a box, a growing item, two equal growing items, unequal
  growth at fixed sizes, column reverse, centered wrapped lines, and a padded
  undecorated wrapper as an item) and five
  kept fixed (a wrapping row reverse, `wrap-reverse`, auto margin, `order`,
  baseline), with three real-Chrome references. The baseline runner pins the
  captured flex semantics, the text boxes, and the grow factors.
- The #49 baselines were regenerated with Chrome 155 (previously 154). Every
  other fixture's scene is unchanged apart from the new `box`, `alignContent`,
  `flexGrow`, `flexShrink`, and `flexBasis` fields; the three
  `unsupported-css` screenshots differ by at most one byte of PNG output under
  the new Chrome.
- `src/importer/flexLayout.test.ts` (23 tests) covers the model, each
  justification, reversed axes, margins, fill sharing, line breaking and every
  `align-content` placement, the border-plus-padding rule, the text box and fill
  decisions, and every rejection reason. `flexLayout.fixture.test.ts` runs the
  planner over the real browser scenes at all three viewports, including the
  text margins, the fill decisions, and the wrap and reverse settings.
  `nativeLayout.test.ts` (12 tests) drives the host step with a simulated
  Penpot: a layout that runs, reflows around changed sizes, never runs, runs
  wrongly, absolute children, missing children, configuration, wrap and reverse
  settings, mirrored justification for a reversed row, margins and fill sizing,
  a host that ignores fill (reverted, with the captured size restored), and a
  layer whose bounds are not its captured item (reverted).
  `penpot.test.ts` imports the fixture with the option off (no layout
  requested), on (supported boards converted at the captured positions), and
  with a host that never applies layouts (full fallback); the padded wrapper
  item is a board at its element box. The fixture test also checks that
  `planSceneFlex`, which the importer and the trial script share, decides
  every flex container below the scene root.
- Validation: all 467 tests pass; app, API, and Worker typechecks, the
  production build, and `npm run check:dist` pass. `npm run test:importer-fixtures`
  passes 346 tests in 17 files.
- Live host for #51, 2026-10-24, Penpot 2.18.4-RC5: besides the real pages
  above, the fixture imported at all three viewports with 62 native boards
  each and no reverts. Against a snapshot import of the desktop scene, only the
  two items after the label in `#text-row` moved (3 and 3.5 px, the known font
  reflow); `#padded-item`'s wrapper is a board at its element box. The reflow
  probe matched every non-reversed board grown and restored, except
  `#wrapping`, whose grown boxes no longer fit its height and were compressed
  (see [Limits](#limits)).
- Live host for #49, 2026-10-24, Penpot 2.18.4-RC5 through Orca's embedded
  Windows Chromium:
  - The first desktop import reverted all three reversed containers. A probe
    (`flex-probe`, section 9) showed why: Penpot's `row-reverse` with `start`
    packs the reversed sequence against the left edge (CSS `flex-start` packs
    against the right), `end` packs it against the right, and with `wrap` the
    reversed sequence is broken into lines (C, then B A, where CSS has A B, then
    C). Justification is now mirrored for reversed boards, and wrapping reversed
    containers stay fixed.
  - After that change, all three viewport imports converted 59 boards (the 15
    containers plus the boxes inside them), kept five fixed, and reverted none.
    Of the 59 non-text layers, 58 match the browser within 1 px at every
    viewport. In `#text-row` the box after the label, and the text after it,
    sit 3.44 px left because the host's Inter renders "Status" 38.00 px wide
    against the browser's 41.44 px: real reflow, as the host check intends.
    Text layers carry their glyph-inset margins (four per viewport) and growing
    items `fill` sizing (three per viewport).
  - **Editing** (desktop): widening `#grow` by 60 px grew its filling item from
    146 to 206 px and moved the last box by 60; widening `#grow-equal` grew both
    filling items by 30; a layer appended to `#reversed` landed at the far (left)
    end after the gap; a taller bottom item in `#column-reverse` pushed its
    siblings up by 10; a longer caption in `#card-text` kept both margins and
    left the heading in place. Narrowing `#wrapping` to 120 px moved each item
    onto its own line, but the three lines no longer fit the fixed 80 px height,
    and Penpot compressed them to overlap where CSS would let them overflow.
  - **Undo, redo, reload** (tablet): one Undo removed all 141 shapes and 59
    layouts (141 to 1); one Redo restored them with their fill sizing, margins,
    wrap, and reversed directions; after a saved reload there were still 141
    shapes and 59 layouts, with the same geometry.
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

- Main-axis `fill` is the only responsive sizing: a converted board does not
  hug its content, so editing text that grows past its container does not
  resize the container, and stretched items keep their captured cross size.
- A wrapping board made too small for its lines compresses them in Penpot,
  where CSS would overflow, and lines taller than the board are centered
  where CSS starts them at the top; the initial import always fits.
- The native layouts reflow with the host's fonts; the reflow is real
  behavior, not a defect.
- Containers are not converted when the model cannot reproduce them; there is no
  partial conversion of a container.
