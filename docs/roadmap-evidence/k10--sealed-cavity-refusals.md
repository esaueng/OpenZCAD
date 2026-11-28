---
row: K10
---

Sealed internal cavities (#2383–#2386) on the `2026.1.173` pin: an exact
Subtract or Intersect that keeps a sealed cylindrical cavity whole, or cuts
one into a body that already has a cavity, and every Split and Draft of a
body with an inner shell, still refuse in the kernel, and now refuse with the
typed cause `sealed_cavity` and a sentence naming the cavity in place of
"repositioning the overlap", "does not support this combination of shapes"
and "try a smaller angle or fewer faces". A modeling refusal records the
cause where the kernel names the body's cavity shells; a boolean records it
only where the refused pair builds once the cavities are filled, a rerun on
scratch copies on the failure path. `test/sealed-cavity-operations.test.ts`
pins each issue's fixture through the document with its typed record and
sentence, the controls and the orders that build (split or draft first, then
cut the cavity) at closed-form volume, bounds and one STEP
`BREP_WITH_VOIDS`, and a STEP round trip of the cavity body;
`packages/kernel-adapter/src/sealed-cavity-refusal.test.ts` pins the kernel
outcomes with the body each should build, so a pin that builds one fails
there. Kernel cause, for the Remus follow-up: `builder_solid::perform_areas`
reads a signed volume of zero for a shell of a cylinder wall and two round
caps and files the cavity as an outer piece; `split.rs` and `draft.rs` refuse
any inner shell outright.
