---
row: U01
---

Refusals lead with plain words (QA 2026-11-14 finding #18): the in-place
command bar runs rebuild warnings through the refusal translator, which now
recognises `Remus <operation> refused:` wrappers and kernel ids (`Some(Id(…))`,
snake_case codes, `corner 139`) and names the split, draft, solid-offset and
blend-resize refusals with a remedy; an empty Subtract says it would remove
the whole body; Technical details open in place; fillet/chamfer suggestions
refine past the first round bracket; the rebuild debug line reports each
feature's outcome (`refusalLanguage.test.ts`, `InPlaceCommandBar.test.tsx`,
`EditRefusal.test.tsx`, `exact-boolean-refusal.test.ts`,
`edge-modifier-diagnosis.test.ts`, `exact-cancellation.test.ts`).
