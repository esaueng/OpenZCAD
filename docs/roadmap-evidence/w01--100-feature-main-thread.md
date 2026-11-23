---
row: W01
---

100-feature isolated edit, main-thread presentation: stage lane metrics no
longer restyle the model panels. Chromium traces of the `w01-history` probe
(`test/e2e/perf-cad-edit.spec.ts`, 100 features, isolated part) showed the
time after the worker reply was mostly native style and layout. The cost was
not the viewer's scene update: the install effect's JavaScript was about 2 ms.
It was a forced layout in a commit effect (`TopBar` `fitProjectName` in the
installed → frame window, `useRovingToolbar` `checkVisibility` in the install
window), paying for one cheap-looking write. When the edit card closes,
`WorkspaceReadout` writes `--workspace-guidance-h` on `.viewer-area`. Custom
properties inherit, so any custom-property write there restyled and re-laid
out all of the roughly 3,400 nodes below it, including every History and
Objects row. On the idle 100-feature page, one write cost 38–79 ms of
style + layout on the measuring host, even for an unused property. A small
DOM change cost 0.2 ms. `.model-panel` now redeclares the stage's lane metrics
`initial`. Nothing in a panel reads them, so a write stops at the panel frame.
In the same run, a `--workspace-guidance-h` write took 37.6 ms without the
redeclaration and 5.5 ms with it. Only the listed metrics are isolated: a
property outside the list still reaches every panel row. `test/stage-metric-isolation.test.ts`
derives the properties written on the viewer area from source, plus every
property the stylesheets derive from them, and fails when the panel frame
misses one or a panel rule reads one (mutation-checked).
`test/e2e/stage-metric-isolation.spec.ts` checks in Chromium that the lanes
still read the published values and panel rows read none. Host-local timing,
not RX 6600: an AMD Ryzen 9 5900XT host with an RTX 3090 (ANGLE Vulkan,
headless Chromium 156), heavily loaded by other jobs (1-minute load 69–108
on 32 threads), so absolute numbers run well above the 2026-11-15 RX 6600
baseline. Three interleaved rounds of 30 edits, before → after, from the same
commit with only this change: installed → next frame median 79 / 73 / 74 →
48 / 39 / 38 ms, and input → frame median 319 / 245 / 245 → 304 / 218 /
197 ms. Worker reply and install stages matched within noise per round. The
RX 6600 budget (100 ms median) has not been re-measured: that needs
`node scripts/measure-active1-baselines.mjs --only w01-history` on that
machine. Remaining main-thread work after the worker reply, from the same
traces: React render and commit of the edit (about 24 ms here) and the
`useRovingToolbar` forced layout in the install window (about 17 ms).
