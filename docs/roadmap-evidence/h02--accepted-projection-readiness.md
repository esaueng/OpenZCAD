---
row: H02
---

Live geometry readiness now requires the matching completed projection to have
been accepted on the main thread, as well as a non-stale ready worker status.
A worker can report ready while its completed projection is still in transit;
that flag alone previously promoted staged frames to ready before analysis was
installed. Accepted local commits retain their separate displayed-result proof.

`useGeometryWorker.test.tsx` covers early ready status followed by an accepted
projection; existing positive fixtures now deliver a real broadcast result.
The worker and demand suites run in routine web unit CI. Staged-load browser
fixtures import uncached documents to exercise incomplete restoration directly.
The smoke case allows the worker's ready status through while withholding its completed
projection, and verifies pending frames, refused selection, no early ready
witness, and ready acceptance without reinstalling the mesh after release.
Reload-offset coverage separately verifies the validated-commit exception.

This closes an early readiness/reporting gap. Sustained latency, whole-worker
retention, detached-Text and original live collaboration-outage qualification
remain open.
