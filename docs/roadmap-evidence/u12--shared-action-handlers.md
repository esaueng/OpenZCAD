---
row: U12
---

Slice 1, second step: one handler per action (`apps/web/src/lib/actions/handlers.ts`), keyed by registry id. The seven standard views, Measure, Fit, grid, display mode, projection, X-ray, orbit mode, the slash, the shortcut reference and Settings run one entry from both their keyboard shortcut and their command-bar row, where each had two identical closures in `App.tsx`. `handlers.test.ts` checks the map is keyed by registered actions, the keyboard map calls the entry and keeps no second copy, and each row runs its own action's entry. No behaviour change.
