# Project Cloud Sync Plan — save projects to the account, sync between devices

Status: all phases implemented. Decisions are recorded in
[ADR-016](../adrs/ADR-016-project-cloud-sync.md); the phase notes below are kept
as the record of what each one covered and why.
Scope: `apps/web` (client + worker), `packages/shared`, `packages/persistence`,
`packages/document-core`, `packages/cloudflare-adapters`
Related: [ADR-003](../adrs/ADR-003-cloudflare-storage-split.md) (D1/R2 split),
[ADR-007](../adrs/ADR-007-access-auth-and-live-rooms.md) (live rooms),
[ADR-012](../adrs/ADR-012-email-code-identity.md) (identity)

## What shipped, against what was planned

Two things came out differently from the plan above, both for the better:

- **Retention is a plain count, not "last N plus every named checkpoint".**
  Once autosave stopped writing revisions, every remaining revision was already
  a save somebody chose to make, so the second half of the rule had nothing left
  to protect.
- **Documents are stored without their derived projection**, on every write
  path rather than only the new ones. Meshes rebuild from canonical history on
  load, so a document is now refused for the size of its history rather than the
  size of its last rebuild. This was not in the plan and belongs to the size
  work.

One thing was added: a `paused` sync state, for a user who turned cloud autosave
off. It is neither offline nor conflicted, and the next step differs from both.

## Goal

A signed-in user's projects live in their account, not on one browser. Work is pushed to
the account continuously rather than only when someone remembers to press Save; opening the
same project on a second device gets the latest work; and when two devices genuinely
diverge, neither side is silently discarded.

## What already works

Most of the plumbing exists. This plan is about closing the gaps between the pieces, not
building a cloud backend.

- **Local-first autosave.** A 450 ms debounced IndexedDB write on every document change
  (`apps/web/src/App.tsx:1183`, `apps/web/src/lib/localProjectStore.ts`). This stays the
  primary save path and nothing below changes that.
- **A full project API.** list / create / load / duplicate / delete / purge, shelf-state
  patch, reorder, and `saveRevision` (`apps/web/src/lib/api.ts`,
  `apps/web/worker/index.ts:428-620`,
  `packages/cloudflare-adapters/src/index.ts:636` and `:787`).
- **Server-side version fencing.** `saveRevision` does a compare-and-set on
  `projects.document_version` and raises `RevisionConflictError` → HTTP 409
  (`packages/cloudflare-adapters/src/index.ts:787`, `apps/web/worker/index.ts:740`).
- **Shelf-state two-way reconcile.** Archive / pin / manual order is written to the device
  first and mirrored to the account, with the device authoritative and failed mirrors
  retried on the next listing (`apps/web/src/App.tsx:355`,
  `apps/web/src/lib/projectShelf.ts:16`).
- **A proven cloud-autosave pattern.** `apps/web/src/lib/cloudSettingsAutosave.ts` already
  does debounce, single-flight, revision-safe retry, offline pause/resume, flush before
  logout, and dirty-state recovery — for settings. Documents need the same controller.
- **Conflict recovery.** Recovery-copy-first resolution with use-room / keep-mine /
  save-as-copy (`apps/web/src/lib/conflictRecovery.ts`) plus the dialog that drives it.
- **A live push channel.** The `ProjectCollaborationRoom` Durable Object and its client
  (`apps/web/src/lib/useCollaboration.ts`).

## The seven gaps

1. **No cloud autosave for documents.** `handleSave()` (`apps/web/src/App.tsx:2951`) is the
   _only_ code path that writes a document to the account. Everything between two manual
   saves exists on one device only. This is the largest gap and the one users will feel.

2. **Local-only projects can never reach the account.** `CreateProjectRequest` is
   `{ name, units }` (`packages/shared/src/index.ts:1058`) and `createProject` always mints
   a fresh document server-side (`packages/cloudflare-adapters/src/index.ts:643`). There is
   no endpoint that accepts an existing document. So every project created while signed
   out — and every project created when a cloud create fell back to local
   (`apps/web/src/App.tsx:2556`) — is stranded on that device permanently. Signing in
   (`apps/web/src/App.tsx:2404`) lists the account's projects and uploads nothing.

3. **No pull side while the app is running.** Cloud state is read at startup and on explicit
   list refreshes. With sharing disabled there is no push channel either, so an edit on
   device A is invisible on device B until B reloads.

4. **Divergence outside a live room has no recovery.** A 409 from `saveRevision` becomes
   `"Cloud save failed … Saved locally."` and nothing else. The recovery-copy machinery is
   wired only to `useCollaboration`, which is gated behind `PROJECT_SHARING_ENABLED`, set
   to `"false"` in `wrangler.jsonc`.

5. **The open-time winner is picked on a wall clock.** `selectProjectDocument`
   (`apps/web/src/lib/localProjectStore.ts:181`) compares `version`, then
   `derived.updatedAt`. With no record of the last common ancestor it cannot tell "this
   device is behind" from "both devices moved", and in the second case the loser is dropped
   without a recovery copy.

