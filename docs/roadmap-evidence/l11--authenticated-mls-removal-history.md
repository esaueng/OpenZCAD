---
row: L11
---
Issue #817: Welcome joins and external rejoins derive removal cutoffs from a
complete public MLS epoch transcript, bound to the joining GroupContext,
rather than trusting an inviter's GroupInfo removal hints. Epoch records and
sealed sessions use version 2; the unused package API requires the archive
and refuses old state. Rust also refuses revoked devices without an explicit
revocation cutoff, matching TypeScript. Staged joins expose only the provisional
archive-decryption capability, keep normal operations and rejoin confirmation
blocked through sealed-state restoration, preserve provisional external state
for malformed-archive retry, and roll back verified policy rejection or discard;
external rejoins recheck the original cutoffs after decrypting the accepted
new-epoch archive. Evidence:
`packages/mls/src/{scenarios,boundary.test}.ts`, the Node and Worker-protocol
scenario runs, and the regenerated pinned WASM. Application integration and
checkpoint-based replay remain open.
