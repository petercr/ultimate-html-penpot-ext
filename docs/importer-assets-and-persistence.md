# Asset uploads and single-board validation

Phase 5 now overlaps up to three independent media uploads. Shape creation,
SVG conversion, grouping, and appending still follow the existing paint order.
The cache shares in-flight promises as well as completed successes and failures
across all responsive boards. Prefetching covers referenced raster media and
container backgrounds for the current board; unused assets and editable SVG
fallbacks are not uploaded speculatively.

Inline media is decoded directly into bytes, including base64, percent-encoded
binary data, and UTF-8 text. The signed-in host exposed a fetch response without
`arrayBuffer()`, so using browser fetch to decode data URLs caused every inline
image upload to fail before reaching Penpot. The importer now supplies bytes to
the public [media upload API](https://doc.plugins.penpot.app/interfaces/Penpot#uploadMediaData)
without relying on that response or a constructible `TextEncoder`.

Cancellation stops queued uploads and removes partial boards plus layers that
were still on the page root while awaiting media or SVG conversion. Started
host upload calls cannot be aborted through the plugin API; the importer waits
for them to settle before accepting another import. Uploaded media may remain
in the file even when the associated shapes are removed.

## Repeatable asset benchmark

```sh
npm run benchmark:importer -- /tmp/importer-assets.json --assets
npm run benchmark:importer -- /tmp/importer-single-board.json --single-board
```

The asset benchmark runs the real importer against a mock host in Chrome.
Each asset appears twice per board across three viewports. Uploads have
controlled 100/20/60 ms delays and every seventh asset fails, allowing later
uploads to finish first. The benchmark validates that each distinct asset is
uploaded once, all started uploads settle, and the output tree and diagnostics
are identical across repetitions. No requests reach the fixture URLs.

On October 4, 2026, Chrome 153.0.8010.52 and Node 24.21.0, three-run medians:

| Distinct assets | Nodes across three boards | Serial uploads | Three concurrent uploads | Reduction |
| ---: | ---: | ---: | ---: | ---: |
| 12 | 75 | 1,532.6 ms | 1,030.6 ms | 32.8% |
| 48 | 291 | 3,889.7 ms | 1,777.4 ms | 54.3% |
| 120 | 723 | 8,629.8 ms | 3,248.3 ms | 62.4% |

All output hashes match before and after. Peak uploads increase from one to
three; upload counts stay at 12, 48, and 120, including failures. The raw
[before](performance/phase5-assets-before.json) and
[after](performance/phase5-assets-after.json) records include source and bundle
hashes. These controlled delays demonstrate overlap, not production network
or host speed claims.

The [single-board mock run](performance/phase5-single-board.json) validates
1,000, 5,000, and 20,000 scene nodes on one board, including the current
per-scene maximum. Its median processing times are 274.7, 460.7, and
1,191.7 ms, and every expected child is present. The mock has no save-event
API, so persistence checkpoints are disabled. It does not exercise backend
persistence or establish a host request-size ceiling.

## Undo grouping and persistence

Penpot's [history API implementation](https://github.com/penpot/penpot/blob/develop/frontend/src/app/plugins/history.cljs)
groups undo operations; its
[persistence implementation](https://github.com/penpot/penpot/blob/develop/frontend/src/app/main/data/persistence.cljs)
buffers local commits separately. Therefore a completed undo block and the
importer's 250 ms host-settle delay do not force a save, acknowledge one, or
bound its request size. The comments in the importer now state this accurately.
`commitWaitMs` remains the historical profiling field name for this settle
delay, not a measured backend save time.

Boards with at least 500 scene nodes now pause every 250 visited nodes and
wait for the public `contentsave` notification before creating the next batch.
The remaining mutations, including text fitting, receive a final checkpoint.
Text adjustments also checkpoint in batches. The entire board retains one
undo block. Hosts without the public event API keep the existing behavior.
The importer reports `Saving <viewport>` progress and records `saveWaitCount`
and `saveWaitMs`; these waits are included in the render/text-fit phase times.
Cancellation remains active while waiting. A missing save notification after
30 seconds produces an actionable error and rolls back the partial import.

This bounds the stream of importer operations between save opportunities.
It does not impose a byte limit on a request: nested SVG conversion, complex
shapes, uploaded media, and concurrent edits can produce very different
payload sizes for the same scene-node count.

A live test uses `https://design.penpot.app`, Penpot 2.18.1, through Orca's
embedded Windows Chromium 150.0.7871.250. The rectangular workload uses no
fonts or media. Without checkpoints, one 1,000-node attempt saved a 7.7 MB
request, while a repeat reached Penpot's "Error on saving" state. The failed
request had no recorded HTTP response, so this does not establish a universal
request-size threshold. A reload that raced a pending redo save is excluded
from successful reload evidence.

With checkpoints, 1,000 scene nodes produced one board with 999 children and
five save notifications. All five `update-file` requests returned HTTP 200;
the largest was 1,933,740 bytes, with 7,734,831 bytes across all five. Importer
processing took 130,225 ms, including 20,662 ms waiting for saves. After the
final acknowledged save and successful responses, a reload restored the same
board ID and all 999 children. This validates persistence for the recorded
workload, rather than promising a live import speedup.

A 500-node import, the smallest size that uses checkpoints, produced one board
with 499 children and three save notifications in 58,364 ms (11,952 ms waiting
for saves). A single Edit > Undo removed the whole board, leaving only the root
frame, and saved with HTTP 200 (3.18 MB). A single Edit > Redo restored the same
board with 499 children and saved with HTTP 200 (3.87 MB). The checkpoints
therefore keep the import in one undo block. Synthetic Ctrl+Z key presses sent
through Orca did not reach the workspace, so the menu commands were used.

The live media workload uploads 12 distinct generated PNGs at a peak concurrency
of three. Each image appears twice on each of three boards: all 72 image layers
have fills, the same 12 media IDs are reused across the boards, and no import
diagnostics occur. Processing takes 6,302 ms on this host. This validates the
real byte-upload path and sharing behavior; it is not a before/after speed test.

The host's upper persistence limit remains open. A mock pass at 20,000 nodes
is not proof that that workload saves in the live host. Keep the existing
layer/payload limits and workload warnings; do not infer a safe maximum from
layer count alone.

## Local live-harness procedure

The developer harness bundles the actual importer with an alternate entry;
it temporarily replaces ignored `dist/plugin.js` and `dist/index.html` and is
never included in the production build. It creates distinctly named validation
pages, validates scenes before mutations, reports import metrics and public
`contentsave` events, and can inspect saved layer counts after a reload.

With the normal local plugin already installed and `dist` built:

```sh
node scripts/importer-live-harness.mjs
npm run preview -- --host 0.0.0.0 --port 4173 --strictPort
orca-ide tab list --json
node scripts/importer-live-orca.mjs <browserPageId> open
node scripts/importer-live-orca.mjs <browserPageId> run 1000
node scripts/importer-live-orca.mjs <browserPageId> status
node scripts/importer-live-orca.mjs <browserPageId> network /tmp/save-requests.json
```

Use the executable selected by Orca's version-matched CLI skill on your platform.
The automation helper uses `ORCA_CLI_COMMAND` when configured. `connect`
reattaches its observation listener to an already-open harness after an
automation interruption. `assets 12` imports 12 distinct generated PNGs,
reused twice on each of three boards.

The transformed-geometry checks use the same harness. `fixture 0` imports the
desktop scene (index 0; 1 is tablet and 2 is mobile) of the checked-in
`transforms.html` baseline, with its assets inlined so no fixture server is
needed; set `PHASE5_FIXTURE=<file>` when running `importer-live-harness.mjs` to
embed another fixture's scenes. `rotated-image` imports a rotated image fill,
a rotated background-image box, and a plain rotated control. `inspect` also
reports each shape's geometry, including the corner of a rotated layer, so the
result can be compared with the scene's expected frame, and `focus <pageId>
<layerNames...>` zooms to named layers for a screenshot.
`rotation-probe`, `pivot-probe`, `late-rotation-probe [1|2]`, and `delay-probe`
each create a page and record how the host rotates and places shapes; their
findings are summarized in [Transformed geometry](importer-transforms.md). The
probes leave text out on purpose: rotating a text layer after its layout has
settled can freeze the host tab. If a tab freezes or shows an internal-error
page, open a new tab on the workspace instead of reusing it.

For a large-board import, wait for `import-complete` with `saveAcknowledged`
true, and HTTP 200 responses for all its save requests before reloading.
For other operations, wait for their following `save-observed` event and
HTTP 200 save response. Reopen the harness after
reload, then `inspect <testPageId>` to check the same board and child count.
Record undo and redo separately; wait for the redo save as well. The host's
`contentsave` notification is file-wide, so the layer-count check after reload
is required to verify the board itself.

`cleanup <originalPageId> <testPageIds...>` removes boards from the supplied
validation pages and restores the original page. Delete the empty pages through
Penpot's page menu; the installed public API does not expose page deletion.
Finish by closing the harness and running `npm run build` to restore the normal
plugin, then reopen it. Do not leave the temporary entry installed as the
ordinary plugin build.
