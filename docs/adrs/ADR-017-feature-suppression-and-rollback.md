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

## Amendment (November 2026): a feature added while rolled back lands at the marker

Every feature-creating mutation appends to `featureOrder`, so a feature added
while History was rolled back landed after the paused tail. The rolled-back
model looked right, because the tail builds nothing, but the marker vanished
from the timeline and resuming rebuilt the new feature after every resumed
step: a different model from the one it was made on.

`CommandManager.execute` and `runTransaction` now follow any edit that adds
an unsuppressed feature behind a `rollbackSuppressed` feature with one
`feature.reorder` per added feature, moving it to the first paused position in
the order it was added. The moves join the same recorded edit, so one undo
removes the feature and its placement, and replay and older clients reproduce
the order from the command log without learning anything new. Each move runs
the normal reorder validation; one it refuses (the new feature reads something
only the tail produces) leaves that feature at the end, as before. Edits made
with nothing rolled back are unchanged, and Duplicate keeps refusing a step
inside the paused tail.

## Amendment (November 2026): a failed feature passes its body through

A reported history changed an early seam fillet from 2 to 3 mm. A later
fillet on the same chain stopped resolving its edge and left no body under
its result id, so the fillet after it and every direct edit after that
reported "target is unavailable": 9 of the 20 failures in that rebuild. The
failed fillet's input also stayed unconsumed and on screen, and new features
were attached to it, forking the history.

A feature whose build throws now passes its input through by the same rule
and the same function as the October 2026 amendment: the kinds that pass
there pass here, a boolean passes its first operand and leaves its tools
unconsumed, mirror, thicken and split pass nothing, transform and direct edit
already leave their target in place, and body-creating features have no
input. It fails closed the same way when the input is missing or already
consumed. Before passing, `exact-build-loop.ts` restores the body containers
(shapes, consumed bodies, mesh and partial-revolve origins) it captured on
entry to that feature, so the pass-through starts from the feature never
having run; a builder that wrote part of its result before throwing leaves
nothing behind. Cancellation is still rethrown and is not a failure.

The failure is reported exactly as before: the same warning, `build-failed`
attribution, kernel refusal category and blend advice, and the History row
stays "needs repair" although a body now exists under its id. Pass-through
supplies a body, never a reference, so a dependent naming topology the
failed feature would have created (its blend, its bore) still refuses with
its existing message.

Each feature that builds downstream of a failed step, through the stored
dependency graph and across suppressed steps, says so: "after failed step" on
its History row and "Built on a failed step" in History details, naming the
earliest failed upstream step. Failed in-place transforms and direct edits,
whose dependents always built on the unedited body, are flagged the same way.
The app derives the flag from the typed failure record and the graph; it is
not a warning, so warning counts and commit gates do not change.

From the first failed feature onward the build withholds reference repairs
and hash-only edge carries from every later feature, as it does after a
manual suppression: a name learned on the passed-through body stops resolving
once the failed step is repaired. A prefix-restored build reads the earlier
failures from the restored attribution, so it withholds from the same point.
This also applies after a failed in-place edit, whose dependents previously
offered repairs.

Commit gates keep their rule: any new `build-failed` or `refusal` record
refuses the candidate, and the failure record is read before body presence,
so a passed-through body never makes a gate accept an edit that breaks a
feature. The places that took a result body's presence as proof it built
now read the failure record too: extrude operation inference, which would
otherwise accept a refused add or cut, and the count of steps a suppression
broke. Export already withholds a failed feature's inputs, its own result
and everything downstream of it; it now skips bodies that are consumed, so
it names the passed-through result rather than the input behind it.
New features target the chain tip because the failed feature's input is
consumed, which prevents the fork at its source. A history that already
forked now shows both branches, because the main chain is no longer missing.
No stored format or schema version changes.

## Amendment (November 2026): preflight resume

An edit made while History is rolled back is checked only against the
features that are building; the paused tail is skipped, so nothing judged it.
Resuming then committed the marker move unchecked. Rolling back to a fillet,
changing its radius and resuming turned twenty later features red at once,
with no chance to keep the rollback and change the edit first.

A rollback marker move that resumes features (Resume full history, or moving
the marker later) now rebuilds the candidate through the validated-commit path
before committing. It reports each resumed feature that would not rebuild:
its own refusing warning, or a result body the rebuild did not produce, the
same test the suppression preflight applies to dependents. Only resumed
features are judged; features before the old marker, and features the user
also suppressed by hand (which stay out of the build), are not. A resumed
feature that was already failing when a rollback in this session paused it is
not blamed on the resume either; after a reload that memory is gone and every
resumed failure is reported.

With no failure the move commits as before, as one transaction, with the
checked rebuild attached. With failures a dialog names each failing feature
and its reason and offers **Keep rolled back** (nothing changes) or **Resume
anyway**. Unlike a refused suppression it offers to proceed, because resuming
is how the full model comes back and the user may mean to repair the failures
in place; Resume anyway commits the same single transaction as an unchecked
resume did. The answer is valid only for the document version it was checked
against: any later edit, undo or project switch drops the dialog, and Resume
anyway on a moved document commits nothing. Resume is disabled while any exact
check runs, its own included.

Moving the marker earlier only pauses features and needs no check. Undo and
redo of a marker move, command replay and collaboration snapshots are
unchanged, so stored states with failing resumed features still load as they
are. No stored format, exactness, reference-resolution or kernel-refusal rule
changes.

## Amendment (November 2026): forked histories are reported, new forks refused

Two active features that both replace the same body fork the history: both
build, and two overlapping solids of one part are on screen. The reported
history held one such fork, five features attached to a failed fillet's
input. The failed-feature pass-through above stops new ones arising that
way, but older documents, merges, assistant patches and reorders can still
hold them. [ADR-025](ADR-025-stable-body-lineage-identity.md) proposes making
them unrepresentable; until then:

- The build reports each fork on the later feature as an attributed
  `history-fork` warning: "Builds on an earlier state of “Body” that
  “Fillet 3” already replaced; this branches the history." The detector
  (`historyForks`, document-core) reads the document only and uses the same
  per-kind table as pass-through, now `replacedInputBodyId` in document-core.
  A manually suppressed consumer counts, because its pass-through replaces
  the body. A rolled-back one does not, because it passes nothing through,
  and a suppressed or rolled-back later feature is never reported. Two
  consumers whose results a later boolean combines again leave one body and
  are not a fork (the imported-opening recipe builds exactly that). The
  warning is listed and counted in Diagnostics, but no commit gate reads it,
  so a stored fork stays editable and nothing about the geometry changes.
- `CommandManager.execute` and `runTransaction` refuse an edit that adds a
  fork on a feature it creates or retargets. The check runs after rollback
  placement, so a feature added while rolled back lands at the marker, ahead
  of the paused consumer, and is accepted; that consumer then reports the
  fork once History resumes. Resume, suppression, unrelated edits and
  `replayCommands` never run into the refusal, so stored logs load and
  replay exactly as before.
- Duplicate no longer offers Pattern: the copy patterned the same seed again
  beside the original.

No stored format or schema version changes.
