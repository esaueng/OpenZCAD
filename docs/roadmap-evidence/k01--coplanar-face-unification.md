---
row: K01
---

Coplanar boolean walls use orientation-aware Remus face unification, including
retained and absorbed hole boundaries. See the
[source fix](https://github.com/esaueng/remus/pull/1500) and
[paired packages](https://github.com/esaueng/remus/pull/1503). The consumer regression in
`packages/kernel-adapter/src/union-unify-gate.test.ts` builds a cut plate with
two added uprights and requires one face on each flat inner wall, analytic
volume, strict solid validity, and a closed display mesh; it runs in the required
CI smoke selection. Local private saved
history replay preserves volume and downstream fillets/direct edits while
removing the redundant planar boundaries; the fixture stays outside the
repository. Local Edge verification covers import, standard-view changes,
and reload with the full renderer. This is bounded face-unification evidence,
not closure of the remaining K01 families.
