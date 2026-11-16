---
row: K10
---

Remus 2026.1.144 (`2639d65`, PR #1636): both K10 suites re-run in verify
mode on main's new pin pass 1,517/1,517 at 0 wrong / 0 untyped (CI slice
39 qualified / 3 typed refusals, imported twin 4 / 1; full campaign
1080 / 312, imported twin R-slice 31 / 38). 1.142 (#1793) builds 123 box ×
sphere and box × torus cells it used to refuse, all now qualified. On
1.142/1.143 alone, 22 of them read the box ∩ sphere cap's volume low
through the chorded mesh route (a hemisphere 2094.2648 against 2094.3951),
which esaueng/remus#1803 integrates exactly. Two sliver source-shrink cells
that intersect to nothing are typed refusals through PR #1620. The box ∪
sphere and cylinder ∩ sphere tests assert the exact closed-form volumes
(`union-connectivity.test.ts`, `boolean-evolution-geometry-invariant.test.ts`).
