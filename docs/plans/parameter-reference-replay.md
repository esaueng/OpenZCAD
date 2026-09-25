# Parameter replay through native holes and direct edits

Roadmap: **K05**, with warning/refusal behavior under **U02**. This is a
bounded implementation of ADR-013 and the direct-edit reliability plan.

## Failure and second-review finding

A clean saved history can still fail its next parameter edit: a native hole
previously discarded upstream semantic references, and downstream offsets,
bore resizes and rounds retained dimension-dependent geometric hashes. A
parameter changes those hashes even when the selected face's construction
role remains valid. Reproduction must use the current frozen kernel pin;
a failure on an older checkout is not evidence that the current baseline is
broken.

There is a separate warning-attribution defect. Persisted derived projections
omit structured feature warnings. Comparing a fresh structured candidate to
that projection treats an unchanged existing failure as new. Comparing only
text would also be unsafe: two distinct features can have identical names
and diagnostics.

## Reference proof and repair

- Native holes publish uniquely measured bore, counterbore, shoulder and
  blind-floor construction roles. Existing faces carry only through a unique
  unchanged witness or a unique plane/cylinder carrier with changed trims.
  Source hashes, witnesses and identity uniqueness are checked afresh.
- Planar offsets use the existing journaled move-faces path and verified
  source-to-result face relation. Geometry still passes the existing solid
  validity and analytic-surface preservation gates.
- Bore resize carries verified faces and the uniquely constructed new bore.
  For a successful bounded widening cutter, an incident unique shoulder can
  move to that cutter's exact cap plane. Full-body fallback cutters do not
  claim that relation. This retains the legacy cutter extension and resulting
  shoulder depth; it does not silently change the feature's geometry.
- Rounds and chamfers retain verified analytic supports alongside existing
  modifier evolution. A single edge between two distinct, verified named
  faces can carry a boundary role. The role includes both producing-feature
  identities. Repeated boundaries, seams, split carriers and conflicting
  names do not acquire guessed identities.
- A successful rebuild emits session-only repair advice for legacy picks
  while their original hashes still resolve uniquely. The web app applies
  eligible face and edge upgrades in one normalization transaction before
  editing, including Tweak. Existing references are never overwritten;
  stale picks and partially failed histories are not upgraded. Normalization
  persists without adding an undo step. View/read-only permissions still
  prevent writes.
- Warning-bearing baselines missing attribution are rebuilt before parameter
  or AI candidate comparison. The comparison remains feature-identity-aware
  and occurrence-counted; failure to rebuild does not excuse a candidate.

No schema bump, kernel update, dependency addition, tolerance change or
nearest-face matching is introduced. Unsupported topology still refuses.
A legacy history whose original picks already fail cannot be repaired by this
normalization and requires explicit feature reselection.

## Evidence

- `test/stepped-bore-parameter-replay.test.ts`: synthetic native hole → offset
  → bore resize → four rounds; each of eight edits matches a freshly authored
  exact shape; normalization preserves geometry; cold JSON replay, undo/redo,
  STEP export, invalid edits and stale-pick refusal.
- `exact-operation-lineage.test.ts`: ambiguous source/result carriers,
  forged references, duplicated identities, repeated boundaries and seams.
- `exactWarnings.test.ts`: restored attribution, identical diagnostics on
  different features, repeated failures and failed baseline rebuilds.
- `parameter-lineage-repair.spec.ts`: reopen a synthetic legacy project
  directly in Tweak, persist automatic repairs, edit all eight parameters,
  refuse an invalid edit, recover and reopen the saved result.
- Existing exact-kernel and parity fault injections target journaled offsets
  and retain the same last-valid-body and export assertions. Corpus baselines
  change only reference coverage/names for imported fillet/chamfer outputs;
  geometry, topology hashes and round-trip quantities remain pinned.

User-owned project data and investigation probes stay outside the public
repository. Public regression geometry is independently authored.
