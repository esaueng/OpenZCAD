# ADR-016: Project cloud sync between a user's own devices

## Status

Accepted. Implementation is phased; see
`docs/plans/project-cloud-sync-plan.md` for the phase order and per-phase
scope.

## Context

A signed-in account already stores projects, settings, and revision history in
D1, and the browser already autosaves the canonical document to IndexedDB on
every change. The two stores are not connected. A document reaches the account
only through an explicit manual save, a project created while signed out can
never be uploaded at all, and nothing tells a second device that the first one
moved. The result is an account that holds projects but does not hold a user's
work.

The pieces needed to close that gap mostly exist. Settings already ride a
debounced, retrying, offline-aware autosave controller. Divergence already has
a recovery-copy-first resolution contract. A Durable Object room already pushes
document updates to connected clients. What is missing is the decision about
how these compose for a single user with several browsers, and that decision
has to be made once rather than per call site, because the failure mode is
silent data loss.

Two constraints shape everything below. The canonical browser document is a
replayable command history whose exact rebuild is the product; and cloud
persistence must not make relational row size or autosave frequency a data-loss
risk. ADR-003 now projects cloud documents into immutable R2 objects while D1
keeps compare-and-set metadata and revision pointers.

## Decision

### Divergence is resolved by a person, not by a merge algorithm

Cloud writes remain a whole-document compare-and-set against
`projects.document_version`. Two divergent histories are never merged
automatically. Merging them would mean merging geometry semantics, and a wrong
merge produces a part that is silently incorrect rather than visibly broken —
the one failure this project cannot ship.

When a write is fenced off, the client writes an untouched recovery copy of the
local document before any resolution mutates state, then offers the same three
resolutions the collaboration path already offers: take the account's version,
keep this device's version, or save this device's version as a separate copy
and take the account's. Operational transform and CRDT convergence are rejected
for the document; they remain available in principle for future
non-geometric state.

### Autosave writes the document row; checkpoints write history

`POST /api/projects/:id/revisions` keeps its present meaning: an explicit,
reason-carrying checkpoint that inserts a full document snapshot into
`revisions`. Continuous sync uses a separate `PUT /api/projects/:id/document`,
which performs the same compare-and-set on the `projects` row and inserts no
revision.

Without this split, continuous sync would insert one full document copy per
autosave and make stored bytes a function of the edit rate rather than of the
work. With it, a busy session costs a bounded number of row updates, and the
revision history stays a record of moments a user chose to mark.

### The device records the version it last agreed with the account

Each device persists `lastSyncedVersion` per project alongside its shelf
metadata, in the device-owned IndexedDB store that is already excluded from
document sync. Sync decisions read it rather than comparing wall-clock
timestamps:

| local vs `lastSyncedVersion` | account vs `lastSyncedVersion` | outcome                           |
| ---------------------------- | ------------------------------ | --------------------------------- |
| unchanged                    | unchanged                      | in sync                           |
| ahead                        | unchanged                      | push                              |
| unchanged                    | ahead                          | pull and hydrate                  |
| ahead                        | ahead                          | conflict: recovery copy, then ask |

The fourth row is the reason this exists. Comparing `version` and then
`derived.updatedAt` — what open-time reconciliation does today — cannot
distinguish a device that is merely behind from two devices that both moved, so
it resolves the second case by dropping one side on the authority of a device
clock. With `lastSyncedVersion` the ambiguous case becomes detectable, and
detectable means recoverable.

### Personal device sync is gated separately from sharing

The collaboration room is the natural push channel for a user's own devices,
but sharing carries invitations, roles, and edit-lease enforcement that remain
deliberately disabled. A new `PROJECT_PERSONAL_SYNC_ENABLED` flag gates rooms
joined by the project owner alone, independent of `PROJECT_SHARING_ENABLED`.
Enabling personal sync must not enable sharing, admit a non-owner to a room, or
change lease behaviour.

Until that flag is on, the pull side is version polling on window focus,
network regain, and a slow interval while a cloud project is open. Polling
compares versions rather than fetching documents, so it stays cheap enough to
be the permanent fallback rather than a placeholder.

### The device stays authoritative for the running session

IndexedDB is written first and unconditionally on every change. A cloud write
never blocks an edit, never gates the UI, and never decides whether work is
kept. A failed push degrades to "saved on this device" and retries; it does not
surface as data loss, because no data was lost.

Shelf state — archive, pin, manual order — keeps its existing and opposite
rule: the device wins outright and the account copy only fills in projects this
device has never organised. It describes a desk, not a part.

## Consequences

- Work reaches the account continuously without a user action, and a project
  created offline can be adopted into the account later while keeping its
  `projectId`, so the device's local copy and shelf metadata stay linked.
- Stored bytes scale with the number of projects and explicit checkpoints, not
  with the edit rate. Retention is bounded and R2 project objects remove the
  former 1.5 MB D1 row ceiling. Request parsing remains bounded, and live
  collaboration retains its smaller Durable Object/frame limit until that
  transport receives the same projection.
- Conflicts become visible and recoverable rather than resolved by a clock, at
  the cost of interrupting a user who edited on two devices. That interruption
  is the intended behaviour.
- Two devices editing the same project simultaneously without personal sync
  enabled will conflict rather than converge. Polling narrows the window; it
  does not close it. Closing it is what the room is for.
- `lastSyncedVersion` is device-local, so clearing browser storage loses the
  sync baseline. Reconciliation must then fall back to the conservative path —
  treat an unknown baseline as potentially divergent — rather than assuming the
  device is in sync.

## Verification

Unit tests cover the truth table case by case, recovery-copy ordering before
every resolution, autosave debounce and single-flight behaviour, fenced-write
handling, adoption round trips including re-adoption and cross-owner refusal,
and the size ceiling refusing before the D1 write. The Playwright flow in
`test/e2e/cloud-sync.spec.ts` covers create, autosave, reload, cross-device
pull, two-device divergence, and confirmation that the losing side survives as
a recovery copy.
