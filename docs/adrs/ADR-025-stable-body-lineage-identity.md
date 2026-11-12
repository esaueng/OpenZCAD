# ADR-025: Stable body lineage identity

## Status

Proposed (November 2026). Nothing in the Decision section is implemented. The
fork diagnostic and creation guard under "Interim measures" are implemented
and need no schema change. `PROJECT_DOCUMENT_SCHEMA_VERSION` is unchanged.

## Context

A body's identity is tied to one state of it. A fillet, chamfer, hole, shell,
draft, solid offset, pattern, thread, add/cut extrude or boolean creates a new
result `bodyId` and consumes its input. A direct edit or an in-place Move
rewrites its target under the target's existing id. Every feature stores the
specific intermediate body it reads (`targetBodyId`, `targetBodyIds`), so a
reference names a position in one chain implicitly, through the id of the
state it read.

Several features already work around this by walking from a body to the
newest live body made from it: assembly components (`assemblyComponentBodies`),
Objects folder placements (`objectFolderPlacements`), the body name a fillet
keeps (`derivedBodyName`) and the history focus ghost. Each of these walks
`bodySourceMap` again, and each one assumes that a body has at most one live
descendant.

Nothing enforces that assumption. Two active features can consume the same
body, and both build, so two overlapping solids of one part appear. A
reported history did this: after a seam fillet failed, its input stayed live
and unconsumed, and the next five features (two offsets, a cylinder resize, a
fillet and a chamfer) were attached to that intermediate body while the failed
fillet still consumed it. Once the fillet was repaired, both chains built.
ADR-017's November 2026 amendment (a failed feature passes its input through)
prevents new forks of this kind, but forks still arise from:

- histories written before that amendment;
- collaboration merges of two edits made against the same chain tip;
- assistant patches and imported or hand-edited logs;
- inserting a feature before an existing consumer of its target (a feature
  added while History is rolled back lands at the marker; the paused consumer
  then forks on resume);
- reorders that move an in-place edit after a consumer of its target;
- the Duplicate action on a Pattern, which repeats the pattern on the same
  seed.

A fork cannot be repaired automatically. It is not clear which chain is the
part and which one is the mistake, and both may hold real work.

## Decision (proposed)

### A lineage id per part

Each body chain gets a stable **lineage id** (`LineageId`, `lin_*`), minted by
the feature that creates a body from nothing (primitive, new-body extrude,
revolve, loft, sweep, import, mirror and copy-Move results, split halves,
the copies of a pattern that does not merge). Replace-type features do not
create a lineage. They advance the one they consume:

- fillet, chamfer, hole, shell, draft, solid offset, pattern, thread,
  add/cut/intersect extrude and gear cut advance their target's lineage;
