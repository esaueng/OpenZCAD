# Sustained-session retention (2026-11-20)

[ROADMAP](../../ROADMAP.md) [H02](../../ROADMAP.md#h02) and
[W01](../../ROADMAP.md#w01) list whole-worker heap retention over a sustained
session as open. This record measures it with the exact adapter the geometry
worker runs and records the bound that closes the leak. The mechanism is
described in
[history cache retention](../history-cache-retention.md#arena-retention-in-a-long-session).

## Method

`test/sustained-session-retention.test.ts`, long mode:

```bash
SUSTAINED_EDITS=300 SUSTAINED_OUT=sustained.jsonl \
  pnpm exec vitest run test/sustained-session-retention.test.ts
```

The public filleted union (`test/support/filleted-union.ts`: box ∪ cylinder,
an R5 five-edge junction fillet and a top-face offset) receives 300 edits:
two of every three change the top-face offset, every third the fillet radius.
Every tenth edit, and after every compaction, the run forces a Node GC and
records the sync time, the kernel's checkpoint memory stats (live and retired
arena slots, WASM linear memory, the accounted checkpoint estimate) and the
post-GC Node heap. With idle compaction on (the default), the test calls
`warmHistory` whenever `needsHistoryWarmup` reports a worn kernel, as the
worker's idle timer does. `SUSTAINED_IDLE=0` leaves it out.

Linux, Node 24.22.2, Ryzen 5 5600, Remus 2026.1.150 (main `9467000bf`). Node
heap and WASM linear memory are this process's figures, not a browser
worker's; the browser worker runs the same adapter and kernel build.

## Results

| After edit | Before: retired slots | Before: WASM memory | Before: checkpoint estimate | After: retired slots | After: WASM memory | After: checkpoint estimate |
| ---------: | --------------------: | ------------------: | --------------------------: | -------------------: | -----------------: | -------------------------: |
|         10 |                11,474 |               63 MB |                      6.2 MB |                    — |                  — |                          — |
|        100 |               114,074 |              126 MB |                     54.8 MB |                ≤ 66k |              95 MB |                    ≤ 32 MB |
|        200 |               229,966 |              192 MB |                    109.4 MB |                ≤ 66k |             102 MB |                    ≤ 32 MB |
|        299 |               342,826 |              270 MB |                    157.3 MB |               18,314 |             102 MB |                     9.2 MB |

- **Before**, nothing reclaimed retired slots: about 1,100 per edit, never
  reused, each copied into every later checkpoint. The checkpoint estimate
  passed the 128 MiB admission budget near edit 250 and the table fell from
  five checkpoints to four. The replay-work recycle (512 replayed features)
  never fired. One-feature edits slowed from about 47 to 58 ms, two-feature
  (fillet) edits from 213 to 238 ms, and the post-GC Node heap rose from
  70 to 80 MB.
- **After**, the kernel was compacted five times (at edits 56, 113, 170, 227
  and 284), each about 220 ms of idle worker time. WASM linear memory
  plateaued at 102 MB, a high-water mark that later compactions reuse rather
  than grow. Retired slots never passed 66,194, the checkpoint estimate never
  passed 32 MB and five checkpoints were kept throughout. One-feature edits
  stayed at 43–47 ms, fillet edits at 215–232 ms, and the post-GC heap at
  71.5–73.4 MB.

## Budgets and regressions

- `test/sustained-session-retention.test.ts` (root unit suite, CI): with
  small thresholds, idle compaction keeps retired slots under four times
  the threshold and publishes exactly what the worn kernel and a fresh build
  do; a session that never idles is recycled (`arena-retention`) before
  twice the recycle threshold. A worn kernel is never persisted, and the
  compacted one is.
- Long mode asserts that retired slots stay under twice the production
  recycle threshold (524,288).
- Production thresholds (`exact-history-cache.ts`): compact at 65,536
  retired slots, recycle at 262,144, both only when retired slots outnumber
  live ones four to one.

Still owner-pending: the same session in a browser worker on target
hardware, read as post-GC worker heap through CDP. The
`perf-holder-reload` probe already samples that heap, and
`scripts/measure-active1-baselines.mjs` runs the long mode here as its
`sustained` probe.
