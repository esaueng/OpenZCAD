# ADR-023: Durable undo and cross-device workspace resume

## Decision

Schema v14 adds optional `ProjectDocument.editHistory`. A legacy document starts
with no undo entries; feature order and the command log cannot reconstruct lost
browser undo state. History records exact before/after document values, with
collection entries and array splices bounding duplication. It never executes
serialized commands. Each entry has a stable id and label, and the manifest
records the project, author, cursor, and retention count.

The document and its undo position are one value throughout IndexedDB, cloud
autosave, R2 projection, collaboration, and conflict recovery. Existing version
fences therefore protect both. Undo/redo advances the version and revision
record while preserving explicit checkpoints. A new edit discards redo. A
normalization adjusts adjacent history endpoints without adding an undo step.

History is limited to 100 steps and 8,000,000 serialized bytes. The oldest undo
steps are removed first; a single edit exceeding the budget creates a history
boundary. The workspace reports retention. Source payloads needed only by undo
or redo remain referenced by local cleanup, backup, and private R2 projection.
Archiving source bytes rewrites their local artifact ids throughout history;
undo never unarchives an uploaded source. Geometry workers and rebuild cache
keys exclude undo metadata.

Different devices signed into the same account share the cursor. Another
collaborator cannot undo the previous author's actions; their first edit starts
a new author segment. Existing role and lease checks remain in force. Diverged
documents use ADR-016's recovery-first conflict resolution, never a history
merge. Mismatched patch endpoints are refused without modifying the document.
Newer-schema rejection and history validation also apply at collaboration and
HTTP boundaries.

## Workspace sessions

`GET/PUT /api/projects/:projectId/workspace-sessions` stores a separate private
record for the authenticated account and browser session. Migration 0018 adds
`project_workspace_sessions`, cascading with project/account deletion. Records
contain a random device id, random session id, sequence, referenced document
version, generic device label, camera, projection, display settings, hidden and
selected body ids, workbench, and panel collapse state. They contain no model
snapshots, credentials, unfinished tool operations, or AI conversation.

Writes occur after deliberate activity settles, with retries while the project
remains open. Existing device view persistence remains independent.
Idle polling and page teardown do not create a new activity timestamp. The
server supplies timestamps, ignores repeated/older sequences, and refuses
records ahead of the durable model. Each account/project keeps at most 20
sessions; the resume list excludes records older than 30 days. Request size is
bounded to 32 KiB. Membership grants access to the project, not another user's
workspace records.

Opening a cloud project waits for model reconciliation before offering the
latest other-device session. A late lookup never interrupts editing or applies
across account/project switches. Both choices retain the current project and
its history. Resume restores the saved camera before a new viewer fits, filters
stale body ids, and adapts panel visibility for a narrow screen. Declining opens
the default view and does not delete the previous session. Live presence, when
available, identifies that the project is also open in another session.

## Deployment and compatibility

No new dependencies or production bindings. Apply migration 0018 before enabling
the new endpoints in a deployment. Missing session storage degrades to opening
the model normally. Older applications must update before editing schema-v14
history. Production migration, merge, and deployment are separate delivery
steps; application startup does not apply migrations.

AI conversation/attachment synchronization and selective multi-author undo
remain separate follow-ups. Existing account settings, named save states,
measurements, and project organization retain their current persistence paths.