6. **Size and retention are unbounded in the wrong direction.** Every revision stores a
   whole document as JSON in D1, `MAX_PERSISTED_DOCUMENT_BYTES` is 1.5 MB
   (`packages/cloudflare-adapters/src/index.ts:1377`), room frames cap at 900 KB, and
   nothing prunes the `revisions` table. Autosaving into `revisions` would multiply this
   by the edit rate.

7. **Sync state is invisible.** The start screen does not distinguish a cloud project from
   a local-only one, and the workspace shows a save state, not a sync state.

## Design decisions

### 1. Whole-document last-writer-wins with version fencing, not CRDT

The document is a replayable command history whose canonical rebuild is exact; merging two
divergent histories automatically would mean merging geometry semantics, and any wrong
merge produces a silently wrong part. Keep the existing compare-and-set on
`document_version` and make divergence an explicit user choice with a recovery copy written
first — the contract `conflictRecovery.ts` already implements. Per-command sync and
operational transform are out of scope.

### 2. Autosave writes the document; checkpoints write history

Splitting these is what makes continuous sync affordable. Autosave updates
`projects.document_json` / `document_version` only, via a new
`PUT /api/projects/:id/document`. `POST /api/projects/:id/revisions` keeps its current
meaning — an explicit, named checkpoint — and stays the manual-save path. One busy session
then costs a bounded number of D1 row updates instead of an unbounded number of full-document
inserts.

### 3. Track `lastSyncedVersion` per project on the device

A third input turns guesswork into a decision:

| local vs `lastSyncedVersion` | remote vs `lastSyncedVersion` | outcome                            |
| ---------------------------- | ----------------------------- | ---------------------------------- |
| unchanged                    | unchanged                     | in sync, nothing to do             |
| ahead                        | unchanged                     | push                               |
| unchanged                    | ahead                         | pull and hydrate                   |
| ahead                        | ahead                         | conflict — recovery copy, then ask |

This replaces the timestamp tiebreak in `selectProjectDocument` and is the prerequisite for
gaps 4 and 5. It lives beside the shelf metadata in the `projectMeta` IndexedDB store, which
is already device-owned and already excluded from document sync by design.

### 4. Personal device sync is a separate flag from sharing

The Durable Object room is the ideal push channel for a user's own devices, but sharing
carries invitations, roles, and lease enforcement that are deliberately still off. Introduce
`PROJECT_PERSONAL_SYNC_ENABLED`, gating rooms joined by the _owner only_, independent of
`PROJECT_SHARING_ENABLED`. Until it is on, Phase 3's polling is the sync channel; the room
is an upgrade, not a dependency.

### 5. Local IndexedDB stays the source of truth for the running session

Cloud writes never block the UI and never gate an edit. A failed push degrades to "saved on
this device", exactly as the settings autosave degrades today.

## Phases

### Phase 0 — ADR-016: project cloud sync

Write up decisions 1-5 as `docs/adrs/ADR-016-project-cloud-sync.md`, with the conflict
truth table and the autosave-vs-checkpoint split. Everything after this references it.

**Deliverable:** one ADR. No code.

### Phase 1 — Adopt local projects into the account

Closes gap 2. Independent of every later phase, and the one that makes "save to my cloud
profile" true at all.

- `packages/shared`: extend `CreateProjectRequest` with an optional `document?:
ProjectDocument`. Present means adoption: keep the client's `projectId` so the device's
  local copy and its shelf metadata stay linked to the account record.
- `packages/cloudflare-adapters`: in `createProject`, when a document is supplied, run it
  through `normalizeDocument`, re-stamp `ownerUserId`, and insert. Refuse when the
  `projectId` already exists — under this owner (already adopted) or another (id
  collision) — with distinguishable errors.
- `apps/web/worker/validation.ts`: schema-version guard, the existing depth/value/byte
  caps, and the `MAX_PERSISTED_DOCUMENT_BYTES` ceiling applied before the insert.
- `apps/web/src/App.tsx`: a per-project "Save to my account" action on the start screen for
  local-only projects; after `handleVerifyLoginCode` succeeds, offer to upload the local
  projects that have no account record; make the local fallback in `handleCreateProject`
  retryable rather than terminal.

**Tests:** adoption round trip (create offline → sign in → adopt → load from a second
client); re-adoption refused; adoption under a second account refused; oversize refused;
adoption while offline leaves the local project untouched and retryable.

### Phase 2 — Cloud document autosave

Closes gap 1. Depends on nothing but Phase 0.

- New `apps/web/src/lib/cloudProjectAutosave.ts`, modelled directly on
  `cloudSettingsAutosave.ts`: idle debounce (propose 3 s) with a max-wait ceiling (propose
  60 s) so a continuous drag still checkpoints, one request in flight at a time,
  `expectedVersion` carried from the last accepted write, offline pause/resume on the same
  connectivity signal, and flush on `visibilitychange`, `pagehide`, and logout.
