# CAD-001: booleans refused on a cup bored on its centre line

Production QA finding CAD-001 (P2), 2026-10-11, production `a90f51ad` with
Remus 2026.1.45 (`a04b5c86`). Re-verified on the `c2cd99d0` pin in `main`.
ROADMAP [K01](../../../ROADMAP.md#k01) (secondary: K07).

The report below records the earlier defect. The 13 October installed-WASM
follow-up at the end qualifies the reduced cases on Remus 2026.1.53.

## Report

A rectangular mounting ear overlapping the wall of a shelled gearbox housing
would not **Union** with it. The housing had a fused bearing boss and a
Ø20 through-bore. The refusal persisted:

- for the patterned ears;
- for a single unpatterned ear;
- with the ear's base raised from Z=0 to Z=1.

Earlier boss fusion and simple block/cylinder booleans passed. The original
bodies and history were preserved; no approximate body was substituted.

## Reproduction

Rebuilding the saved project headlessly through `createExactKernelAdapter`
reproduces the refusal exactly:

> Union refused: "Mounting ear 1" could not be combined exactly, and an
> approximate result was declined.

The kernel's refusal is `exact_only_unattainable` (`quality_refused`). The
adapter is reporting the kernel's verdict faithfully.

## Reduction

Most of the housing turned out to be irrelevant:

| Variant                                                           | Union   |
| ----------------------------------------------------------------- | ------- |
| Plain box, or shell only (ear at Z = 0/±1/2/3, flush, wall-only)  | fuses   |
| Shell + boss, no bore                                             | fuses   |
| Shell + boss + **through** bore (Ø20 or Ø10), any overlapping ear | refused |
| Same with a 6 mm **blind** bore                                   | fuses   |

Neither the pattern, the Z=0 coplanarity, nor the boss matters. It reproduces
with raw `makeBox` / `makeCylinder` / `cutDetailed` / `fuseDetailed` calls,
with no `shell` needed:

```ts
const T = (x, y, z) =>
  new Float64Array([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1]);
const k = new RemusKernel();
const box = (x, y, z, dx, dy, dz) =>
  k.copyAndTransformSolid(k.makeBox(dx, dy, dz), T(x, y, z));
const cyl = (x, y, z, r, h) =>
  k.copyAndTransformSolid(k.makeCylinder(r, h), T(x, y, z));

const cup = k.cutDetailed(
  box(0, 0, 0, 20, 20, 10),
  box(2, 2, 2, 16, 16, 10)
).value; // 1952 mm³, valid
const bored = k.cutDetailed(cup, cyl(10, 10, -1, 3, 4)).value; // 1895.4513, validates clean
k.classifyPoint(bored, 0.5, 8, 5, 1e-7); // 'inside' (correct)

k.fuseDetailed(bored, box(-3, 5, 3, 4, 6, 4));
// ACTUAL: error exact_only_unattainable / quality_refused
// EXPECTED: ok, 17 faces, 1967.4513 mm³
// cutDetailed and intersectDetailed with the same tool are refused too.

k.fuseDetailed(cup, box(-3, 5, 3, 4, 6, 4)); // control: ok, 2024 mm³
k.fuseDetailed(
  k.cutDetailed(cup, cyl(5, 5, -1, 3, 4)).value,
  box(-3, 5, 3, 4, 6, 4)
); // control, off-axis hole: ok

k.fuseDetailed(bored, box(0.5, 5, 3, 1, 6, 4));
// ACTUAL: status ok, 18 faces, 1919.4513 mm³ — a silent wrong result
// EXPECTED: 1895.4513 mm³; a tool wholly inside the wall changes nothing
```

`test/cup-bore-boolean-refusal.test.ts` pins this as a kernel canary.

## Cause

The cause was traced with `setLogLevel('trace')` on remus-wasm.

**Misclassification.** In the failing fuse, `classify_sub_faces` labels the
tool's sub-faces lying inside the cup wall `Outside` at every probe point,
for example (0.5, 8, 3) and (0.5, 11, 5). The same geometry without the bore
classifies the same points `Inside`.

**Invalid result.** BuilderSolid then keeps 22 faces instead of 16, with:

- non-manifold edges;
- a wrong Euler characteristic;
- inner wires wound like their outer wire.

The GFA rejects the result ("GFA result not accepted … falling back"), and
exact-only refuses the fallback.

**Public classifiers are correct.** `classifyPoint`, `classifyPointRobust` and
`classifyPointWinding` all answer correctly; the defect is internal to the
GFA classifier.

**Trigger,** measured on 20×20×H cups: the vertical line through the
bounding-box centre lies in the open cavity and passes through a cylindrical
through-hole. It passes when the bore moves off that line by more than its
radius (r 0.5: x 10.4 fails, 10.6 passes). It also passes when the bore is
blind or square, or when the floor top reaches H/2. The housing matches
exactly: its bounding-box centre (50, 35, 20) sits above the bore at
(50, 35).

**Hypothesis,** not verified without Remus source: the classifier's
reference ray or point is the bounding-box centre, and it counts an untrimmed
cylinder hit.

## Consumer status

- **Fail-closed.** Through the adapter, union, subtract and intersect with an
  ear crossing the wall all refuse. So do subtract and intersect with a tool
  wholly inside the wall.
- **Silent `ok` caught, misleadingly worded.** The union with a tool inside
  the wall gets the kernel's silent `ok`. The union connectivity gate refuses
  it, but its message ("Union does not fill empty space … 2 disconnected
  groups") blames the user's placement, although the bodies overlap.
- **No exact consumer rescue.** Moving both operands moves the bounding-box
  centre with them, and swapping operands also fails. A plane split followed
  by a re-fuse would be exact but heuristic, so it is not adopted. The
  exact-only refusal stays.
- **User workaround (exact,** verified at kernel level): union the ears before
  cutting the bore. Shell + boss, then four ears fused one at a time, then the
  bore gives 69 300.318 mm³, which equals 60 876.318 + 4 × 2 106.

## Upstream

Filed as [remus#984](https://github.com/esaueng/remus/issues/984), with both
behaviours: the exact refusal of a valid boolean, and the `ok` with a wrong
volume.

## Installed-WASM follow-up — 13 October 2026

The updater PR #651 pins both packages to Remus **2026.1.53**, commit
`957201b87155fb3cbeee98104ad4e433d7247611`, containing the upstream
[remus#986](https://github.com/esaueng/remus/pull/986) classifier repair.
The reduced consumer regression now requires success rather than accepting a
refusal, and the raw-kernel canary requires the exact answers:

- Crossing-wall union: `1952 - 18π + 72 = 1967.451332235384 mm³`, 17 faces.
- Contained-wall union: `1952 - 18π = 1895.451332235384 mm³`, with the same
  face count as the bored cup; the tool adds no material.
- Both raw results have matching mass-property volumes, validate with zero
  errors, and tessellate watertight with zero boundary/non-manifold edges.
- Serialized input operands remain unchanged, the protruding ear is material,
  and the through-bore remains empty. The no-bore control remains exact.

All four tests in `test/cup-bore-boolean-refusal.test.ts` pass locally against
the installed packages. These are synthetic raw-WASM and adapter results;
the original saved housing was not rerun through the production UI. Full PR
CI, the actual merge and public deployment remain separate delivery evidence.
