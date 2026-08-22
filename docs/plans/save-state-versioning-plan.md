# Save-state versioning and branching plan

**Status: implemented.** M1–M3 and the interactive history rows of M4 shipped
together; [ADR-022](../adrs/ADR-022-save-state-restore-and-branching.md)
records the decisions as built. What this plan proposed and the implementation
did not take up is listed under "Not built" at the end.

Goal: let a user revert a project to a previous save state, and branch a new
project off any save state — "git for CAD", scoped to what OpenZCAD's
architecture already supports.

## What already exists (and what this plan reuses)

The repository is closer to this feature than it looks. The plan deliberately
builds on six existing pieces instead of inventing a parallel history system:

1. **Immutable documents + replayable history.** `ProjectDocument`
   (`packages/shared/src/index.ts:1350`) is an immutable value with a full
   `commandLog`; every operation deep-clones (`packages/document-core`).
   A "commit" can therefore be a plain document snapshot.
2. **Checkpoints and revision records.** `ProjectCheckpoint` and
   `RevisionRecord` (`packages/shared/src/index.ts:1242-1268`) already record
   *when* saves happened (bounded to 100/500), and Ctrl/Cmd+S already creates
   an explicit checkpoint. They are metadata only — no content.
3. **A durable server-side snapshot table that nothing reads.** Every explicit
   checkpoint inserts a full document into D1/R2 `revisions`
   (`apps/web/migrations/0001`, `0009`–`0011`), pruned to
   `MAX_PROJECT_REVISIONS = 50` with byte accounting. `grep "FROM revisions"`
   finds only pruning and accounting: there is no list, load, restore, or
   branch path anywhere — no `PersistenceService` method, no route, no UI.
   This is the core gap.
4. **Content identity.** `canonicalProjectContentKey`
   (`apps/web/src/worker/exactRebuildCache.ts:41`) is a stable content hash of
   a model state, and R2 project objects are already gzip'd and
   sha256-addressed.
5. **A working duplicate-project flow** (API `POST /api/projects/:id/duplicate`,
   `duplicateProjectDocument`, StartScreen button) — the natural skeleton for
   "branch from here".
6. **A read-only revision timeline UI.** `Sidebar.tsx:677-702` already renders
   `doc.checkpoints` with `revisions.css`; rows have no behavior yet.

Constraints inherited from accepted ADRs:

- ADR-002: the document + feature history are canonical; derived meshes are
  disposable. Restoring a snapshot must go through `normalizeDocument` and a
  full exact rebuild, never through stored meshes.
- ADR-016: divergence is resolved by a person, not a merge algorithm.
  **Branch *merge* is explicitly out of scope for this plan.** Branching
  (copy-from-state) and reverting (restore-state) are both single-lineage
  operations that need no merge, so they fit inside ADR-016 as written.
- ADR-017: timeline rollback (`rollbackSuppressed`) is the in-document way to
  visit an earlier *feature* state. This plan is about earlier *save* states;
  the two compose but do not replace each other.
- Undo/redo design: `restoreHistorySnapshot` never rewinds the durable
  timeline — undo is recorded as a new forward revision. Revert must follow
  the same rule: **restoring an old save is a forward edit**, so it is itself
  undoable and never destroys later history.

## Product shape

Three user-visible capabilities, in dependency order:

1. **History panel.** The existing Revisions sidebar section becomes
   interactive: each save state shows its name/reason, relative time, and a
   menu with **Preview**, **Restore**, and **Branch to new project**. Users
   can name a checkpoint when saving (the `reason` field already exists
   end-to-end) and rename it later.
2. **Restore (revert).** Loads the selected save state's document and applies
   it as one undoable forward edit ("Restored 'before fillet pass'").
   Nothing after it is deleted — the timeline keeps going forward, and the
   pre-restore state is itself checkpointed first so restore is always
   escapable even past the undo depth.
3. **Branch.** Creates a *new project* whose starting content is the selected
   save state, named like duplicates today ("Bracket (copy)" →
   user-renameable), with recorded lineage (`branchedFrom: {projectId,
   revisionId}`) so the start screen can show "branched from Bracket" and a
   future history-graph UI has real edges to draw.

Preview is read-only: the snapshot document is loaded into the workspace
behind a banner ("Viewing save from Tue 14:02 — Restore · Branch · Close")
with editing commands disabled; the exact rebuild worker already keys on
canonical content, so previewing is just another rebuild request.

## Design decisions

### Snapshots, not command replay

A save state's content is stored and restored as a full document snapshot,
not reconstructed by replaying `commandLog` up to a version. Reasons: replay
skips unknown command kinds (fine for forward compatibility, wrong for
byte-exact restore), replay cost scales with history length, and snapshots
flow through `normalizeDocument` on load exactly like any other stored
document, so old saves survive schema migrations for free. `commandLog`
remains what it is today — replay/debug material — and is stored inside each
snapshot as part of the document.

