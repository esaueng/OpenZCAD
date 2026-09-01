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
   environment.
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
