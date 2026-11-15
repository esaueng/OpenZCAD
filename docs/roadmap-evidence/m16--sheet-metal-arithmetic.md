---
row: M16
state: Partial
---

Slice 1 (no schema change, no kernel change): the specification ([docs/plans/sheet-metal-plan.md](docs/plans/sheet-metal-plan.md)) and `packages/shared/src/sheet-metal.ts`: bend allowance, outside/inside setback, bend deduction, DIN 6935 K-factor, bend-zone placement for the four line positions, flat length from outside flanges, fold kinematics (neutral-fibre-preserving zone map, rigid moving-side transform, partial-fold preview radius), bent-zone volume, rule-of-thumb limits, and material and gauge presets. Evidence: `test/sheet-metal-math.test.ts` (hand-computed 90° values; a 50 × 50 outside L bracket from a 96.5239 blank at T 2, R 2, K 0.44 folds its far corners to (50, 50) outside and (48, 50) inside; continuity at both zone edges; neutral-fibre length equal to the bend allowance; down bends, diagonal bend lines and a two-bend U channel; DIN 6935 values and clamps; range refusals; gauge conversions and preset links).
