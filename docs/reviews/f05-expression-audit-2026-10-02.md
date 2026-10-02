# F05 expression grammar audit — 2026-10-02

Audit of `evaluateExpression` (`packages/document-core/src/index.ts`) and every
production caller (`apps/web/src/lib/model.ts`, `keypad.ts`,
`parameterVisualPreview.ts`, `SketchEntityEditor.tsx`,
`packages/command-system`), against ROADMAP row F05. Executable companion:
`packages/document-core/src/expression-audit.test.ts` (one case per row below,
plus an old-vs-new parity table whose expected values are the exact output of
the pre-change evaluator extracted from git HEAD).

Status vocabulary: **supported** (worked before, bit-identical now),
**added** (threw before, works now), **refused-correctly** (throws on the
evaluator's existing `throw new Error(...)` path — no new error channel),
**needs-schema** (requires a persisted-schema change; skipped).

## Units inside expressions

| Item                                                             | Status            | Evidence                                                                                                                                      |
| ---------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `5 mm + 2 cm` = 25 (document units)                              | added             | `5 mm + 2 cm` → 25 mm; 2.5 cm; 25/25.4 inch via `{ documentUnits }`                                                                           |
| `3 in * 2`, `2 * 3 in`                                           | added             | 152.4 mm; 6 inch                                                                                                                              |
| `1 ft + 2 in`, word/long/plural spellings                        | added             | 355.6 mm; 14 inch                                                                                                                             |
| Feet/inch symbol forms `1' 2"`, `5'`, `5"` (also `′`/`″`)        | added             | juxtaposed quantities add: `1' 2"` = 14 inch; `5"` = 127 mm                                                                                   |
| Results expressed in document units                              | added             | optional 3rd arg `{ documentUnits }`; without it a length suffix is refused; parameter table, proposal scope and keypad pass `document.units` |
| Quote-led or bare-unit fragments (`"`, `'`, bare `mm`)           | refused-correctly | `Unexpected token` / `Unknown identifier`; a unit must suffix a number                                                                        |
| Parameters named like units (`m`)                                | supported         | bare `m` still resolves from scope; only the number-adjacent suffix reads as a unit (`5 m` = 5000 mm, threw before)                           |
| Unit suffix on `(expr)` or a bare parameter (`(5+2) mm`, `w mm`) | refused-correctly | suffixes attach to literals only; scope values are untyped document-unit numbers (see unit types)                                             |

## Dimensional rules

| Item                                                    | Status            | Evidence                                                                                                                                                              |
| ------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Length ± angle refused                                  | added             | `5 mm + 30deg` throws `Incompatible dimensions … cannot add length and angle.`                                                                                        |
| Length × length = area; area / length = length          | added             | `(2 mm)*(3 mm)` = 6; `/ (2 mm)` = 3                                                                                                                                   |
| Number × length = length (both orders); length / number | added             | `2 * 3 mm` = `3 mm * 2` = 6; `(2 mm)/2` = 1                                                                                                                           |
| Bare-number ± length (`5 + 3 mm`, `width + 5 mm`)       | refused-correctly | scope values carry no dimension proof; refuses until parameters are typed (needs-schema)                                                                              |
| Trig takes angles, returns numbers                      | added             | `sin(90deg)` = 1, `sin(1.5707963267948966 rad)` ≈ 1, legacy `sin(30)` = 0.5 bit-identical; `sin(5 mm)` throws `expects an angle …`                                    |
| Inverse trig returns angles (as degree numbers)         | added             | `asin(0.5)` = 30, `acos(0.5)` = 60, `atan(1)` = 45, `atan2(1, 1)` = 45; `asin(2)` throws `between -1 and 1`; `sin(asin(0.5))` = 0.5 stays composable with degree trig |

## Functions

| Item                                                                                         | Status                                                                                                       |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `sqrt abs min max round floor ceil sin cos tan pi` (+ `PI`, `require_min`, `require_one_of`) | supported (bit-identical; 47-case parity table)                                                              |
| `asin acos atan atan2`                                                                       | added (degree arguments in, degree numbers out)                                                              |
| `mod avg sign`                                                                               | added (`mod` floored, throws on zero divisor; `avg` variadic; `sign` dimensionless)                          |
| `pi()` nullary call                                                                          | added (`pi` constant supported before)                                                                       |
| Unknown functions, `sqrt` arity                                                              | refused-correctly (`Unknown function`, `expects exactly one argument`)                                       |
| `%` operator, `radians()`/`e`/`tau`, implicit multiplication (`2 (3)`)                       | refused-correctly (not requested: `mod()` covers remainder; `Unexpected character` / trailing-tokens errors) |

Scalar functions preserve dimensions (`abs(-5 mm)` = 5, `min/max/avg/mod` require
matching dimensions); new names (`asin`, `atan`, `atan2`, `mod`, `avg`, `sign`)
join `RESERVED_IDENTIFIERS` like the existing built-ins.

## Parameter unit types, cycles, refusal integrity

| Item                                                                 | Status       | Evidence                                                                                                                                                                                                      |
| -------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parameter unit types (length, angle, number) and how created         | needs-schema | `ParameterNode` carries `{ expression, value }` only — no unit field; any field creates a parameter the same untyped way (`coerceParamValue` keeps expression strings). Typing needs a schema change: skipped |
| Cycle detection                                                      | supported    | `getParameterScope` reports per-parameter errors; command-system refuses `depends on itself`; cached values keep the last good evaluation                                                                     |
| Cycle / incompatible-dimension refusals leave the prior model intact | supported    | `setParameter` never throws: the expression stores, the scope drops the member, the cached `value` keeps the prior number; tests pin `a`↔`b` cycles and `5 mm + 30deg` keeping `w` = 10                       |
| All failures stay plain thrown `Error`s                              | supported    | audit asserts `instanceof Error` across unit, dimension, domain and syntax refusals                                                                                                                           |

## Units-threading boundary (inch documents)

Callers with a document directly in scope now pass `document.units`
(document-core scope/rename/reference probes, command-system proposal scope +
all 31 preflight checks + sketch-dimension resolutions, keypad, holder
previews, sketch/interaction resolvers, kernel builders whose bodies see
`document`/`ctx.document`). Without document units (unit-free inputs behave
exactly as before; a length suffix is refused rather than read as mm):
scope-only kernel helpers (`profilePoints`,
`resolvePatternDirection`, `resolveParametricPoint`, `makeProfileFace`,
`buildPrimitive`, `resolveExtrudeSpan`, `resolveRevolveAngleDeg`,
`positiveImportedDimension` chain), `constantRigidTransform`,
`model.ts` previews, `SketchEntityEditor` (scope-only props), `App.tsx`
(off-limits; untouched), and the parity harness (must see legacy behavior).
Threading the scope-only helpers needs signature changes and is recorded
follow-up; until then a length suffix typed into one of those fields is
refused by name, so no field can silently read `5 mm` in an inch document as
millimetres. Angle suffixes and unit-free expressions work everywhere.

Edge note: zero-argument calls changed message only (still throw):
`min()` was `Unexpected token`, now fails the finite-result check;
`sin()` was `Unexpected token`, now `expects exactly one argument`.

## Out of scope

Browser acceptance with U01 is out of scope for this audit: the mixed-unit
`5 mm + 2 cm = 25 mm` walkthrough keeping expression intent, resolved units,
preview, committed geometry, undo/redo and reopen consistent still needs a
browser pass. No grammar or schema expansion beyond this audit is implied.
