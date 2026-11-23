---
row: K10
---

CAD part QA P2 adds a seeded direct-edit chain generator and its fixed-seed
PR slice to root Vitest (`test/direct-edit-corpus/chains.test.ts`, ledger
`chains.ledger.json`): three seeds × 20 steps on each of parts A–D, 12
chains and 240 steps. Steps offset planar faces, resize blends and
cylinders, edit an earlier step's value, undo (with or without redo) and
reopen from the saved form at step 10, so later undos cross the reopen. Each
build passes strict STEP solid validation and a closed, consistently
oriented mesh check. Each refusal must be typed, specific and pinned by its
literal sentence and owner in `CHAIN_REFUSAL_PINS`, and must leave history
and geometry unchanged. Each resize must apply its radius, and each earlier-value
edit must change the body unless a later resize supersedes it. Undo, redo,
reopen and the end-of-chain cold replay match the incremental body exactly
(volume, bounding box, census, and every face's centre and area), and the end-of-chain STEP round trip
keeps volume and face census. All 12 chains qualify: 168 builds, 42 pinned
refusals, 18 undos (8 with redo) and 15 earlier-value edits. The pins cover
nine refusal classes. Eight are owned by K10, including the design limit
probes, part A's chamfer-plane offsets and the D/wall chamfer carry. The
`reference_missing` re-pick, raised when an earlier edit removes a later
edit's face (O4), is owned by K05. Two consecutive runs produced identical
step lists and volumes. The file took 63 s on a shared 32-core workstation
at load average 26–38: 50 s for part A's chains and 11 s for B–D together.
It took 128 s at load average 60–90. It is not yet measured on a CI runner.
`K10_SHRINK=1` enables a
chain shrinker through `LedgerRunner.shrink`. It drops steps and rounds
values only while the failure signature (oracle, refusal category and code,
or wrong-result check) stays the same. Each refusal is pinned at its own
step, so one occurrence that starts building fails the pin check.
