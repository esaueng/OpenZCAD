---
row: W01
---

2026-11-12 kernel compile/warm-up characterization
([performance baseline](docs/performance-baseline.md#kernel-compile-and-warm-up-on-the-first-rebuild-2026-11-12-w01)):
on a 32-feature filleted part, TurboFan-precompiling the whole kernel leaves
the first Node rebuild at 5.8 s against 3.1 s for a second adapter, so
compilation explains at most ~1 s; the rest is per-WASM-instance kernel
state. Chromium deserializes its WASM code cache on reload (kernel ready
~70 ms after worker start), so compile cost remains only on a first visit or
after a kernel-changing deploy. Hovering or focusing a library project tile or
demo card now asks the geometry worker to load the kernel (`prepare-kernel`;
once per worker, skipped under Save-Data), and `measure-startup.mjs --backup`
opens a private backup for startup probes (`geometryWorker.test.ts`,
`useGeometryWorker.test.tsx`, `StartScreen.test.tsx`).
