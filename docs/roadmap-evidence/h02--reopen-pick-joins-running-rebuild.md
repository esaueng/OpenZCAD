---
row: H02
---

Reopen: picking a face on the saved projection while a reopened project is
still replaying its history no longer supersedes that rebuild. The pick adds
lineage demand; when the adapter's boolean-probe decisions (and so the
rebuild result key) are unchanged, the newer broadcast joins the running
build instead of cancelling it at the next feature boundary and replaying
again from the last history checkpoint. A pick that does need a probe, or a
newer version, still supersedes it (`apps/web/src/worker/geometryWorkerDemand.test.ts`).
Local measurement on a 32-feature native part (Linux, Chromium with
hardware GL) finds reload to first editable state about 6.7–7.0 s either
way, because checkpoints usually limit the restart to the in-flight feature;
one software-GL run lost about 3 s to the restart. The remaining reload cost
is the full exact history replay; persisting kernel state needs a
whole-kernel snapshot (topology, journal, handle namespace) that the pinned
Remus does not expose.
