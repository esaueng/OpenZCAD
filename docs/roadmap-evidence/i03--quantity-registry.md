---
row: I03
---

Stored-unit conversion phase 1: a machine-checked quantity registry
(`packages/shared/src/quantity-registry.ts`) classifies every numeric and
`ParamValue` field of every feature kind (direct edits included), sketch
object, sketch constraint, the sketch node and a parameter's expression;
an unclassified numeric field fails `pnpm typecheck`.
`rewriteNodeExpressions` is now derived from it, characterized against the
hand-written visitor, and a runtime test classifies every numeric leaf of
the parity documents and fixtures (`test/quantity-registry.test.ts`, PR #1955).
