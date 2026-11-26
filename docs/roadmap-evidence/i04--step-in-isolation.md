---
row: I04
---

STEP in isolation coverage (with I02 and U06, Remus pin `f210583e`):
`test/e2e/step-in-isolation.spec.ts` builds an invented fixture of two
unequal overlapping boxes (closed-form 1000 mm³ overlap), a plate with a
radius-5 through bore (16000 − 250π mm³), a user-hidden body, a
parameter-off body and a body whose Shell fails. An independently authored
OCCT STEP box imported while one body is isolated lands as exactly one
Objects row and History step, named by the file's product, and joins the
isolated view. The isolated STEP export then holds both bodies at the file's
placement (480 mm³ shared corner). A Move inside isolation exports placed,
Undo takes back only the Move, Exit restores the earlier visibility, and a
reload keeps the import unplaced without isolation's hiding. The isolated
bored part and then the full scope export as STEP and reimport per body with
millimetre units, bounds, closed-form volume, closure and a cylindrical bore
face on its cut axis, and the two boxes keep their overlap. Consumed
tools stay out and are not counted; hidden and parameter-off bodies stay
out and are counted as hidden. The failed body is withheld
with its reason rather than counted as hidden; isolated alone, it disables
Export STEP with that reason. A hidden body picked in Objects does not narrow
the scope. No mismatches with `apps/web/src/lib/exportScope.ts` were found.
