---
row: H02
---

Edit phase timing now retains only project/revision identifiers and the scalar
metrics supplied by the caller. Worker sync and projection handlers pass full
documents/results as structurally typed revisions; spreading those objects into
User Timing detail copied model and mesh payloads on the main thread and retained
them in timing entries. A short Chrome trace of an isolated working-model copy
identified this copying in the selection/commit path. Private inputs and traces
remain outside the repository.

`editTrace.test.ts` uses native User Timing to verify that timing never reads
document payloads, excludes worker packets while retaining scalar metrics, keeps
bounded phase evidence and ignores revisions without an intent. It runs in the
routine web unit CI selection.
`reload-face-offset.spec.ts` checks scalar timing entries in the browser after a
cached reload and native offset gesture, including the ready-frame witness.

This removes one observed source of blocking work and retained model data.
Sustained-session, quiet-host, whole-worker-memory and detached-Text qualification
remain open; a short diagnostic does not establish general latency improvement.
