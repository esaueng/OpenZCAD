---
row: U03
---

13 November design review I5: a lazy chunk or the geometry worker that cannot
download offline no longer reaches "Loading interrupted" or "Load failed ·
Reload". Lazy surfaces (now every `lazy` in the app) wait for the connection
and retry in place; the geometry worker spends no respawn attempts offline
and restarts on `online`; the startup screen keeps its offline line with
Back to projects; no Reload is offered while offline, and nothing is left
behind on reconnect (`offline-startup.spec.ts`, `staleChunk.test.ts`,
`ErrorBoundary.test.tsx`, `useGeometryWorker.test.tsx`, `lazyLoaders.test.ts`).