### Local-first storage: a new IndexedDB checkpoint store

Today the cloud keeps checkpoint content but the browser does not, which
would make revert an online-only feature and violate local-first. Add one
object store to `openzcad-v2` (schema version 8 → 9 in
`apps/web/src/lib/localProjectSchema.ts`):

```
projectCheckpointDocuments
  keyPath: ['projectId', 'checkpointId']
  value:   { projectId, checkpointId, revisionId, documentVersion,
             createdAt, reason, contentKey, document }  // document without `derived`
  index:   by projectId
```

- Written inside the same transaction as `saveLocalProject` whenever a new
  checkpoint appears in `document.checkpoints` (i.e. on explicit save and on
  the restore-safety checkpoint).
- `contentKey` is `canonicalProjectContentKey(document)`; identical content
  under consecutive checkpoints stores one row (dedup like R2 already does).
- Bounded: keep content for the newest `MAX_LOCAL_CHECKPOINT_DOCUMENTS`
  (proposed 25) checkpoints per project; older checkpoints stay listed from
  metadata and fall back to the cloud read path when their local content has
  been pruned. Deleting/purging a project deletes its rows (extend
  `purgeExpiredLocalProjects` and the delete paths in `localProjectStore.ts`).
- `derived` is stripped (`withoutDerivedProjection`) so rows stay within
  document-size norms; thumbnails per checkpoint are a non-goal.

### Cloud read path: make `revisions` reachable

Extend `PersistenceService` (`packages/persistence/src/index.ts`) — and both
implementations, `InMemoryPersistenceService` and `D1R2PersistenceService` —
with:

```ts
listRevisions(userId, projectId): Promise<ListRevisionsResponse>;   // metadata only
loadRevision(userId, projectId, revisionId): Promise<ProjectDocument | null>;
```

Worker routes (`apps/web/worker/index.ts`):

- `GET /api/projects/:id/revisions` — id, reason, createdAt, author,
  documentVersion, byte size. Read access (viewers may look and branch to
  their own copy; only editors restore).
- `GET /api/projects/:id/revisions/:revisionId` — the stored document,
  resolved through `document_object_id` → R2 (with checksum verify) exactly
  like `loadProject`, then `normalizeDocument`.

`loadRevision` reuses the existing R2 asset-reference restore so old
snapshots containing STEP/mesh references rehydrate correctly.

### Restore semantics (document-core)

New `restoreFromSaveState(current, snapshot)` in `packages/document-core`:

1. Start from the snapshot's canonical content (nodes, orders, assets,
   commandLog — everything a user thinks of as "the model").
2. Preserve from `current`: `version` (then advance), `revisions`,
   `checkpoints`, `projectId`, `ownerUserId` — the same fields
   `restoreHistorySnapshot` preserves for undo, for the same reason: the
   durable timeline only moves forward.
3. Append a revision + checkpoint "Restored '<reason>' (<date>)".

The App-level flow: flush pending autosave → create safety checkpoint
"Before restore" → run the restore as one `CommandManager` gesture (undoable)
→ full exact rebuild → normal local autosave + cloud autosave/CAS pick it up.
In a live collaboration room this is an ordinary versioned edit broadcast; the
existing lease and `canEdit` gates apply unchanged.

Restore is *not* modeled as a replayable `SerializedCommand` carrying the full
snapshot (it would bloat `commandLog` and every future replay). Instead it is
a document-level splice like `normalize()` already is, recorded in the
revision log — precedent: `CommandManager.normalize()` persists without a
history entry; restore persists *with* an undo entry via the snapshot stacks.
Replaying a commandLog across a restore boundary is already impossible today
(the log is inside the snapshot); nothing regresses.

### Branch semantics

Client/API: extend the existing duplicate flow rather than adding a parallel
one — `POST /api/projects/:id/duplicate` gains an optional
`{ revisionId?: string }`; `duplicateProject` in both persistence
implementations loads that revision's document instead of the head document,
then proceeds identically (new `proj_` id via `duplicateProjectDocument`, new
name via `duplicateProjectName`). Offline: the local checkpoint store feeds
the same `duplicateProjectDocument` path App.tsx already uses as its offline
duplicate fallback.

Lineage: add an optional additive field to `ProjectDocument`:

```ts
branchedFrom?: { projectId: ProjectId; revisionId: RevisionId;
                 checkpointReason: string; branchedAt: string };
```

Additive per the `normalizeDocument` convention (older clients preserve
unknown fields through JSON round-trip; verify this in tests — if the
normalizer strips unknown keys, this is the one place needing a schema-version
bump). Lineage is provenance, not a live link: deleting or editing the source
project never touches branches.

