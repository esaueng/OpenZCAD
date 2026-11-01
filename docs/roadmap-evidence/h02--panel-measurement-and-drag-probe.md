---
row: H02
---

A short local drag profile identified PanelFrame's natural-height effect as a
source of repeated synchronous layout reads when its reporting callback changed.
The observer now keeps its subscription and forwards real size changes to the
latest callback. Hosts without ResizeObserver retain render-driven measurement.
`PanelFrame.test.tsx` proves callback-only rerenders do not remeasure or recreate
the observer, while genuine resize notifications and unmount cleanup still work.

The face-drag diagnostic now releases the native pointer at the requested drag
position and requires an accepted revision plus an authoritative ready frame.
It captures through release, handles reuse of already installed exact geometry,
and reports proxy-frame latency separately from exact geometry latency. The
summary has regression tests for both distinctions. A short isolated copy of a
local working model exercised 48 proxy frames and a completed edit; private
geometry and traces remain outside the repository.

A validated commit also exposes its geometry trace while its background worker
echo is pending. `reload-face-offset.spec.ts` holds that echo and checks the ready
frame for the actual committed revision after the first permitted drag.

This is a bounded layout optimization and diagnostic correction. It does not
complete the sustained-session, quiet-host, whole-worker-memory or detached-Text
qualification required by H02, nor establish a general latency improvement from
single local timing samples.
