---
row: W01
---

On a 500-body isolated width edit, 499 bodies retained the same picking topology
across warm rebuilds. The worker now reuses the overlap checks between topology
trees that occurred together in its last successfully packed large UTF-8 reply.
It still checks every reused tree against the current metadata and changed trees.
Seven recorded edits decoded identically across all 3,500 bodies.

In 18 fresh desktop Chromium sessions with the same modeling and I/O binaries,
each build ran 42 edits. Median Apply to matching rendered frame measured
259.2 ms on the original baseline, 214.1 ms on the parent and 209.3 ms with
this change. Worker request to response measured 140.3, 97.0 and 93.7 ms
respectively. Five of six paired sessions improved on the parent. Warm reply
preparation alone fell from 11.08 to 4.57 ms in a separate Node replay.
