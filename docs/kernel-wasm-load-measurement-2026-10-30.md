# Remus kernel load measurement, 2026-10-30

This appendix to [the kernel WASM size policy](kernel-wasm-size-policy.md#load-time-budget)
checks the 2026-10-13 load-time budgets against today's kernel. It changes no budget, threshold
or pin.

## Kernels

The pinned kernel and the current Remus `main` kernel are the same module, so "pinned" and
"main" below are one data point. To fit a size slope on one host, the 2026-10-13 baseline
kernel (2026.1.53) was measured again beside it.

| Kernel                                                                    |        Raw bytes | Gzip bytes (`gzipSync` default) |  Brotli q11 bytes | Size policy |
| ------------------------------------------------------------------------- | ---------------: | ------------------------------: | ----------------: | ----------- |
| 2026.1.86, OpenZCAD pin (Remus `d8195032a8`)                              |       11,005,504 |                       4,083,667 |         2,907,310 | pass        |
| 2026.1.86, Remus `main` (`c91287d6e9`, package tree identical to the pin) |       11,005,504 |                       4,083,667 |         2,907,310 | pass        |
| 2026.1.53, 2026-10-13 baseline (Remus `877e2e4`)                          |       10,406,201 |                       3,643,759 |         2,573,020 | pass        |
| Delta, 2026.1.53 → 2026.1.86                                              | +599,303 (+5.8%) |               +439,908 (+12.1%) | +334,290 (+13.0%) | —           |

Both WASM files have SHA-256 `87255d11…4db1dc5b`. The size column is `measureKernelWasm` and
`evaluateKernelWasm` from `scripts/bundle-size-policy.mjs`: no review warning and no failure
(raw 11,005,504 is under the 11 MiB review line by 528,832 bytes; Brotli is under 3 MiB review
by 238,418). Measured against 2026.1.53 as one step, `evaluateKernelPinGrowth` reports raw growth over
256 KiB and over 3%.

## Method

- `node scripts/measure-remus-wasm-load.mjs --package <pkg> --profile <desktop|mobile>
--runs 20 --kernel-ready-only --check`, plus `--baseline-package <pkg>` for the interleaved
  runs. The script was used unchanged. Each run is 20 cold and 20 warm samples.
- All three kernels were measured as `--package` directories taken from the Remus commits above
  (`crates/wasm/pkg`). There was no `pnpm build`, so `--dist` was not used. The served asset is
  the same bytes and the same gzip encoding (the transfer measured 4,083,967 bytes, of which
  4,083,667 was body), so kernel-ready is the same measurement either way.
- Host: cloud container, Intel Xeon @ 2.10 GHz, 4 logical CPUs, 16 GB, Linux 6.18. Playwright
  headless Chromium 153.0.8010.12, Node 22.22.0. Load average was 0.7–1.6 and nothing else ran
  during the runs, which were sequential, between 2026-10-29 23:35 and 2026-10-30 00:06 UTC.
- **This is not the reference host** (Apple M5 Pro) that set the budgets. Absolute desktop and
  warm times here measure this host as much as the kernel; see [Verdict](#verdict).
- Install note: `codeload.github.com` returned 403 to `pnpm install --frozen-lockfile` from
  this environment, so the measurement ran in a scratch worktree whose `remus-wasm` and
  `remus-wasm-io` specifiers pointed at local copies of the pinned packages (installed with
  `--no-frozen-lockfile`). Nothing from that worktree is committed.

## Results

Kernel-ready, ms, 20 samples per cell. "Seq." runs one kernel alone. "Int." alternates two kernels
sample by sample. Spread is the min–max of the 20 samples. **Bold** is over the review budget.

### Mobile-class (4× CPU, 9 Mbps / 1.5 Mbps, 150 ms RTT)

| Kernel    | Run                | Cold p50 | Cold p95 (budget 3,800) | Cold spread | Warm p50 | Warm p95 (budget 150) | Warm spread |
| --------- | ------------------ | -------: | ----------------------: | ----------- | -------: | --------------------: | ----------- |
| 2026.1.86 | seq.               |    4,079 |               **4,141** | 4,045–4,145 |      400 |               **545** | 363–1,329   |
| 2026.1.86 | int. vs itself (a) |    4,066 |               **4,127** | 4,051–4,133 |      391 |               **424** | 364–430     |
| 2026.1.86 | int. vs itself (b) |    4,079 |               **4,137** | 4,044–4,192 |      386 |               **430** | 325–448     |
| 2026.1.86 | int. vs 2026.1.53  |    4,071 |               **4,124** | 4,034–4,159 |      387 |               **420** | 333–422     |
| 2026.1.53 | int. vs 2026.1.86  |    3,659 |                   3,704 | 3,637–3,713 |      374 |               **431** | 331–453     |
| 2026.1.53 | seq.               |    3,672 |                   3,709 | 3,632–3,710 |      371 |               **400** | 335–417     |

### Desktop, unthrottled

| Kernel    | Run                | Cold p50 | Cold p95 (budget 110) | Cold spread | Warm p50 | Warm p95 (budget 110) | Warm spread |
| --------- | ------------------ | -------: | --------------------: | ----------- | -------: | --------------------: | ----------- |
| 2026.1.86 | seq.               |      124 |               **141** | 98–444      |      136 |               **318** | 93–444      |
| 2026.1.86 | int. vs itself (a) |      102 |               **121** | 95–125      |      103 |               **116** | 96–141      |
| 2026.1.86 | int. vs itself (b) |      101 |               **125** | 93–128      |      103 |               **126** | 94–127      |
| 2026.1.86 | int. vs 2026.1.53  |      106 |               **120** | 97–127      |      109 |               **122** | 94–133      |
| 2026.1.53 | int. vs 2026.1.86  |      100 |               **112** | 91–122      |       96 |                   110 | 88–120      |
| 2026.1.53 | seq.               |       97 |                   109 | 87–119      |      101 |               **118** | 89–122      |

The 2026.1.86 sequential desktop run was the first browser run after setup and holds a few outliers
up to 444 ms; its p95 is the least reliable figure here. The two "vs itself" runs are the noise
floor: medians agreed within 13 ms on mobile cold and within 5 ms elsewhere, and p95 values within 10 ms.

### Size slope

From the two kernels on this host: +439,908 bytes gzip (4.40 × 100 KB, decimal).

| Run         | Δ cold p50 | ms per 100 KB gzip | Δ cold p95 | ms per 100 KB gzip |
| ----------- | ---------: | -----------------: | ---------: | -----------------: |
| Interleaved |    +412 ms |               93.6 |    +420 ms |               95.5 |
| Sequential  |    +407 ms |               92.4 |    +432 ms |               98.2 |

The policy's 89 ms per 100 KB is the 9 Mbps wire rate (100,000 B × 8 / 9 Mbps = 88.9 ms). The
measured slope is 92–98 ms: 4–10% above the wire rate. The noise floor (±13 ms on the delta)
is worth about ±3 ms per 100 KB, so the excess is small but probably real. A likely cause,
not separately measured, is the throttled streaming compile of the extra 599 KB of raw module
that does not overlap the download. On desktop the same comparison gave +6.6 ms p50
(≈1.5 ms per 100 KB). That is within the desktop noise, so this host shows no measurable
desktop size cost.

## Verdict

- **Mobile cold breaches the 3,800 ms budget with today's kernel.** On this host, 2026.1.86 measured
  4,124–4,141 ms p95 in every run, while 2026.1.53 stayed at 3,704–3,709 ms. Both ran on the same
  host, with the same harness and interleaved, so the breach comes from the kernel and not the
  host. Projected to the reference host: the 2026-10-13 2026.1.53 p95 values (3,482–3,554 ms)
  plus the measured +420–432 ms give about 3,900–3,990 ms, 100–190 ms over. That is an
  estimate, not a reference-host measurement. The breach does not depend on the host: the
  4,083,967-byte transfer alone takes 3,630 ms at 9 Mbps, so one 150 ms round trip already
  reaches 3,780 ms before compile and instantiation.
- **Mobile warm (150 ms) and desktop cold/warm (110 ms) cannot be judged on this host.** The
  2026.1.53 kernel, which the reference host measured at 89–117 ms mobile warm and 47–77 ms desktop
  p95, also exceeds or touches those budgets here (mobile warm 400–431 ms, desktop 109–118 ms).
  Because the two kernels differ by less than the noise floor in those cells, this host gives no
  evidence that 2026.1.86 regressed them. A reference-host run is needed to confirm.
- 2026.1.86 passes the byte policy, including the 4.5 MiB gzip hard limit, but is over the mobile
  cold load budget. The policy lets a byte ceiling rise only while the load budgets stay
  green, so this result matters for any further ceiling change.
