---
row: K10
---

2026-11-21 re-qualification on main's Remus 2026.1.151 pin (`c81a719`, main `6a4690d`): the CI slice, full campaign and both imported-twin ledgers re-run in record mode (`K10_RECORD=1 pnpm exec vitest run test/combination-matrix.test.ts test/combination-matrix.full.test.ts`, 1,517 tests in 253 s) hold 1,243 qualified, 265 typed refusals, 0 untyped refusals, 0 wrong and 0 timeouts of 1,508 cells (CI slice 40 / 2, imported twin 4 / 1, full campaign 1,163 / 229, imported-twin R-slice 36 / 33). Every recorded state matches the committed ledgers, which the run rewrote byte-identical, so no cell moved and no regression needed a fix, a typed refusal or a new matrix pin.
