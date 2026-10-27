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

Real Worker/SQLite coverage compares the same head across owner, editor,
incoming room and cold D4 reads, including an editor-signed head and a later
historical read. Rendered status/dialog tests cover the full code and lock,
failure and teardown transitions; the browser encrypted-project journey
checks all eight five-digit groups in the top bar and the identical code
in sharing. This remains a manual comparison mechanism, without automatic
gossip or a transparency log. Production activation and plaintext-pipeline
deletion remain held for written outside-review clearance; macOS
verification remains deferred.
