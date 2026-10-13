# Remus browser WASM size policy

OpenZCAD uses a staged size policy for the lazy Remus WebAssembly kernel. The
limits are product controls, not browser, Vite, Cloudflare, or WebAssembly
platform limits. All values use binary units: MiB and KiB, not decimal MB and
kB.

## Current thresholds

| Control            |                         Threshold | CI behavior                           |
| ------------------ | --------------------------------: | ------------------------------------- |
| Raw review         |           9 MiB (9,437,184 bytes) | Warning; mandatory kernel-size review |
| Raw hard limit     |         10 MiB (10,485,760 bytes) | Failure above the limit               |
| Gzip hard limit    |         3.5 MiB (3,670,016 bytes) | Failure above the limit               |
| Brotli review      |         2.5 MiB (2,621,440 bytes) | Warning; mandatory kernel-size review |
| Per-pin raw growth | More than 256 KiB or more than 3% | Mandatory kernel-size review          |

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
`__wbindgen_start`, and the first `new BrepKernel()`. The wasm-bindgen glue is
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
  operation, which the operation harnesses measure.

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