### Explicitly out of scope

- **Merging branches.** ADR-016 rejects automatic geometry merges; the
  collaboration room's `mergeCollaborationDocuments` stays where it is. If
  merge UX is ever wanted, it is a person-driven feature-transplant flow and
  its own ADR.
- **A commit DAG / graph visualization.** `branchedFrom` records the only
  edges that exist (linear history + branch points), which is enough for a
  later graph without storing one now.
- **Per-checkpoint thumbnails, diffing two save states.** Nice follow-ups;
  nothing in this design blocks them (content keys make diff detection cheap).
- **Auto-checkpoint cadence changes.** Autosave stays out of history
  (ADR-016: "revision history stays a record of moments a user chose to
  mark").

## Milestones

Each milestone passes the full gate (`pnpm lint`, `typecheck`, `test`,
`test:parity-corpus`, `build`, Playwright shards) and is shippable alone.

**M1 — Read paths.** `listRevisions`/`loadRevision` on `PersistenceService`,
both adapters, worker routes + validation; IndexedDB v9 checkpoint-document
store with write-on-checkpoint, dedup, pruning, and delete/purge coverage.
Tests: `test/persistence.test.ts`, `test/cloudflare-adapters.test.ts`,
`test/api-routes.test.ts`, new `test/local-checkpoint-store.test.ts`
(including a v8→v9 upgrade case).

**M2 — Restore.** `restoreFromSaveState` in document-core; App handler with
safety checkpoint, undo integration, rebuild, collaboration broadcast;
Sidebar rows gain Restore (+ confirm dialog). Tests:
`test/document-core.test.ts` (restore preserves timeline/ids, undoability),
`test/document-retention.test.ts` (checkpoint caps), a collaboration
room test for restore-as-versioned-edit, Playwright: edit → save → edit →
restore → verify geometry + undo.

**M3 — Branch.** `revisionId` on duplicate (API, adapters, offline path),
`branchedFrom` lineage, StartScreen lineage badge, Sidebar "Branch to new
project". Tests: duplicate-from-revision in both adapters, offline branch
from local checkpoint, lineage survives sync/adoption
(`test/project-adoption.test.ts`), Playwright branch flow.

**M4 — History panel polish.** Checkpoint naming at save time (extend the
Ctrl/Cmd+S flow and command palette entry), rename, Preview mode with banner
and disabled editing, cloud-fallback fetch for pruned local content, empty/
offline states. New CSS classes must satisfy
`test/css-class-coverage.test.ts`. The `apple-silicon` WKWebView smoke
(`apps/desktop/e2e/cad-smoke.mjs`) needs a look here: the history panel adds
sidebar interactions that only that job exercises on desktop.

**ADR.** Ship `docs/adrs/ADR-022-save-state-restore-and-branching.md` with M1
recording: snapshots-not-replay, forward-only restore, branch-without-merge,
and the local checkpoint store bounds.

## Risks and open questions

- **Storage growth.** 25 local snapshot documents per project of up to a few
  MB each is the main new cost. Mitigations already in the design: `derived`
  stripped, content-key dedup, per-project cap, cloud fallback. If beta
  telemetry shows pressure, drop the cap — the metadata list stays complete.
- **Retention mismatch.** Cloud keeps 50 revisions, document metadata lists
  100 checkpoints, local content keeps 25. The history panel must show
  per-row availability honestly ("content no longer stored") instead of
  failing on click.
- **`normalizeDocument` vs unknown fields.** `branchedFrom` assumes additive
  fields survive normalization; verify early (M1) and bump the schema version
  if not.
- **Shared projects.** Restore by an editor rewrites shared content — the
  confirm dialog must say so. Viewers get Preview and Branch only. The lease
  and 409/CAS paths already cover the race mechanics.
- **Device-only projects with no cloud account** rely entirely on the local
  store; the 25-snapshot cap is their whole history depth. Called out in the
  ADR as an accepted beta bound.

## Not built

Deliberately left for later, none of it blocking the feature:

- **Preview mode.** Opening a save state read-only behind a banner before
  deciding. Restore is one Undo away and writes a "Before restore" save point
  first, which covers the same need at a fraction of the surface.
- **Naming a checkpoint at save time, and renaming it later.** Saves still
  carry their automatic reasons ("Manual save", "Restored …", "Before
  restore").
- **Content-key dedup of stored save states.** It would cost a full
  canonicalization of the document on the save path; `createCheckpoint` already
  collapses consecutive checkpoints at the same version, and each stored row is
  written once.
- **A Playwright walkthrough of restore and branch.** The flows are covered by
  unit, worker-route and happy-dom store tests; the browser suite has no
  save-state spec yet.
- **Per-checkpoint thumbnails, and diffing two save states.** Nothing in the
  shipped design blocks either.
