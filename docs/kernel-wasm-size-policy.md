# Remus browser WASM size policy

OpenZCAD uses a staged size policy for the lazy Remus WebAssembly kernel. The
limits are product controls, not browser, Vite, Cloudflare, or WebAssembly
platform limits. All values use binary units: MiB and KiB, not decimal MB and
kB.

## Current thresholds

| Control            |                         Threshold | CI behavior                           |
| ------------------ | --------------------------------: | ------------------------------------- |
| Raw review         |         15 MiB (15,728,640 bytes) | Warning; mandatory kernel-size review |
| Raw hard limit     |         16 MiB (16,777,216 bytes) | Failure above the limit               |
| Gzip hard limit    |           6 MiB (6,291,456 bytes) | Failure above the limit               |
| Brotli review      |           4 MiB (4,194,304 bytes) | Warning; mandatory kernel-size review |
| Per-pin raw growth | More than 256 KiB or more than 3% | Mandatory kernel-size review          |

These are the step 2 values of November 2026. Step 1 (October 2026) was
11 MiB raw review, 12 MiB raw hard, 4.5 MiB gzip hard and 3 MiB Brotli
review; before it, 9, 10, 3.5 and 2.5 MiB. The evidence is recorded under
[Ceiling change 2026-11 (step 2)](#ceiling-change-2026-11-step-2) and
[Ceiling change 2026-10 (step 1)](#ceiling-change-2026-10-step-1). Remus
mirrors the same values in its `scripts/wasm-size-policy.mjs`, which
`cargo xtask wasm-build` evaluates on every kernel it builds.

The policy covers the kernel asset (`assets/remus_wasm_bg-*.wasm`) only. The
file-format translators ship as the separate `remus-wasm-io` package and
asset (`assets/remus_wasm_io_bg-*.wasm`), fetched lazily around an import or
export; they are an approved lazy asset with their own raw budget in
`scripts/report-bundle-sizes.mjs` and do not count against the kernel
thresholds ([ADR-023](adrs/ADR-023-remus-translator-module.md)).

The raw and gzip hard limits are independent: staying below one does not
excuse exceeding the other. Review thresholds are deliberately advisory in
the checker so an acknowledged roadmap increment can proceed without changing
the hard ceiling. They are still mandatory review signals for maintainers.

## Measurement

`scripts/bundle-size-policy.mjs` is the source of truth for thresholds and
measurement. The production bundle check measures the exact emitted kernel
asset:

- raw bytes from the asset buffer;
- gzip bytes from Node's deterministic `zlib.gzipSync()` defaults;
- Brotli bytes from Node zlib at quality 11.

The bundle report records the Node, zlib, Brotli, and quality values used for
the measurement. Brotli remains a review signal rather than a hard gate until
the publishing and compression toolchains are reproducibly pinned. The build
summary and uploaded `bundle-size-report` artifact preserve the measurements
for each CI run.

The automated Remus updater downloads both committed package artifacts and
reports their raw, gzip, and Brotli sizes and deltas in its pull request. A
routine pin update must not alter this policy to make its own update pass.

## Load-time budget

Bytes are a proxy for what users feel. The load-time budget measures the
kernel the way the geometry worker reaches it, and it applies alongside the
byte thresholds: a byte ceiling may only rise while these stay green.

| Profile (kernel-ready, p95 of at least 20 runs)                       |                        Cold budget | Warm budget | CI behavior                         |
| --------------------------------------------------------------------- | ---------------------------------: | ----------: | ----------------------------------- |
| Desktop, unthrottled                                                  |                             110 ms |      110 ms | Warning; mandatory load-time review |
| Mobile-class: 4× CPU throttle, 9 Mbps down / 1.5 Mbps up, 150 ms RTT  |                           3,800 ms |      150 ms | Warning; mandatory load-time review |
| Pin update against the current pin (medians, same runner, alternated) | +5% or +10 ms, whichever is larger |        same | Warning in the updater PR           |

`KERNEL_LOAD_POLICY` in `scripts/bundle-size-policy.mjs` holds these values.
They are review gates, not hard gates: they print a review line (a GitHub
warning annotation inside Actions) and never fail the run. They become hard
gates once the measurement is stable on CI hardware.

### What is measured

`scripts/measure-remus-wasm-load.mjs` (`pnpm perf:remus-wasm`) times
**kernel-ready**: fetch the kernel asset, `WebAssembly.instantiateStreaming`
(as `vite-plugin-wasm` does for an `application/wasm` response), wasm-bindgen's
`__wbindgen_start`, and the first `new RemusKernel()`. The wasm-bindgen glue is
imported before the clock starts; it ships in a JavaScript chunk under the
JavaScript budgets. The harness takes that glue from the installed
`remus-wasm` package and refuses to run when the package's WASM is not
byte-identical to the measured asset.

- **Cold:** a fresh Chromium profile — empty HTTP cache, no compiled-module
  cache. A cold sample that does not reach the server fails the run.
- **Warm:** after a 3 s settle, a new document in the same profile loads the
  kernel again from the HTTP cache (and Chromium's compiled-module cache when
  it wrote one). A warm sample that reaches the server fails the run.
- The local server sends the asset gzip-encoded with Node's `gzipSync()`
  defaults, the encoding of the gzip hard limit. Production (Cloudflare)
  served the 2026.1.53 asset as 3,626,048 bytes gzip and 3,461,445 bytes zstd
  to Chromium on 2026-10-13, so the harness transfer (3,643,759 bytes) is the
  conservative case.
- The mobile-class profile uses Chrome DevTools Protocol CPU throttling,
  which slows the renderer main thread but not V8's background compile
  threads, and network shaping. Its cold result is dominated by transfer
  (3.48 MiB at 9 Mbps ≈ 3.24 s), so it tracks gzip size closely: each
  additional 100 KB of gzip costs about 89 ms. It is a lower bound for a real
  mid-range phone, not a device measurement.
- V8 compiles WebAssembly lazily, so kernel-ready covers decoding, validation
  and instantiation; functions compile on first call, inside the first
  operation. `--first-operation` measures that cost: after kernel-ready, in
  the same document, a fresh `RemusKernel` runs a representative edit
  (`makeBox`, `makeCylinder`, `cut`, a two-edge `fillet`, `tessellateSolid`,
  `volume`) twice and builds and solves a constrained GCS sketch twice. The
  first call minus the second approximates lazy compilation plus first-touch
  memory. Whichever workload runs first also compiles the code both share, so
  the order alternates every two samples and each workload's first-call
  figures come only from the samples where it ran first (`--check` therefore
  needs 40 runs, 20 per order); the other order is reported as
  `solidAfterSketchMs` and `sketchAfterSolidMs`. A sample whose volume or
  solved sketch differs from the reference fails the run. That phase loads the warm document behind cold-document
  work, so the kernel-ready budgets are evaluated only on runs without it.

Commands:

```bash
OPENZCAD_BUILD_COMMIT="$(git rev-parse HEAD)" pnpm build
pnpm perf:remus-wasm -- --profile desktop --check
pnpm perf:remus-wasm -- --profile mobile --check
# A candidate package against the current pin, alternating samples:
pnpm perf:remus-wasm -- --package <remus-wasm pkg> \
  --baseline-package packages/kernel-adapter/node_modules/remus-wasm \
  --profile mobile --runs 20 --kernel-ready-only --check
```

`--package` measures a `remus-wasm` package directory without a build, so a
candidate kernel can be measured before it is pinned.

### Baseline (2026-10-13)

Reference host: Apple M5 Pro (15 cores, 48 GB), macOS, Playwright headless
Chromium 153.0.8010.12, Node 22. Other work shared the host: the one-minute
load average was 7–54 during the runs, so these are loaded-host observations.
Each row is 30 samples; "interleaved" rows alternate the two kernels sample by
sample.

| Profile | Kernel (raw / served gzip bytes)               | Run         | Cold p50 | Cold p95 | Warm p50 | Warm p95 |
| ------- | ---------------------------------------------- | ----------- | -------: | -------: | -------: | -------: |
| Desktop | 2026.1.53, pinned (10,406,201 / 3,643,759)     | sequential  |  35.5 ms |  47.2 ms |  33.5 ms |  42.1 ms |
| Desktop | 2026.1.56, Remus main (10,481,536 / 3,673,853) | sequential  |  38.5 ms |  54.5 ms |  33.6 ms |  48.8 ms |
| Desktop | 2026.1.53                                      | interleaved |  42.0 ms |  76.9 ms |  39.4 ms |  56.6 ms |
| Desktop | 2026.1.56                                      | interleaved |  43.6 ms |  72.4 ms |  41.3 ms |  57.9 ms |
| Mobile  | 2026.1.53                                      | sequential  | 3,468 ms | 3,504 ms |  89.1 ms | 116.7 ms |
| Mobile  | 2026.1.56                                      | sequential  | 3,486 ms | 3,512 ms |  74.7 ms |  89.0 ms |
| Mobile  | 2026.1.53                                      | interleaved | 3,455 ms | 3,482 ms |  70.7 ms |  93.8 ms |
| Mobile  | 2026.1.56                                      | interleaved | 3,482 ms | 3,505 ms |  74.3 ms |  98.7 ms |

Two further interleaved runs of 2026.1.53 against itself measured the noise
floor. Medians agreed within 2.6 ms in both profiles, while p95 did not: the
two sides' desktop warm p95 differed by 31 ms (44.3 against 75.2 ms). Their
p95 values were desktop cold 51.6 / 54.9 ms, desktop warm 75.2 / 44.3 ms,
mobile cold 3,554 / 3,539 ms and mobile warm 99.1 / 98.6 ms.

### How the budgets were set

The proposed targets were 2 s desktop cold, 5 s mobile-class cold and 0.5 s
warm. No budget may be looser than today's measurement, so each budget is the
worst p95 of every measurement above (both kernels; sequential, interleaved
and noise runs) plus max(25 ms, 5%) for host variance, rounded up: desktop
cold 76.9 → 110 ms, desktop warm 75.2 → 110 ms, mobile cold 3,554 → 3,800 ms,
mobile warm 116.7 → 150 ms. Every budget
is below its proposal; the desktop proposals would have left 20–40 times
today's load time unreviewed.

The budgets describe the reference host. A different machine, and above all
a shared CI runner, measures different absolute times, which is why CI does
not apply them as hard limits:

- The automated Remus updater (`update-remus.yml`, hosted `ubuntu-latest`)
  measures the candidate against the current pin on the same runner with
  alternating samples in both profiles, and adds the table to its pull
  request. The pin comparison uses medians, which the noise runs above show
  are stable to a few milliseconds where p95 is not; the candidate is flagged
  when its median exceeds the pin's by more than 5% or 10 ms, whichever is
  larger. The absolute budgets appear in the same table for reference. The
  step never blocks the update; a failed measurement is stated in the PR.
- The pull-request `validate` job does not run the harness: its trusted
  runners give a job as little as one CPU beside other jobs, so absolute load
  time there would measure the runner, not the kernel.

Recalibrate on the reference host when the budgets move: run both profiles
with `--check` on the pinned and the candidate kernel and record the table
here.

## Raising the hard ceiling

Crossing a hard limit does not by itself justify raising it. A separate budget
change requires all of the following evidence:

1. The effective Rust, `wasm-pack`, `wasm-bindgen`, Binaryen/`wasm-opt`, and
   compression toolchains are pinned, or an incompatibility preventing that
   is documented.
2. A production-equivalent optimized build is compared with the published
   `--skip-opt` package.
3. Section- or symbol-level attribution ties the increase to named roadmap
   capabilities.
4. Representative cold-load, compilation, and instantiation measurements are
   captured on at least one desktop and one constrained or mobile-class
   environment, and stay within the [load-time budget](#load-time-budget)
   (`pnpm perf:remus-wasm -- --profile desktop --check` and
   `--profile mobile --check`).
5. The review considers feature gating, narrower browser bindings, stripping
   the name section, and splitting or lazily loading infrequent capabilities.
6. The proposal explains why the code belongs in the initial kernel module
   instead of a native-only crate, worker-side secondary module, import/export
   module, or optional feature.
7. Raw, gzip, and Brotli deltas are reviewed independently of the Remus pin
   update.

Raw size primarily protects download-independent compilation and memory
pressure. Gzip and Brotli describe transfer size under specific encoders.
Neither compressed measurement substitutes for browser load, compilation,
instantiation, or runtime-memory measurements.

## Ceiling change 2026-10 (step 1)

Approved by the owner on 2026-10-13 as step 1 of the Remus browser-kernel size
plan (Remus `docs/design/kernel-wasm-size-architecture.md`, workstream W2), and
paired with the identical change in Remus `scripts/wasm-size-policy.mjs`
(esaueng/remus#1028). It is a separate change, not part of a pin update, and
it leaves the per-pin growth review (256 KiB or 3%) and the load-time budgets
unchanged.

| Control         | Before                    | After                     |
| --------------- | ------------------------- | ------------------------- |
| Raw review      | 9 MiB (9,437,184 bytes)   | 11 MiB (11,534,336 bytes) |
| Raw hard limit  | 10 MiB (10,485,760 bytes) | 12 MiB (12,582,912 bytes) |
| Gzip hard limit | 3.5 MiB (3,670,016 bytes) | 4.5 MiB (4,718,592 bytes) |
| Brotli review   | 2.5 MiB (2,621,440 bytes) | 3 MiB (3,145,728 bytes)   |
| Per-pin growth  | 256 KiB or 3%             | 256 KiB or 3% (unchanged) |

The kernel measured is Remus main's committed `remus-wasm` 2026.1.56 (built
from `fdf3cbbf`): 10,481,536 raw / 3,673,853 gzip / 2,595,062 Brotli bytes. It
is 3,837 bytes over the old gzip hard limit, so no pin update could take it
under the old policy. The seven items of
[Raising the hard ceiling](#raising-the-hard-ceiling) follow.

**1. Toolchains.**

| Tool                     | Version     | Where it is fixed                                                                                                                                                                      |
| ------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust                     | 1.96.0      | Remus `rust-toolchain.toml`                                                                                                                                                            |
| `wasm-bindgen`           | 0.2.126     | Remus `Cargo.toml` (`=0.2.126`); `cargo xtask wasm-build` refuses a different local `wasm-bindgen-cli`                                                                                 |
| `wasm-pack`              | 0.15.0      | `wasm-pack@0.15.0` in Remus `wasm-version.yml`; the publishing and CI builds install it through `taiki-e/install-action` pinned by commit SHA, whose manifest there resolves to 0.15.0 |
| Binaryen `wasm-opt`      | version_117 | Hard-coded in `wasm-pack` 0.15.0, which downloads that release; the flags (`-Oz --enable-simd`) are in the Remus crate metadata                                                        |
| Compression (both repos) | Node `zlib` | `gzipSync()` defaults and Brotli quality 11, here and in Remus `scripts/wasm-size-policy.mjs`; each report records the Node, zlib and Brotli versions                                  |

`wasm-pack` and Binaryen are fixed only through those pins: `cargo xtask
wasm-build` neither checks their versions nor records them in the package, so
moving the install-action SHA can move both. The Node major also differs
(OpenZCAD CI runs Node 22, Remus CI Node 24); the measurements below use Node
22.23.1 (zlib 1.3.1, Brotli 1.1.0). Brotli therefore stays a review signal.

**2. Optimized against `--skip-opt`.** The same cargo artifact as the shipped
build, before and after `wasm-opt -Oz --enable-simd`:

| Build of `fdf3cbbf`                                 |        Raw |      Gzip |    Brotli |
| --------------------------------------------------- | ---------: | --------: | --------: |
| `wasm-bindgen` output, no `wasm-opt` (`--skip-opt`) | 12,282,461 | 3,920,893 | 2,686,738 |
| Optimized, `cargo xtask wasm-build`                 | 10,482,141 | 3,673,544 | 2,594,190 |
| Committed package 2026.1.56                         | 10,481,536 | 3,673,853 | 2,595,062 |

`wasm-opt` removes 1,800,320 raw bytes (−14.7%), 247,349 gzip bytes (−6.3%)
and 92,548 Brotli bytes (−3.4%). The local build reproduces the committed one
within 605 raw bytes. Other `wasm-opt` levels are larger (`-Os` 10,567,208,
`-O3` 10,576,138 raw bytes); `-Oz --converge` saves only 6,633 bytes.

**3. Attribution.** Function bytes before `wasm-opt`, grouped by the first
Remus crate in each symbol (Remus W0 attribution):

| Group                                                             | Share |
| ----------------------------------------------------------------- | ----: |
| std/core/alloc/hashbrown generics with no Remus type in the name  | 32.4% |
| `remus_operations`                                                | 19.0% |
| Binding layer and glue (`BrepKernel`, wasm-bindgen, serde, tsify) | 14.9% |
| `remus_algo`                                                      | 11.4% |
| math, topology, check, blend, heal, offset, sketch, io, geometry  | 19.3% |
| Other (`robust`, std formatting/panic, `remus_wasm`, misc.)       |  3.0% |

The groups total 100.0% of function bytes (the name section and data
segments are not function bytes and are excluded). Generic monomorphization
is about 30% of code. Before `wasm-opt` the largest family looks like
`hashbrown::RawTable::reserve_rehash` (282 instances, 258 KB), but after
`wasm-opt` merges identical copies it is stable sort: about 1.07 MB in 267
per-comparator copies, reduced by Remus #1031. serde, serde_json and tsify
are about 0.55 MB, mostly the arena-document codec, reduced by Remus #1029.

That table is the kernel's composition. Its growth is attributed separately.
From the first package after the translator split (7,602,120 raw bytes,
Remus `3ec7132803`, 2026-09-04) to the 2026-10-12 package 2026.1.55
(10,479,386 bytes, `259683c5ec`), the kernel grew **+2,877,266 bytes**. Each
of the 106 package refreshes after it was measured with `git ls-tree -l`. Each
refresh delta is assigned to the Remus PRs merged between its build source
and the previous one. The deltas telescope, so the rows below sum exactly to
the net growth:

| Capability (Remus PRs)                                                                                     |      Raw delta |  Share |
| ---------------------------------------------------------------------------------------------------------- | -------------: | -----: |
| Persistent edit and heal history: journal, entity references through resize and removal (#338, #346, #348) |       +362,155 |  12.6% |
| Integration batches (#902, #922, #811, #749, #511, #485)                                                   |       +315,004 |  10.9% |
| Other boolean, intersection, tessellation and import correctness rows (B10–B71, O1.1d, #701)               |       +288,562 |  10.0% |
| Directional curve projection, P-Class 7.4 (#938)                                                           |       +274,262 |   9.5% |
| B74 affine transforms, planar arrangement, bounded curved offset (#864, #860, #849)                        |       +271,242 |   9.4% |
| Bounded blend reconstruction and entity history (#608)                                                     |       +255,285 |   8.9% |
| Resource bounds, heal and history completeness (#550–#587, #816, #925)                                     |       +182,216 |   6.3% |
| UV arrangement core O2.3b and its window (#691, #682, #651)                                                |       +135,358 |   4.7% |
| Offset-face latency integration (#963)                                                                     |       +117,965 |   4.1% |
| Quadric boolean seam and band qualification (#297–#299, #305, #307)                                        |       +114,936 |   4.0% |
| Typed operation results O4.7, B18 offset history, construction twins (#354, #637, #638, #730)              |       +113,039 |   3.9% |
| Local boolean stages 1–4 and the performance deep dive (#991–#1021)                                        |       +110,614 |   3.8% |
| Blends and direct edit (#274, #308, #496, #590, #896)                                                      |       +108,738 |   3.8% |
| Material, identity, loft and cavity correctness (#942, #945)                                               |        +91,495 |   3.2% |
| Topology queries for consumers, B16 (#455, #911)                                                           |        +87,368 |   3.0% |
| Hammer model boolean repairs (#357, #361, #363–#375, #391)                                                 |        +82,829 |   2.9% |
| Sketch: B75 constrained ellipse, PERF-S02 components (#882, #867)                                          |        +75,452 |   2.6% |
| Unattributed: rebuild jitter in dependency, CI and release-only windows (18 refreshes)                     |         +2,865 |   0.1% |
| Performance work and other net-shrinking windows (#435, #457, #470, #975, #982)                            |       −112,119 |  −3.9% |
| **Total**                                                                                                  | **+2,877,266** | 100.0% |

A refresh that carries several PRs cannot be split without rebuilding each
PR, so it goes to the capability that dominates it. The appendix
[Remus kernel growth attribution](kernel-wasm-growth-attribution-2026-10.md)
lists every refresh, its delta, its row and the PRs in its window, so the
grouping can be checked. Only the 2,865-byte row is unattributed: those
windows changed no kernel source, so their deltas are rebuild jitter. Since
the window closed, Remus #1029 (hand-written arena document codec) and #1031
(generic sort bloat) shrank the kernel to 9,412,128 bytes (2026.1.57),
−1,069,408 bytes against 2026.1.56, about 37% of the growth above.

**4. Load measurements.** The [load-time baseline](#baseline-2026-10-13)
above covers this kernel: desktop cold p95 54.5 ms sequential and 72.4 ms
interleaved, mobile-class cold p95 3,512 and 3,505 ms, warm p95 at most
98.7 ms; all within the budgets. Mobile-class cold load is transfer-bound at
about 89 ms per additional 100 KB of gzip, so a kernel at the new 4.5 MiB gzip
ceiling (+1,044,739 bytes) projects to about 4.42 s p50 and 4.44 s p95
(+930 ms): below the proposed 5 s target, but above the 3,800 ms review
budget. That budget trips after roughly 276–324 KB more gzip (3,800 ms less
the 3,554 ms worst or 3,512 ms current p95), so load-time review flags growth
well before the gzip hard limit; the byte ceiling does not loosen it. Desktop
loads from loopback, so transfer does not grow. Compilation is lazy and is
measured on first use below.

**First-operation compilation.** Kernel-ready excludes the functions V8
compiles lazily on first use, so `--first-operation` measured them directly.
The runs used the pinned 2026.1.53 and Remus main's 2026.1.57 (9,412,128 raw
bytes, after Remus #1029 and #1031) interleaved, 30 samples each, in two
rounds per profile; the host load average was 5–35. Values are p50 / p95 of
the first call; "overhead" is the first call minus the second. In these two
rounds the sketch always ran after the solid edit, so its columns are the
sketch's cost once the shared code was compiled.

| Profile      | Kernel    | Round | Cold solid edit |  Cold overhead | Warm solid edit | Cold sketch solve | Warm sketch solve |
| ------------ | --------- | ----- | --------------: | -------------: | --------------: | ----------------: | ----------------: |
| Desktop      | 2026.1.53 | 1     |  60.6 / 62.9 ms | 56.1 / 58.1 ms |    6.3 / 6.9 ms |      3.7 / 3.8 ms |      0.2 / 0.3 ms |
| Desktop      | 2026.1.57 | 1     |  61.0 / 63.0 ms | 56.3 / 58.1 ms |    6.0 / 6.7 ms |      3.7 / 4.0 ms |      0.2 / 0.2 ms |
| Desktop      | 2026.1.53 | 2     | 94.6 / 100.2 ms | 87.4 / 92.9 ms |   9.1 / 10.2 ms |      5.7 / 6.1 ms |      0.3 / 0.5 ms |
| Desktop      | 2026.1.57 | 2     |  94.0 / 98.1 ms | 86.9 / 91.0 ms |   8.5 / 10.5 ms |      5.7 / 6.2 ms |      0.3 / 1.1 ms |
| Mobile-class | 2026.1.53 | 1     |    282 / 569 ms |   261 / 523 ms |  27.6 / 53.6 ms |    19.4 / 38.1 ms |      0.9 / 2.3 ms |
| Mobile-class | 2026.1.57 | 1     |    302 / 595 ms |   281 / 553 ms |  26.9 / 50.9 ms |    20.5 / 42.4 ms |      0.9 / 3.1 ms |
| Mobile-class | 2026.1.53 | 2     |    268 / 299 ms |   248 / 271 ms |  25.2 / 32.3 ms |    18.8 / 22.7 ms |      0.9 / 1.7 ms |
| Mobile-class | 2026.1.57 | 2     |    267 / 359 ms |   245 / 332 ms |  23.9 / 38.1 ms |    18.5 / 36.1 ms |      1.0 / 1.7 ms |

A third round alternated the order: 40 samples per kernel and profile, 20 of
them with the sketch first on a module nothing had compiled (host load
average 7–15).

| Profile      | Kernel    | Cold solid edit, run first | Cold sketch, run first | Cold sketch after the edit | Warm sketch, run first |
| ------------ | --------- | -------------------------: | ---------------------: | -------------------------: | ---------------------: |
| Desktop      | 2026.1.53 |             60.2 / 81.0 ms |           3.8 / 4.9 ms |               3.7 / 4.7 ms |           0.2 / 0.3 ms |
| Desktop      | 2026.1.57 |             61.7 / 71.3 ms |           3.8 / 4.5 ms |               3.7 / 5.0 ms |           0.2 / 0.3 ms |
| Mobile-class | 2026.1.53 |               300 / 399 ms |         17.9 / 24.6 ms |             21.0 / 27.3 ms |           1.0 / 1.5 ms |
| Mobile-class | 2026.1.57 |               286 / 393 ms |         19.2 / 25.9 ms |             20.3 / 28.1 ms |           1.1 / 1.8 ms |

A sketch run first costs the same as one run after the edit: the edit does
not compile the solver's path, so the earlier rounds did not understate the
cold sketch. Alternating the order in one profile was chosen over a separate
browser profile per workload because it measures both orders on the same
samples at half the cost, and it shows directly whether order matters.

The second call of the same edit takes 4.6–7.2 ms on desktop and 21–22 ms on
the mobile-class profile, so about 90% of a cold first edit is compilation and
first touch: 56–87 ms on desktop and 245–281 ms (p50) on the mobile-class
profile. After a warm load, Chromium's code cache supplies the compiled
functions and the overhead falls to 2–3 ms and 6–9 ms. The sketch solver pays
3.6–5.6 ms and 18–20 ms cold (see the third round below for the order). Within a round the two kernels agree: desktop
medians within 0.6 ms, mobile-class medians 1 ms apart in round 2 and 20 ms
in round 1, inside that profile's round-to-round spread. The 1.07 MB removed
by Remus #1029 and #1031 did not measurably change first-operation cost on
this workload. Between rounds
the desktop cold edit moved from 61 to 94 ms as host load rose, which is why
these are review budgets.

First-operation review budgets (`KERNEL_FIRST_OPERATION_POLICY`), set like the
load budgets from the worst p95 above plus max(25 ms, 5%), rounded up to
10 ms. Sketch budgets use only the samples where the sketch ran first (third
round):

| Profile      |      Cold solid edit | Warm solid edit | Cold sketch solve | Warm sketch solve |
| ------------ | -------------------: | --------------: | ----------------: | ----------------: |
| Desktop      | 130 ms (worst 100.2) |    40 ms (10.5) |       30 ms (4.9) |       30 ms (0.3) |
| Mobile-class |       630 ms (594.6) |    80 ms (53.6) |      60 ms (25.9) |       30 ms (1.8) |

`pnpm perf:remus-wasm -- --profile <desktop|mobile> --first-operation --check --runs 40`
reports them as review lines, like the load budgets (`--check` with
`--first-operation` needs at least 40 runs, 20 per workload order). Compilation scales with
the code a first operation reaches, not with the whole module, so a ceiling
raise moves these budgets only when the added code sits on the first edit's
path. That is what the review checks.

**5. Gating and splitting considered.**

- **Lazy modules (Remus W4).** Each candidate's bindings were removed from a
  default build to measure the most it could take out of the core, before the
  lazy module's own copy of shared code is counted:

  | Candidate                                       | Core raw | Core gzip |
  | ----------------------------------------------- | -------: | --------: |
  | Sketch solver only (sketch state stays in core) | −254 KiB | −64,182 B |
  | All sketch and 2D polygon bindings              | −316 KiB | −88,064 B |
  | Directional curve projection                    | −216 KiB | −78,238 B |
  | Import repair (heal, analysis, NURBS reuse)     | −175 KiB | −63,887 B |
  | Read-only analysis                              |  −81 KiB | −28,874 B |
  | NURBS reuse                                     |  −67 KiB | −26,705 B |
  | Heal                                            |  −18 KiB |  −5,127 B |

  None clears the 250 KiB net bar. The sketch-solver module alone is 315,601
  raw bytes, more than it removes from the core, and its round trip costs
  5–10% per small solve, which the no-speed-regression rule forbids. Removing
  every sketch binding is not a split: the editor needs them.

- **One dispatch path (Remus W3.1).** Removing `executeBatch` entirely saves
  at most 157 KB raw (29,320 bytes gzip), the ceiling for unifying the direct
  and batch paths.
- **Smaller optimization level.** Whole-graph `opt-level = "s"` would cut 17%
  raw and 447 KB gzip but makes steady-state workloads 18–70% slower, so it
  was rejected (esaueng/remus#1028). No per-crate mix saves bytes at equal
  speed.
- **Name section and features.** The shipped module has no name section
  (code is 96.5% of it). The file-format translators are already a lazy
  module ([ADR-023](adrs/ADR-023-remus-translator-module.md)) and the kernel
  is built with `--no-default-features`.

**6. Why the code stays in the initial kernel.** The Remus tier rule puts in
the core anything that edits the live modeling session (handles, journal and
evolution, persistent naming, checkpoints, transactions) and the modeling
operations the first edit needs (primitives, booleans, blends, sweeps, direct
edit, tessellation, measurement). The growth above is of that kind; moving it
out would need arena-document round trips that lose handle identity and
history continuity. Sketch state stays in core by owner decision, so undo and
restore stay atomic with body history. The document-in/document-out
candidates are the item 5 list; none pays for itself yet, and new Remus
capabilities now declare their tier before implementation.

**7. Raw, gzip and Brotli reviewed separately.** At the historical growth of
about 0.5 MB raw and 0.175 MB gzip per week (Brotli about 0.124 MB), from the
2026.1.56 kernel:

| Control             |           Headroom (bytes) | Runway        | Kind     |
| ------------------- | -------------------------: | ------------- | -------- |
| Mobile load review  | about 276,000–324,000 gzip | 1.6–1.9 weeks | Review   |
| Raw review 11 MiB   |                  1,052,800 | 2.1 weeks     | Review   |
| Raw hard 12 MiB     |                  2,101,376 | 4.2 weeks     | **Hard** |
| Brotli review 3 MiB |                    550,666 | 4.4 weeks     | Review   |
| Gzip hard 4.5 MiB   |                  1,044,739 | 6.0 weeks     | Hard     |

The raw hard limit binds first, at about four weeks. Step 1 therefore buys
time for the Remus size reductions (W3) and lazy modules (W4), not room for
unreviewed growth. The next raise (16 MiB raw / 6 MiB gzip) stays deferred and
needs the same evidence.

## Ceiling change 2026-11 (step 2)

Approved by the owner on 2026-11-04 as step 2 of the Remus browser-kernel
size plan (Remus `docs/design/kernel-wasm-size-architecture.md`, workstream
W7). The plan had deferred this step until the H4/H5 capabilities land; the
owner approved it early. It is paired with the identical change in Remus
`scripts/wasm-size-policy.mjs`. Like step 1 it is a separate change, not part
of a pin update, and it leaves the per-pin growth review (256 KiB or 3%) and
the load-time budgets unchanged.

| Control         | Before                    | After                     |
| --------------- | ------------------------- | ------------------------- |
| Raw review      | 11 MiB (11,534,336 bytes) | 15 MiB (15,728,640 bytes) |
| Raw hard limit  | 12 MiB (12,582,912 bytes) | 16 MiB (16,777,216 bytes) |
| Gzip hard limit | 4.5 MiB (4,718,592 bytes) | 6 MiB (6,291,456 bytes)   |
| Brotli review   | 3 MiB (3,145,728 bytes)   | 4 MiB (4,194,304 bytes)   |
| Per-pin growth  | 256 KiB or 3%             | 256 KiB or 3% (unchanged) |

W7 named only the hard limits. The review limits keep step 1's spacing: raw
review 1 MiB below the hard limit, Brotli review at two thirds of the gzip
hard limit.

The kernel measured is Remus main's committed `remus-wasm` 2026.1.116:
12,088,063 raw / 4,531,152 gzip / 3,240,072 Brotli bytes, 187,440 bytes under
the step 1 gzip hard limit. It was growing about 0.8 MB raw and 0.32 MB gzip
per week. The seven items of
[Raising the hard ceiling](#raising-the-hard-ceiling) follow.

**1. Toolchains.** Unchanged from step 1: Rust 1.96.0, `wasm-bindgen`
0.2.126, `wasm-pack` 0.15.0 (Binaryen version_117), and Node `zlib` for both
compressed measurements.

**2. Optimized against `--skip-opt`.** The attribution build of Remus
`84bf696` measured 15,802,150 bytes as the cargo artifact and 12,053,275 raw
/ 4,526,738 gzip / 3,238,707 Brotli bytes after wasm-bindgen 0.2.126 and
`wasm-opt -Oz --enable-simd`. That build used Binaryen version_123, not
version_117, and is within 0.3% of the committed package.

**3. Attribution.** Remus
`docs/performance/evidence/kernel-size-attribution-2026-11-04/` attributes
the six days from 2026.1.86 to `84bf696`: +1,079,070 raw / +447,433 gzip
bytes. Gears and threads (P-Class gear and thread work) account for about
330 KB, and blends, chamfers and blend edits for about 530 KB. Almost all of
it is new single-caller feature code, not duplication.

**4. Load measurements.** `measure-remus-wasm-load.mjs --package`, 20
alternated samples, kernel-ready only, comparing 2026.1.116 with 2026.1.58 (the
package the load budgets were set from), on a Linux container slower than the
2026-10-13 baseline host:

| Profile           | 2026.1.58 p50 / p95 | 2026.1.116 p50 / p95 | Review budget |
| ----------------- | ------------------: | -------------------: | ------------: |
| Desktop cold      |    129.6 / 163.4 ms |     156.7 / 177.4 ms |        110 ms |
| Desktop warm      |     98.8 / 115.7 ms |     126.1 / 147.8 ms |        110 ms |
| Mobile-class cold |    3,773 / 3,972 ms |     4,782 / 4,908 ms |      3,800 ms |
| Mobile-class warm |        463 / 709 ms |       625 / 1,515 ms |        150 ms |

**The load-time budgets are not green.** On this host even 2026.1.58 exceeds
the desktop budgets, so the desktop rows show relative growth only (+21% cold
p50). The mobile-class cold result is transfer-bound and so less dependent on
the host. It exceeds its budget by about 1.1 s at p95 and grew 27% at p50
since step 1. The rule above lets a ceiling rise only while these budgets
stay green; **this raise is an explicit owner exception to that rule.** At
about 89 ms per additional 100 KB of gzip, filling the new 6 MiB gzip ceiling
would add roughly 1.5 s more to mobile-class cold load.

**5. Alternatives considered.** Remus closed its remaining std-sort
duplication (−22,281 raw / −8,409 gzip bytes); no larger duplication remains.
The lazy-module review is unchanged from step 1, except that gear and thread
construction (about 330 KB) is a new candidate for a lazy module. It is not
yet split.

**6. Why the code stays in the initial kernel.** Thread cutting, teeth on an
existing cylinder, and the blend and chamfer growth edit live session bodies
and their construction history, so they belong in the core under the Remus
tier rule. Standalone gear construction creates a new body and could move to
a lazy module that returns an arena document; that has not been done.

**7. Raw, gzip and Brotli reviewed separately.** Runway from 2026.1.116 at the
2026-10-13 to 2026-11-04 average growth (804 KB raw, 319 KB gzip, 229 KB
Brotli per week):

| Control             | Headroom (bytes) | Runway    | Kind     |
| ------------------- | ---------------: | --------- | -------- |
| Mobile load review  |         exceeded | —         | Review   |
| Brotli review 4 MiB |          954,232 | 4.2 weeks | Review   |
| Raw review 15 MiB   |        3,640,577 | 4.5 weeks | Review   |
| Gzip hard 6 MiB     |        1,760,304 | 5.5 weeks | **Hard** |
| Raw hard 16 MiB     |        4,689,153 | 5.8 weeks | Hard     |

The gzip hard limit binds first, at about five and a half weeks. Unless
growth slows or capabilities move to lazy modules, the next ceiling review
comes in early to mid December 2026.
