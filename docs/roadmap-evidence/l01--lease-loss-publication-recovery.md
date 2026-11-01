---
row: L01
---

An ordinary room publication interrupted by lease loss now rejoins the room,
reconciles its current head and obtains a fresh lease before resuming the latest
local edit. Previously the renewed lease could leave the old pending-send flag
blocking every subsequent publication. The previous room epoch is invalidated
before socket cleanup, so delayed acknowledgements and encrypted sealing results
cannot act for the replacement connection.

Named saves with owned receipts retain their existing settlement path, explicit
conflict decisions remain visible, and role revocation remains read-only. An
accepted-but-unacknowledged edit is recognized from the new room head without a
second publication. Divergent histories still pass through the room's fenced
conflict response rather than being adopted as the acknowledged base.

`useCollaborationEncrypted.test.tsx` covers plain/encrypted resume, edits made
while reconnecting, accepted and divergent heads, role changes, retired replies
and late sealing. The original hook fails both resume regressions. Existing
checkpoint/deadline/cancellation/load suites preserve durable receipt semantics;
the local-checkpoint privacy test now follows the new connection and inspects
all sockets for leaked private named-state metadata.

`collaboration-lease-recovery.spec.ts` exercises actual rendered Box edits,
Syncing to Saved after fresh acknowledgement, accepted-head deduplication,
unchanged history/body count, zero account fallback writes and clean browser
console/page errors. These are deterministic local/browser fixtures, not proof
of the historical recording's exact rejection cause or cross-device production
acceptance.
