---
row: L11
---

ADR-024 cross-client comparison (8-C5a): the encrypted store computes the
full 40-digit project state code from the verified saved version hash,
document version and signing member's identity fingerprint. Account reads,
new projects, saves, incoming room heads and acknowledged own room writes
retain that code. Historical reads do not replace the current code. The
crypto-free status store transfers it to the top-bar project information
and sharing dialog, with outside-channel comparison guidance; locked keys,
integrity refusals and key-session teardown hide it. An older asynchronous
completion cannot restore it after teardown. Plaintext projects show none.
Navigation invalidates pending reports for the project that closed, including
late integrity errors. Reopening offline cannot expose a code resurrected by
an older request; a fresh successful verification restores it normally.
Room reports also require the retained project when they start. Disposed
rooms skip queued decoding before and after codec loading, covering frames
whose callbacks only begin after navigation and a codec download that ends
after navigation. Explicit account loads may still prepare the next project.
Comparison digests complete before advancing accepted-head pins. Local head
publication is monotonic, so a delayed older room read or an earlier successful
account save cannot replace a newer accepted document/code. Deterministic
real-Worker races pause the older digest until a newer room head is installed;
both reproduce the prior rollback and retain the newer state after the fix.

Real Worker/SQLite coverage compares the same head across owner, editor,
incoming room and cold D4 reads, including an editor-signed head and a later
historical read. Rendered status/dialog tests cover the full code and lock,
failure and teardown transitions; the browser encrypted-project journey
checks all eight five-digit groups in the top bar and the identical code
in sharing. This remains a manual comparison mechanism, without automatic
gossip or a transparency log. Production activation and plaintext-pipeline
deletion remain held for written outside-review clearance; macOS
verification remains deferred.
