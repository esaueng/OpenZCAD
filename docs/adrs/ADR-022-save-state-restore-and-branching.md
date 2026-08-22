# ADR-022: Save-state restore and branching

## Status

Accepted.

## Context

Every explicit save has written a full document into the `revisions` table
since migration 0001, and each one is named by a `ProjectCheckpoint` inside the
document. Nothing ever read those rows back: there was no list, load, restore,
or branch path in the persistence service, the API, or the client, and the
sidebar's revision list was a read-only record of moments. A user who wanted an
earlier state of a model had no way to reach it, and no way to take a variant
off one without hand-copying the current project and deleting features.

## Decision

### A save state is restored from a snapshot, never replayed

Restoring loads the stored document for a checkpoint and adopts its content.
Replaying `commandLog` up to a version is rejected: replay skips command kinds
it does not recognize (right for forward compatibility, wrong for an exact
restore), its cost grows with history length, and a stored document passes
through `normalizeDocument` on load exactly like any other, so old save states
survive schema migrations for free.

### Restore runs the timeline forward

`restoreFromSaveState` takes model content from the snapshot and keeps
`version`, `revisions`, and `checkpoints` from the current document, then
appends a revision. This is the rule `restoreHistorySnapshot` already applies
to undo, for the same reasons: `version` is a monotonic clock that
collaboration and every fenced cloud write compare against, and the checkpoint
list is the record of moments the user marked. Rewinding either would make an
old save look like an unsaved edit to an account that has moved on, and would
delete the save points made after the restored one — including the one the
restore itself creates.

The gesture is: checkpoint the current document as "Before restore" and write
it, then adopt the restored document through `CommandManager.applyDocumentEdit`
as one undoable step. The safety checkpoint is written first and deliberately:
a restore the user cannot escape is a data-loss feature, and the undo stack is
in-memory only, so the escape hatch has to be on disk.

Restore is a document-level splice rather than a replayable command. A command
carrying a whole document would be dragged through every future replay and
would dwarf the log it sits in.

### Branching is duplication aimed at an earlier point

`POST /api/projects/:id/duplicate` takes an optional `revisionId` and copies
that save state instead of the head document. The copy is a new project with a
new id and records `branchedFrom` — an additive, optional `ProjectDocument`
field carrying the source project, revision, name, and reason. Lineage is
provenance, not a link: renaming, editing, or deleting the source never touches
a branch, which is the point of branching a save state.

Merging branches is **not** part of this decision. ADR-016 holds that geometry
divergence is resolved by a person, not a merge algorithm, and both restore and
branch are single-lineage operations that need no merge.

### The device keeps save-state documents

IndexedDB gains `projectCheckpointDocuments` (schema version 9), keyed by
`[projectId, checkpointId]`, written when a save leaves the document sitting on
a new checkpoint, and bounded to `MAX_LOCAL_CHECKPOINT_DOCUMENTS` (25) per
project. Without it, restore would be the one core modelling operation that
stops working offline, in an app whose premise is that the document is
canonical in the browser. Meshes are stripped on the way in; the kernel rebuilds
them from the same history.

Retention is ordered by `documentVersion`, not `createdAt`: the version is the
project's own strictly-increasing clock, while several saves can share a
millisecond, and ties there are broken by a random checkpoint id — which would
let retention drop a newer save and keep an older one.

## Consequences

- Three retention bounds now coexist: 25 documents on the device, 50 revisions
  in the account, 100 checkpoints listed in the document. A checkpoint can
  therefore outlive every stored copy of its model, so the panel asks both
  stores which rows are openable and marks the rest "not stored" rather than
  offering a button that fails.
- Restore reads the device first and the account second, so it works offline
  for recent history and reaches further back when signed in.
- A restore does not itself write an account revision row; the restored
  document syncs through ordinary autosave, and Save marks it as history. The
  "Before restore" save point is written locally, so on a device other than the
  one that restored, the way back is the account's own earlier revisions.
- Stored bytes grow with explicit saves on the device as well as in the
  account. The bound is per project and well under the account's, and the
  checkpoint list stays complete either way.
- `branchedFrom` relies on `normalizeDocument` preserving fields it does not
  know about, which it does by construction (it spreads the document) and which
  `document-core.test.ts` now pins.
- Viewers can branch a save state into a project of their own; restoring
  requires edit access and goes through the existing lease and `canEdit` gates.