- New `PUT /api/projects/:id/document` in `apps/web/worker/index.ts` plus
  `saveDocument` in the adapter: the same compare-and-set as `saveRevision`, without the
  `revisions` insert.
- `saveState` gains real values — `local`, `syncing`, `synced`, `offline`, `conflict` —
  replacing the current `saving` / `saved` / `offline` triple, which conflates the two
  stores.
- The local 450 ms write stays first and unconditional; the cloud controller is fed from the
  same effect.

**Tests:** debounce and max-wait timing; single-flight under rapid edits; 409 surfaces as
`conflict` and does not retry blindly; 401 ends the session cleanly; offline queues and
resumes; flush-before-unload; a manual save still writes a `revisions` row.

### Phase 3 — Pull side and cross-device freshness

Closes gap 3.

- Add `documentVersion` to `ProjectSummary` so `GET /api/projects` answers "is this device
  behind?" in one existing round trip.
- Poll on window focus, on network regain, and on a slow interval (propose 60 s) while a
  cloud project is open. Cheap: it is a version comparison, not a document fetch.
- Remote ahead and local clean → fetch and hydrate through the existing
  `hydrateDocument` path. Both moved → Phase 4.
- Optional upgrade, once `PROJECT_PERSONAL_SYNC_ENABLED` is on: join the owner's own room
  and take the push channel instead of polling. `useCollaboration` needs no protocol change
  for this — only the gate that currently ties it to `collaborationRollout.sharingEnabled`
  (`apps/web/src/App.tsx:855`).

**Tests:** poll detects a remote bump; a clean device pulls and hydrates; a dirty device does
not silently pull; polling stops when the project closes or the session ends.

### Phase 4 — Divergence outside a live room

Closes gaps 4 and 5.

- Persist `lastSyncedVersion` per project in the `projectMeta` store; a new IndexedDB
  version bump in `localProjectStore.ts` (currently at 2).
- Generalize `conflictRecovery.ts` so the conflict source is "the account copy", not "the
  room copy" — the resolutions and the recovery-copy-first ordering are unchanged; the
  lease precondition applies only when leases are enforced.
- Drive it from two places: a 409 out of Phase 2's autosave, and a Phase 3 poll that finds
  both sides moved.
- Give `selectProjectDocument` the third input, so open-time reconciliation returns a
  conflict rather than a winner when both sides moved.

**Tests:** the truth table above, case by case; a recovery copy is written before any
resolution mutates state; an unresolved conflict survives dialog close and reload (the
existing marker already does this); a viewer-role conflict cannot keep-mine.

### Phase 5 — Retention, quota, and size

Closes gap 6. Needed before Phase 2 is enabled for real users, not before it is written.

- Implemented in migration 0010: continuous autosave does not create revision
  rows, and explicit revisions retain the newest bounded set per project.
- Per-account accounting of stored document bytes, and a refusal message that names the
  ceiling instead of failing generically.
- Implemented by `0011_r2_project_storage.sql` and the R2 project projection:
  D1 holds metadata, summary fields, accounting, and immutable-object pointers;
  R2 holds gzip-compressed documents plus content-addressed STEP/mesh payloads.
  Legacy D1 rows remain readable.

**Tests:** pruning keeps named checkpoints; the ceiling refuses before the D1 write; the
refusal is distinguishable from an offline failure at the client.

### Phase 6 — Surface it

Closes gap 7.

- Start-screen badges: cloud, local-only, syncing, conflict.
- Settings → Files & autosave: a cloud-autosave toggle and its cadence, riding the existing
  synced `AppSettings` (`packages/shared/src/index.ts:1200`).
- The workspace status pill reports sync state, not just save state.

## Risks

- **Write amplification.** A 3 s debounce over a long session is a lot of D1 updates. The
  autosave/checkpoint split (decision 2) is what keeps this bounded; if it still bites, raise
  the debounce before adding machinery.
- **Documents outgrowing the ceiling.** A dense STEP import plus history can approach
  1.5 MB. Phase 5 must land before autosave is enabled broadly, or users will meet the
  ceiling as an unexplained sync failure.
- **Clock skew.** Anything left keying on `derived.updatedAt` inherits the device clock.
  Phase 4 exists to remove that dependency from the sync decision; do not add new ones.
- **Flag entanglement.** Personal sync must not become a back door that enables sharing or
  lease enforcement. Keep the flags and their tests separate.

## Non-goals

- CRDT or operational-transform merging of divergent histories.
- Per-command or streaming sync.
- Any geometry evaluation in the Cloudflare Worker.
- Enabling sharing, invitations, or lease enforcement — those remain on their own rollout.

## Suggested order

Phase 0 → Phase 1 → Phase 2 → Phase 5 → Phase 3 → Phase 4 → Phase 6.

Phase 1 is the one that makes the feature exist; Phase 2 is the one users feel. Phase 5
is pulled ahead of the pull side because it gates enabling Phase 2, not because it gates
writing it.
