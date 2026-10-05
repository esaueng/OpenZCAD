# ADR-017: Replay-compatible feature suppression and rollback

## Status

Accepted.

## Decision

Store suppression on each feature through the existing `BaseNode.metadata`
map and the replayable `node.metadata.set` command. The boolean `suppressed`
key represents an individual pause. The boolean `rollbackSuppressed` key
represents the current timeline rollback suffix. A feature is skipped when
either key is true.

The two keys remain separate so moving the rollback marker can resume its old
suffix without erasing an intentional individual pause. Moving the marker
writes every changed `rollbackSuppressed` key through one `runTransaction`
gesture. Resuming an individual row clears both keys on that row, which gives
the explicit per-feature control precedence over the current marker.

The browser exact rebuild reports every skipped feature through the normal
feature warning channel and emits no sketch basis for it. It emits no body
for it either, except where the October 2026 amendment below passes the
feature's input body through. Downstream unsuppressed features otherwise fail
visibly if they depend on a skipped feature. OpenZCAD now has one production
Remus build loop; the historical legacy mesh loop named in the expansion brief
no longer exists.

The compact AI digest includes each feature's effective `suppressed` state.
No schema-version bump is required because metadata and its command/replay
shape already exist.

## Consequences

- Replay, persistence, undo/redo, collaboration snapshots, and old command
  readers retain the suppression keys without learning a new command kind.
- Clients predating this ADR preserve the canonical metadata but ignore its
  build meaning, so they can temporarily project suppressed geometry. They do
  not silently delete the suppression state. Mixed-version collaboration must
  therefore require an ADR-017-capable client before relying on the projection.
- Rollback is a reversible document edit, not viewport-only visibility. It is
  one undoable transaction and one collaboration broadcast even when many
  feature metadata commands change.
- A manually suppressed source with unsuppressed dependants produces explicit
  dependant warnings, unless the amendment below gives them its input body. A
  normal rollback suppresses the whole later suffix and avoids those
  dependency failures.

## Amendment (October 2026): a suppressed feature passes its body through

Design review F1 follow-up. Suppressing the fillet of a bracket made both
holes drilled on it fail with "Hole target is unavailable", which read as the
holes being broken rather than paused around.

A **manually** suppressed feature that replaces one input body now records
itself as the identity on that body: the input's solids appear under the
feature's result body id and the input is consumed, as if the feature had run
and changed nothing. `exact-build-loop.ts` applies it at the one place
suppression is applied, through `exact-suppression.ts`, so the history cache,
measurement and display all see the same bodies. Per kind:

- Hole, shell, solid offset, draft, fillet, chamfer, pattern and add/cut
  extrude pass `targetBodyId` through (a suppressed pattern leaves its seed).
- A boolean passes its first operand through and leaves its tool operands
  unconsumed, so they are back on screen as before it ran. This differs on
  purpose from `activeWhen = 0`, a modelled configuration that also consumes
  the tools.
- Transform and direct edit already edit in place under the target's id.
- Mirror and thicken add a body and leave their input live, and split yields
  two halves; standing the input in for any of those would show material
  twice, so they pass nothing through.
- Body-creating features have no input to pass.

A rollback pause passes nothing through: every dependent is paused with it.

Pass-through supplies a body, never a reference. Dependents resolve faces and
edges through the passed body's verified lineage exactly as before (ADR-011),
so a reference to topology the suppressed feature created still refuses with
its existing message. Lineage names that a later boolean nests by operand
slot change when an upstream boolean is suppressed, so those references
refuse too; that is the honest outcome, not a regression.

While any feature is manually suppressed, the build withholds reference
repairs from the features after it: a legacy hash-only selection resolved on
a passed-through body would otherwise be rewritten to names that stop
resolving when the step is resumed. The repair is offered again on the first
build with nothing suppressed. No stored document format changes.

## Amendment (5 October 2026): preflight an individual suppression

The history action now rebuilds a suppression candidate before committing
when the feature has active dependents. The existing pass-through preserves
the input body's handles and lineage; every active dependent must still
resolve its own exact references and produce all of its result bodies.
Attached-sketch and in-place edit failures also refuse the candidate. The
refusal lists the failing dependent features and their exact reasons and
leaves metadata, command history and the current geometry intact. The
existing validated-commit lock and document-version check prevent committing
a candidate against a changed or replaced document.

Features with no active dependents, resuming and timeline rollback retain
their existing behavior. Command replay still reconstructs stored suppression
states, including older states with broken dependents; the interactive
preflight does not rewrite those states or their references. No exactness,
reference-resolution or kernel-refusal rule changes.
