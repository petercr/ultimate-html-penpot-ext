# Importer performance measurements

Phase 5's first batch adds local profiling, avoids redundant text/style reads,
and batches Penpot object creation. This records the first before/after run;
bounded asset concurrency and single-board checks now have
[separate evidence](importer-assets-and-persistence.md). Transformed geometry,
additional CSS features, and the upper live persistence limit remain open in
[the upgrade plan](../IMPORTER-UPGRADE-PLAN.md).

## Reproduce

With dependencies and Google Chrome installed:

```sh
npm run benchmark:importer -- /tmp/importer-benchmark.json
```

The runner bundles the actual source preparation, capture sandbox, extractor,
validation, and importer. It uses a temporary loopback server and Chrome
profile, rejects external HTTP(S) requests, and cleans both up. One warm-up
precedes three measured runs of each generated fixture: 12, 80, and 240 cards.
Each run captures Desktop 1440×900, Tablet 768×1024, and Mobile 390×844 with
scripts off and no additional settle delay. Cards contain short single-line
labels, wrapped text, emoji/combining marks/Japanese text, and a reused raster
image. A bundled DejaVu Sans font makes browser geometry repeatable.

The capture is real browser layout through the opaque iframe, including source
preparation. Import uses a **mock Penpot API in Chrome**. It measures this
repository's importer and event-loop scheduling, including existing text-fit
and board-flush waits; it excludes Penpot rendering, font substitution, upload
latency, undo behavior, and server persistence. These are not live-host speed
claims. The fixtures reuse one scene asset, so this is not an asset-concurrency
or URL-service benchmark.

## Recorded comparison

Measured on the same machine on October 3, 2026 (EDT), with Chrome
153.0.8010.52 and Node 24.21.0. Values are medians of three runs. Node counts and
timings cover all three boards together.

| Fixture | Captured nodes | Extraction before → after | Mock import before → after | Import reduction |
| --- | ---: | ---: | ---: | ---: |
| Small | 294 | 99.4 → 111.4 ms | 3,313.0 → 2,465.5 ms | 25.6% |
| Medium | 1,926 | 535.4 → 397.3 ms | 8,624.8 → 2,531.7 ms | 70.6% |
| Large | 5,766 | 1,600.8 → 1,222.9 ms | 20,960.8 → 2,724.7 ms | 87.0% |

Medium and large extraction improve by 25.8% and 23.6%; the small fixture's
extraction is slightly slower. End-to-end capture includes iframe setup and
font/image/DOM settling, which vary independently of traversal:

| Fixture | Source preparation before → after | Complete capture before → after |
| --- | ---: | ---: |
| Small | 74.0 → 71.3 ms | 5,534.6 → 5,421.7 ms |
| Medium | 89.5 → 75.8 ms | 5,782.1 → 6,305.4 ms |
| Large | 81.2 → 82.4 ms | 6,625.7 → 6,047.0 ms |

The mixed complete-capture results do not establish a uniform overall capture
speedup. Source fetching/asset preparation and browser readiness should be
profiled separately in the next batch.

The raw [before](performance/phase5-before.json) and
[after](performance/phase5-after.json) records retain every sample: source
fetch/CSS/image/font/SVG preparation; iframe preparation, settling, extraction,
and text measurement; node/asset counts and style/geometry/Range reads; import
rendering, text fitting, board-flush waits, scheduler waits, and cancellation
latency. Text measurement is part of extraction; scheduler waits are part of
rendering, so those submetrics must not be added to their parent phase.

Both runs were based on commit `a41e3c4` with local changes. The source hashes
in each record identify the measured implementation; the commit field alone
does not identify those uncommitted changes. The final runner also records its
bundle hash and refuses to finish if its source inputs change mid-run.

## What changed

- Element styles are cached during the synchronous traversal after settling.
  Suppressed subtrees do not need geometry reads. The large fixture drops
  computed-style reads from 14,427 to 10,821.
- Existing full-run Range rectangles identify single-line text without a
  separate read for every character. Wrapped text streams graphemes and
  reuses its measured layout when producing line layers. The large fixture
  drops text Range reads from 214,620 to 91,440. Browsers without
  `Intl.Segmenter` still iterate code points to keep surrogate pairs whole.
  See [Range geometry](https://developer.mozilla.org/en-US/docs/Web/API/Range/getClientRects)
  and [grapheme segmentation](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter).
- Creation yields after a 4 ms time budget or 100 visited nodes, including
  containers and omitted empty layers. Median creation yields fall from
  216/1,440/4,320 to 2/20/60. Paint order, per-board undo boundaries, and the
  existing host-settle delays retain their established behavior.
- Cancellation is checked after scheduler yields and during text-fit/flush
  waits. Those waits retain one completion timer and poll cancellation
  independently, avoiding a chained completion delay in a throttled tab.
  [Chrome's timer documentation](https://developer.chrome.com/blog/timer-throttling-in-chrome-88?hl=en)
  describes the throttling that makes unconditional per-layer timers costly.

Profiling is opt-in through callbacks on `resolveSource`, `capturePage`, and
`importScenes`. It does not add fields to scenes, publish telemetry, or change
the plugin UI. Observer failures do not prevent capture completion or import
rollback. The import clock falls back to `Date.now()` when a Penpot compartment
does not expose `performance`.

## Fidelity and responsiveness evidence

All before/after benchmark scene hashes match, and each fixture's scene hash is
stable across its three repetitions. Regenerating `baseline:importer` leaves
all 15 existing PNG hashes and every generated fixture scene unchanged; only
the extractor/browser metadata changes.

Each sample separately requests cancellation 20 ms into another import and
asserts partial boards are removed. Final observed cancellation latency is at
most 3.5 ms. Median heartbeat gaps during the timed imports are 16.5, 16.7,
and 19.0 ms, with one large-run maximum of 32 ms. This is a responsiveness
probe in the mock host, not a guarantee for a blocking host API operation.

Regression tests cover single-line and comment-separated Unicode text;
grapheme boundaries and older-browser surrogate pairs; cancellation while
traversing empty containers and during final flushing; profiling cleanup; and
an import host without `performance`. The existing clipping, opacity,
stacking, asset-failure, and text regressions continue to apply.

A live Penpot pass remains required before claiming persistence safety or
host-level performance improvements. Record host/build, font availability,
timings, undo/redo and cancellation, and large-board save results using the
[existing comparison procedure](importer-visual-baselines.md#live-penpot-comparison-procedure).
