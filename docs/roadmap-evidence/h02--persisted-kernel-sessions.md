---
row: H02
---

Reload without replay: the geometry worker persists the history kernel as a
Remus whole-kernel session snapshot (Remus #1664) with the last feature's
build state, digests and projection signature, in its own IndexedDB database
(never in backups, downloads, account sync or shares; bounded, deleted with
its project; keyed by content and app/Remus/kernel build). A reopened project
restores it instead of replaying, publishes only after its projection matches
the captured one (exact identities and lineage, measurements within 1e-9
relative) and replays on any mismatch or refusal; an idle, cancellable
warm-up then rebuilds the ordinary checkpoint table in a second kernel
(`test/kernel-session-snapshot.test.ts`, `apps/web/src/lib/kernelSessionStore.test.ts`,
`apps/web/src/worker/kernelSessionPersistence.test.ts`,
[persisted sessions](docs/history-cache-retention.md)). Local measurement on a
32-feature filleted native part (Linux, Chromium, Vulkan RX 6600, local Remus
2026.1.134 build): reload to input-ready 1.00–1.10 s with the session versus
3.96–4.03 s replaying in the same build; Node restore plus measure pass
135–176 ms versus 1.5–4.0 s replay; 3.7 MB snapshot, 15–17 ms idle write,
about 3 s idle warm-up.
