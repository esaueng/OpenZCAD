# Coplanar face lookup during assembly edits

Editing one width in the deliberately overlapping 500-feature fixture took a median of 447 ms to render with the lookup cache, down from 1,732 ms on its parent. The fixture places hundreds of boxes at the same origin. The main thread repeatedly found the same neighbouring normal buckets while assigning draw order to coplanar faces.

Each mesh now retains up to 32 lists of nearby normal buckets. A change to its face topology rebuilds that index. Each query still uses the current plane offset and footprint, and tests candidates in their original order. Once the cache fills, new normal directions use the ordinary lookup.

## Matched browser measurements

Chromium 156 on Linux with an RTX 3090 and the full WebGL renderer. Each fresh browser applied seven different width edits. The 500-feature overlapping case used all six possible build orders. The isolated and spaced controls used three orders apiece. Times are pooled medians from Apply to the revision-matched rendered frame.

| Scene | Edits per build | Historical (ms) | Parent (ms) | Candidate (ms) | Speedup over parent |
| --- | ---: | ---: | ---: | ---: | ---: |
| 500-feature history, every body visible | 42 | 1,777.1 | 1,732.1 | 447.3 | 3.87× |
| Same history, isolated part | 21 | 256.5 | 213.0 | 212.6 | 1.00× |
| Edited box with 100 spaced M6 fasteners | 21 | 91.2 | 90.9 | 90.5 | 1.00× |

The historical build was `f7d89ac65` and the parent was `46c6b4dbaa`. All three builds used the same core and translator Wasm binaries. Every edit produced the expected width with zero geometry warnings. For the overlapping case, worker response to body publication fell from 1,537.8 to 255.5 ms. The worker response itself took 95.5 and 96.1 ms. All six paired session medians improved. Some sessions overlapped short local diagnostic runs.

## Reproduction

From each checkout on a hardware-rendered Linux host, run the existing Playwright edit probe. Give each run a fresh output file.

```sh
OZ_PERF=1 OZ_PERF_ANGLE=gl CAD_PERF_BROWSER_HISTORY=500 \
CAD_PERF_BROWSER_ISOLATE=0 CAD_PERF_BROWSER_SAMPLES=7 \
CAD_PERF_BROWSER_OUT=/tmp/coplanar-edit.json \
pnpm exec playwright test test/e2e/perf-cad-edit.spec.ts --workers=1
```

Use `CAD_PERF_BROWSER_ISOLATE=1` for the isolated part. For the spaced assembly, set `CAD_PERF_BROWSER_HISTORY=1`, `CAD_PERF_BROWSER_ISOLATE=0`, and `CAD_PERF_BROWSER_FASTENERS=100`.
