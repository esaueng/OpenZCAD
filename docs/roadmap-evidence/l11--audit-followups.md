---
row: L11
---

ADR-024 audit follow-ups retain the off-by-default rollout and production
deployment hold. The Commit sequencer packs predicate inputs into one JSON
bind while preserving every session, owner/member, epoch, device-list, Add,
membership and proposal predicate in its atomic write. Tests exercise 16 role
changes plus 16 drops under D1's 100-bind ceiling and a stale-member race.
Invitation quota is charged only after a guarded insert in the same batch;
concurrent duplicate and final-quota-slot tests preserve refusal and limits.

Device-list verification validates malformed/sparse entries as `E2eeError`
and captures signed bytes before asynchronous verification. MLS admission
uses shared checked-arithmetic replay budgets in native Rust and rejects
oversized JS byte arrays before native copies. Record arrays are borrowed
and counted before glue marshalling; two-million-entry and sparse-array
regressions pin bounded allocation on every admission entry. Raw-WASM memory checks and
the scenario matrix retain Welcome rollback and provisional-rejoin retry.
The sender-check override is absent from the public session and refused by
the production protocol; malicious-sender tests use an explicit test Worker.
The committed package is regenerated with the pinned toolchain and manifest.
Cross-host reproduction also fixes two environment-dependent inputs: a
Git-built CLI's producer suffix and installed rust-src paths. The build
requires the exact crates.io CLI version string and normalizes standard
library paths, with executable build-boundary regressions and the existing
byte-for-byte reproduction check retained.

Checkpoint tests drive a real MLS group through 257 epochs, check the
production manifest boundary at 255/256/257 and authenticate a suffix from
the resulting checkpoint. A separate application Commit tests refresh after
owner-device revocation. Signed v2-to-v1 link-set downgrades are refused on
pinned, room and supplied-history reads without advancing pins. Staggered
SelfRemove tests require a complete member drop or an explicit contention
error. Crypto entry exports and exact canary-email near misses are pinned.

Crypto/MLS specifications now describe v2 formats, authority manifests,
cutoffs and caller-verification contracts. Recovery explains first-sight
device-list freshness; desktop documentation distinguishes software Keychain
keys and a renderer sign/derive capability from Secure Enclave or per-use
consent. Raw MLS transfer limits, cutoff-head freshness and global freeze-bit
visibility are explicit. Real Keychain ACL/signed-host qualification remains
in the existing manual macOS workflow; browser and Linux checks do not prove
those platform properties. No production flag, migration, dependency pin,
merge protection or automatic deployment authorization changes.

Isolated staging also exposed retained-save identity drift: encryption gives
snapshots new signed versions, so migration now remaps checkpoint versions
from the verified staged journal, including interruption/resume. Backup export
uses the canonical saved version when its plaintext cache is stale. Migration
and backup regressions preserve strict identity validation and saved geometry.
