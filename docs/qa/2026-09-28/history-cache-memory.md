# History-cache memory qualification, 2026-09-28

This is a paired synthetic late-edit observation for the bounded checkpoint and
kernel-recycle change. The [sampled raw rows](history-cache-memory-samples.csv)
record the process RSS, WASM linear-memory size, retained checkpoint count,
restored/replayed feature counts and individual sync time in original units.
Each history contains independent 10 mm boxes; edits alternate the last box's
width. Each run uses a fresh Node process. They are accelerated sessions, not a
mixed interactive workload or a byte-bound proof.

| Provenance                                        | Value                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| Original fixed-prefix adapter                     | OpenZCAD `06941214bb4907bcdbb848c9d5de0267f0765bbc`                |
| Sparse checkpoints with 512-replay kernel recycle | OpenZCAD `ae75a23cc2142075153bae99b7075c429755c1b0`                |
| Installed Remus package source                    | `bf46fdc0af611d480bf0830ff1da6c475d8b96c9`                         |
| Installed WASM SHA-256, same binary in every run  | `c5d8ccb26bff7cdc2ccff5c09fc0bd8ed3ccad07af1aa6cfd4d5da5926ddcdda` |
| Host                                              | Linux x86_64, Node 24.14.0                                         |

The sparse-only rows were collected from an intermediate uncommitted worktree
before recycle was added. They isolate the remaining kernel-lifetime problem;
they are not identified as the candidate source commit.

| Policy and boxes  | WASM MiB, edit 100 → last | RSS MiB, edit 100 → last | Late replay / restored | Completion                 |
| ----------------- | ------------------------: | -----------------------: | ---------------------: | -------------------------- |
| Fixed prefix, 33  |       9.9 → 56.9 at 2,000 |            231.1 → 434.1 |                 1 / 32 | Parity and disposal passed |
| Sparse only, 33   |       7.3 → 44.3 at 2,000 |            178.8 → 386.8 |                 1 / 32 | Parity and disposal passed |
| Recycled, 33      |       7.3 → 16.8 at 2,000 |            201.6 → 398.8 |                 1 / 32 | Parity and disposal passed |
| Fixed prefix, 100 |    134.2 → 1,029.2 at 800 |          464.7 → 1,275.7 |                68 / 32 | Stopped at edit 800        |
| Sparse only, 100  |     44.3 → 834.9 at 2,000 |          388.9 → 1,049.0 |                20 / 80 | Parity and disposal passed |
| Recycled, 100     |      18.9 → 21.4 at 2,000 |            374.8 → 503.2 |                20 / 80 | Parity and disposal passed |
| Recycled, 32      |      16.8 → 18.7 at 2,000 |            263.1 → 483.1 |                 4 / 28 | Parity and disposal passed |

The original 100-box run was deliberately stopped when sampled WASM memory
exceeded 1 GiB. Its last raw row is edit 800; there is **no final fresh-rebuild
parity or disposal observation** for that run. The sparse-only 100-box run
completed and demonstrates that sparse snapshots alone did not bound lifetime
arena growth. In the recycled 100-box run, WASM size was 21.4 MiB at edits
600, 800, 1,000, 1,500 and 2,000; RSS ranged from 499.5 to 503.2 MiB over
those samples. At 33 and 32 boxes, WASM size also flattened, while RSS kept
rising after the WASM plateau. The recycle policy therefore has evidence for
bounded **observed WASM growth in these sessions**, not a strict byte cap or
a general process-RSS plateau.

For each completed 2,000-edit run, the final cached derived-state hash matched
a fresh adapter rebuild. The comparison excludes only root `updatedAt` and
mesh vertex/index layout, and includes warnings, geometry, topology and
references. Completed runs reported zero retained checkpoints and zero
accounted measurement buffers after disposal. WASM linear-memory high water
does not shrink on disposal. A source regression test additionally checks the
recycle boundary, export, stale returned buffers, and undo/redo. Sampled sync
times in the CSV are individual operations rather than a latency distribution;
recycle rebuilds may cause unsampled spikes.

The reproducible harness invocation from the repository root is:

```sh
HISTORY_MODE=recycled HISTORY_COUNTS=100 HISTORY_SESSION=2000 \
  HISTORY_OUT=/tmp/openzcad-history-memory/candidate-100 \
  node --expose-gc node_modules/vitest/vitest.mjs run \
  --config test/perf/history-cache.config.ts
```

The 32- and 33-box candidate sessions used the corresponding `HISTORY_COUNTS`
and output directories. The baseline adapter was loaded by
`HISTORY_MODE=baseline HISTORY_BASELINE_ROOT=<checkout at 06941214>` using
the same installed WASM package. The CSV contains only selected raw session
rows; the harness itself logs every hundredth edit and the final ten edits.
