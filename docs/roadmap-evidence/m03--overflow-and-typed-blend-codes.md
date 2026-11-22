---
row: M03
---

2026-11-22 overflow handling and typed reasons.

The variable-blend refusal path now knows every current Remus `blend_failure_code` (`packages/kernel-adapter/src/exact-variable-blends.ts`). Nine codes used to fall back to `blend-failed` without the kernel's sentence, among them `postcondition-failed`, `cliff-encountered`, `unsupported-variable-boundary` and `unsupported-seam-crossing`. They now keep that sentence and a category. The table already lists `unsupported-variable-support`, which esaueng/remus#1939 introduces for curved spines, curved supports and concave edges.

An overflow, a radius that would run the band off its support face, is refused rather than rolled over onto the neighbouring face: no exact band can leave its support. It is a typed `cliff-encountered` (`invalid_input`) refusal, and its sentence carries the width the kernel measured. The adapter relays that sentence and does not parse it.

Regressions in `exact-variable-blends.test.ts`:

- every code keeps its sentence and category;
- a 1→45 fillet on the 60 mm edge of a 60 × 40 × 20 box reaches the document path as a typed `cliff-encountered` refusal whose sentence names the width.

#1789 status: fixed upstream by esaueng/remus#1809 and adopted on the 2026.1.146 pin (#1717). `builds a variable fillet on a box that carries a boss` pins it.
