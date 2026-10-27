---
row: L11
---
Phase 8 share-link state is authenticated across skipped document versions.
New document prefixes commit to the canonical signed link set; readers check
owner-authorized transitions in the signed log and match the decrypted body
before accepting a head. Account and room reads use a bounded owner baseline
or an accepted pin, including overlapping log pages. The Worker bounds
log pages by a conservative byte budget as well as the record limit,
reserving frame metadata space for the head even with large blob lists.
The Worker retains the necessary ancestry beyond its usual 2,000-head window
until an owner refresh. Client verification also splits overlapping windows
by the crypto verifier's 64 MiB prefix/hash budget and 4,096-record limit.
A signed history exceeding the byte budget reproduces the former refusal
and now opens successfully through multiple windows.
Legacy byte vectors and historical reads remain supported; directly verified
legacy parents can accept unchanged editor successors. Missing proof and
format downgrades fail closed. Old builds need an update for new V2 documents.

Real-Worker regressions cover fresh/reloaded/skipped readers, room heads,
intermediate changes, missing baselines, retention, legacy transitions and
concurrent owner saves. Crypto tests cover canonical commitments, immutable
headers, malformed prefixes and mismatched bodies. Focused tests, types,
lint and the complete production build pass. This is engineering evidence,
not outside-review clearance; production activation remains off and macOS
verification is deferred.