- a boolean advances its first operand's lineage and **ends** the tool
  lineages it consumes (a kept operand's lineage continues untouched);
- direct edits and in-place Moves advance their target's lineage without a
  new body id, as they do today;
- split ends its input lineage and starts one per half.

These rules are the per-kind table in `replacedInputBodyId` together with
`booleanConsumedBodyIds`. They are the same table that decides what a
suppressed or failed step passes through (ADR-017), so lineage, pass-through
and fork detection cannot disagree.

### Features read "lineage at my position"

A feature stores `targetLineageId` (and `targetLineageIds` for a boolean)
instead of an intermediate `bodyId`. The body it reads is resolved at build
time as the state of that lineage just before the feature's own position in
`featureOrder`. A feature that advances a lineage records the new state, and
the next reader of the same lineage sees it.

A fork cannot be represented. Two features that both advance one lineage are
two consecutive steps of it, in history order. Inserting a feature before an
existing consumer makes the consumer build on the inserted feature's result,
which is what the user means by insert-before. Reordering does the same.

The result `bodyId` survives as the id of one **state** of a lineage. It stays
the key for derived data (`derived.bodyRepresentations`), for the rebuild
cache and for ADR-013 lineage names, which already scope topology by the
producing feature rather than by the body.

### What maps onto the lineage

| Concern                           | Today                                                  | With lineage ids                                                                                                                                     |
| --------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Display name                      | body node name, copied forward by `derivedBodyName`    | one name per lineage                                                                                                                                 |
| Colour, visibility, isolation     | per `bodyId`; hidden ids filtered on resume (ADR-023)  | per lineage, so they survive every replace-type step                                                                                                 |
| Objects folders                   | placement per `bodyId`, inherited from the source body | placement per lineage                                                                                                                                |
| Parameter visibility toggles      | `toggle.bodyIds`, refused on consumed bodies           | lineage ids; a toggle hides the lineage's live state                                                                                                 |
| Mass properties, measurements     | per derived body                                       | per live lineage state; unchanged values                                                                                                             |
| Assembly components               | `bodyId` plus "newest live descendant" walk            | `lineageId`; the walk and its tie-break disappear                                                                                                    |
| Export (STEP/STL)                 | live, unconsumed bodies; failed branches withheld      | one solid per live lineage; a failed step withholds its lineage                                                                                      |
| Collaboration (ADR-016/019)       | merges by node id; concurrent edits on one tip fork    | concurrent consumers of one lineage serialize in `featureOrder`; nothing forks, and the result is reviewed like any other concurrent geometry change |
| Topology references (ADR-011/013) | lineage names scoped by producing feature              | unchanged                                                                                                                                            |
| Undo, replay (ADR-002/023)        | command log and exact before/after values              | unchanged; new command payloads carry lineage ids                                                                                                    |

### Migration

A schema bump (the next unclaimed number at the time of implementation,
claimed as CLAUDE.md requires) adds `lineageId` to body nodes and
`targetLineageId(s)` to feature data. Normalization derives them from the
existing consumption graph:

1. Walk `featureOrder` with the per-kind table. A body created from nothing
   gets a new lineage id. The result of a replace-type feature inherits the
   lineage of the input it replaced, the first time that input is replaced.
2. A feature's `targetLineageId` is the lineage of the body it names.
3. **Forked documents.** When a later active feature replaces, or edits in
   place, a body an earlier feature already replaced (`historyForks`), the
   later branch gets a **new** lineage id that starts from the stale state
   (a "branch lineage", recorded with its origin). Every existing branch
   keeps building exactly as before, and the user sees both lineages as
   separate parts named "<part> (branch)". Nothing is deleted or merged
   silently. A one-click "rebase branch onto the tip" action is offered and
   needs explicit confirmation, because it changes geometry.
4. Readers predating the bump keep the `bodyId` fields, which stay written
   for one compatibility window, so an older client can still replay a newer
   log. It cannot create lineage-aware edits, and ADR-017's mixed-version rule
   applies: editing requires the new client.

Derivation is deterministic, so replay, collaboration snapshots and save
states (ADR-022) all derive the same ids. Branch lineages are the only place
where migration adds meaning, and they encode what the document already
builds.

## Interim measures (implemented)

Until the schema change lands, forks are detected and new ones are refused.
Neither changes what geometry is built.

- `historyForks(document)` (document-core) lists every active feature that
  consumes or edits in place a body that an earlier active feature already
  consumed, using the same per-kind table. A manually suppressed consumer
  still counts, because its pass-through replaces the body. A rolled-back one
  does not count, and a suppressed or rolled-back later feature is never
  reported. A failed step consumes like a built one, so its result id is the
  chain tip. Two consumers whose results a later boolean combines again (the
  imported-opening recipe's subtract and intersect of one body, reassembled
  by a union) leave one body on screen and are not reported. That diamond
  is a legitimate construction, and the lineage model must keep allowing it
  as one lineage that splits and rejoins.
- The exact build loop reports each fork on the later feature as a
  `history-fork` attributed warning, for example: "Builds on an earlier state
  of “Body” that “Fillet 3” already replaced; this branches the history." It
  is listed in Diagnostics and counted with other warnings. It never refuses
  a commit (`newExactWarnings` and the other gates read `build-failed` and
  `refusal` only), so a stored forked history stays editable.
- `CommandManager.execute` and `runTransaction` refuse an edit that adds a
  fork on a feature it creates or retargets (`assertNoNewHistoryFork`). The
  check runs after the ADR-017 rollback placement, so a feature added while
  rolled back is judged at the marker, ahead of the paused consumer, and is
  accepted. `replayCommands` does not run the check, so stored logs replay
  unchanged. Assistant patches commit through `runTransaction` and are
  covered.
- Duplicate refuses a Pattern step, which would repeat the pattern on the
  same seed beside the original.

Known gaps, which the decision above closes: a reorder that moves an in-place
edit after a consumer is not refused (it is reported), and resuming a rollback
over a feature inserted before a paused consumer reports the fork rather than
rebasing the consumer.

## Consequences

- Positive: forks become unrepresentable. Insert-before and reorder become
  rebases instead of hazards, the "newest live descendant" walks are removed,
  and visibility, colour, folders and assembly placement survive every fillet.
- Positive: pass-through, export withholding and the dependency graph share
  one table with lineage advancement.
- Cost: a schema bump touching every feature kind's payload and command
  factories, plus migration tests over the parity corpus and the sample
  projects. Assistant contracts and the compact digest must learn lineage ids.
- Risk: branch lineages surface pre-existing forks as extra parts in the
  Objects list. This is honest but visible, and it needs clear copy and the
  rebase action.
- Risk: collaboration merges that used to fork now serialize two concurrent
  edits onto one chain. The second edit may then fail to resolve its
  references against the first one's result. That is a visible failure in
  place of a silent duplicate, and ADR-016's person-resolves rule applies.
- Risk: a lineage-aware client must keep writing `bodyId` during the
  compatibility window, and dropping it later is a breaking change for old
  readers.

## Rollout

1. Done: fork diagnostic, creation guard and the Duplicate refusal (this
   ADR's interim measures). They need no schema change.
2. Read-only derivation: compute lineage ids at load (not stored) and use them
   to replace the `bodySourceMap` walks in assembly, folders and naming, with
   tests that the results match today's on unforked documents.
3. A "Branched history" panel entry per fork, with _rebase onto tip_
   (confirmed, undoable) and _keep as separate part_ (which then writes a branch
   lineage).
4. The schema bump: store `lineageId` and `targetLineageId(s)`, keep writing
   `bodyId` for compatibility, and migrate forked documents to branch
   lineages.
5. Command factories, the UI pickers and the assistant contracts take lineage
   ids. Insert-before and reorder rebase consumers.
6. After the compatibility window, stop writing intermediate `bodyId`
   targets.
