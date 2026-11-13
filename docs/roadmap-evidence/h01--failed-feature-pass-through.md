---
row: H01
---

A failed feature now passes its input body through like a manual suppression
(ADR-017 November 2026 amendment): only the failed step reports failure, its
dependents build on its unchanged input and are flagged "after failed step" in
History, reference repairs are withheld downstream, and commit gates still
refuse the breaking edit. Synthetic coverage:
`test/failed-feature-pass-through.test.ts`,
`packages/kernel-adapter/src/exact-suppression.test.ts`. Local-private
evidence: replaying the reported fillet-radius history at r 3 mm, failures
fell from 20 to 14 and "target is unavailable" from 9 to 0.
