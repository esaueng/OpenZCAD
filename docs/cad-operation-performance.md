# CAD operation performance characterization

This opt-in benchmark records rebuild behavior for one representative
extrude, boolean, fillet, chamfer, pattern, parameter-driven feature, and
direct-edit history. It characterizes the current implementation; it does not
make wall-time claims or gate CI. A run records a cold adapter/history replay
after the WASM module has already loaded, an unchanged warm repeat, an edited
warm history, early and late edits, and a fresh-adapter correctness oracle for
each edited sample. The cold phase excludes WASM download, compilation, and
instantiation.

The operation timing boundary is `ExactKernelAdapter.syncDocument`. The
adapter also reports durations for full-history phases and individual feature
replay through `RebuildProgressListener`; it does not expose timings within a
Remus operation. This is adapter timing: it excludes worker request/response
and transfer costs, React scheduling, mesh projection/display, and rendering.
Results include those progress events, cache counters,
output body/triangle counts, process heap observations, git/source provenance,
and a SHA-256 of the installed `remus-wasm` binary. An optimization's internal
stages require additional instrumentation before they can be attributed to a
specific kernel substep.

Run from the repository root in a quiet machine window:

```bash
CAD_PERF_RUN=1 pnpm exec vitest run --config test/perf/cad-operations.config.ts
```

The default matrix uses 5 edited samples at 30, 33, and 100 feature history
sizes. To narrow a run, set `CAD_PERF_FAMILIES=boolean,fillet`,
`CAD_PERF_HISTORY=33`, and/or `CAD_PERF_SAMPLES=3`. `CAD_PERF_OUT` selects the
artifact directory and `CAD_PERF_SESSION` names the JSONL and summary outputs.
The harness appends raw samples; use a new session name for every independent
run. Summaries report median and nearest-rank p95 from the edited warm samples.
With five samples, p95 is descriptive and not a stable tail estimate; use
multiple quiet sessions before drawing conclusions about small differences.

For a reference checkout, run the same command there with
`CAD_PERF_MODE=baseline CAD_PERF_BASELINE_ROOT=/path/to/reference`. The config
aliases only the adapter entrypoint to the reference checkout; keep the
remaining source, Node version, machine load, installed Remus package, family,
history size, and sample count fixed. Confirm `sourceSha`, `adapterSourceSha256`,
`remusLockLine`, and `wasmSha256` in both outputs before comparing. A source
tree can contain unrelated differences, so benchmark records are evidence,
not an automatic causal attribution.

Early edits change the first primitive's width; late edits change the final
primitive's width. Operation edits change the representative feature input
(for booleans, union to subtraction). Parameter edits change an expression
referenced by the base feature. Every warm edited result is compared against a
fresh adapter with history checkpointing disabled after omitting the volatile
update timestamp and rebuild-local `blendRegionKey`, and normalizing
tessellation to triangle count. `blendRegionKey` contains temporary kernel
handles; its accompanying face count and all measured topology remain checked.
Warnings fail the run. No wall-time assertion is used because machine load,
WASM compilation, and operation geometry make such thresholds unreliable.

The history sizes connect to W01 worker timing/cloning/retained-memory budgets
and W02 checkpoint qualification. The benchmark is a characterization input;
those roadmap items retain their own acceptance criteria.

The same-WASM baseline/candidate comparison is summarized in
[`cad-operation-baseline-vs-candidate.csv`](performance/cad-operation-baseline-vs-candidate.csv).
Its [provenance record](performance/cad-operation-baseline-vs-candidate.provenance.json)
identifies the two source revisions and adapter hashes, verifies the installed
WASM identity, and records normalization and load caveats. The standalone
[baseline summary](performance/cad-operation-baseline-06941214.csv) is also
retained. Raw progress-event streams stay in the local `/tmp` artifact
directory rather than being committed.

The follow-up [geometry latency comparison](geometry-latency.md) measures
primitive reuse, on-demand mass properties, union mesh reuse and the paired
Remus area integration optimization.

## Browser edit path

The adapter benchmark excludes worker messaging and viewport work. This
separate opt-in probe applies repeated edits to a real box in the browser and
records input-to-worker-request, request-to-worker-response,
response-to-`viewer.bodies`, and body-installation-to-next-`viewer.frame`
intervals. It retains the exact canonical document sent to the worker for
each sample and requires a successful response without warnings. The frame
marker is a render-loop observation; it does not prove GPU completion or
physical display presentation. Runtime errors fail the probe, and Playwright
attaches the raw samples, environment, and median/p95 summary as
`cad-edit-performance.json`.

Run it in the same quiet machine window used for the adapter comparison:

```bash
OZ_PERF=1 pnpm exec playwright test perf-cad-edit
```

Set `CAD_PERF_BROWSER_SAMPLES` to request more than the default five warm
edits. The initial non-empty sync is captured separately and is not mixed into
the warm edit summary. Instrumentation serializes the small test document and
adds browser-side overhead, so treat these timings as observed bounds rather
than uninstrumented latency.

The browser probe passed on Headless Chromium 151 with Remus WASM and
remus-wasm-io 2026.1.3 installed from commit `fe3c8efa`. Across five alternating
width edits, the measured median intervals were 22.6 ms from the Apply click to
worker request, 1.8 ms request to worker response, 2.7 ms response to body
installation, 4.9 ms body installation to the next render-loop frame, and
31.7 ms from click to frame. All five worker results succeeded without
warnings, and their exact canonical input documents contain the alternating
12/13 mm widths. With five samples, p95 is the maximum sample and is only
descriptive. Full inputs, raw intervals, checkout/adapter identities, and both
installed WASM hashes are in
[`cad-edit-browser-fe3c8efa.json`](performance/cad-edit-browser-fe3c8efa.json).
