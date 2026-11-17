# L08 review links and L03 versions: plan

> **Supporting record.** [ROADMAP.md](../../ROADMAP.md) owns priority and
> status for [L08](../../ROADMAP.md#l08) and [L03](../../ROADMAP.md#l03).
> This plan fixes how both stay end-to-end encrypted under
> [ADR-024](../adrs/ADR-024-end-to-end-encrypted-projects.md) (L11) before any
> code lands. It builds on ADR-016 (cloud sync), ADR-022 (save-state restore
> and branching) and the [save-state plan](save-state-versioning-plan.md).

## Contracts

- **L03.** Save-state naming, a read-only preview, a thumbnail and a diff per
  checkpoint, and a versions list with editor, device and sync columns.
  Content dedup is optional in the row and is not taken up here.
- **L08.** Comments anchored to a point on the model, viewer and commenter
  roles, and drawings on share links with a PDF download.

## The E2EE rule both follow

ADR-024 lists checkpoint names and revision reasons among the data the
server must not read, and treats the server as able to replay, drop and
reorder what it stores. Every new piece of data below therefore takes one of
three routes, chosen in this order:

1. **Inside the project document.** The document is already a signed,
   encrypted project envelope on encrypted projects and is covered by version
   integrity (hash chain, device signature, fork consistency). Data that only
   people with edit rights write goes here, behind a claimed schema version.
2. **On the device only.** Data that can be rebuilt from the document, or is
   a per-device convenience, stays in IndexedDB and is never uploaded.
3. **A new signed, encrypted side record.** Data written by people who cannot
   write the document (viewers, link visitors) needs its own envelope kind,
   following the `measurements` and `view-state` precedent
   (`packages/crypto/src/bodies.ts`). This route changes the encrypted format
   and is an owner decision (see [Owner decisions](#owner-decisions)).

A plaintext project keeps today's plaintext storage for the same data; the
server never learns more about an encrypted project than the plaintext
metadata ADR-024 already lists (counts, sizes, timestamps, who wrote a row).

## L03 versions

| Piece                        | Route    | Design                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name and rename              | Document | `ProjectCheckpoint.name?` (user's name; `reason` stays the automatic one). Save with a name from the save command; rename from the row menu as one undoable command that edits only the checkpoint list. Editors only: a rename is a document write.                                                                                                                                               |
| Editor and device columns    | Document | `ProjectCheckpoint.author?: { userId?, displayName?, deviceLabel? }`, written by the saving browser. On an encrypted project the version that carries the checkpoint is signed by the author's certified device, so the claim is as trustworthy as the document itself; the column shows it as written, like every other document field an editor controls.                                        |
| Sync column                  | Derived  | Computed per row from the two stores ADR-022 already asks: on this device, in the account, both, or not stored. No new data.                                                                                                                                                                                                                                                                       |
| Read-only preview            | Derived  | Opens a save state's document in the workspace behind a banner (Restore · Branch · Close) with every editing command refused by the project guard. The document comes from the device store first, then the account, as restore does. An encrypted account read is a **historical read** (ADR-024 Version integrity): accepted only as the pinned head or an ancestor, and it never moves the pin. |
| Thumbnail per checkpoint     | Device   | Captured at save time from the live viewport (the existing thumbnail capture) into the device's `projectCheckpointDocuments` row, and captured again when a preview renders a row that has none. Never uploaded, so nothing new reaches the server; another device shows a placeholder until it previews that row.                                                                                 |
| Diff between two save states | Derived  | A pure document-core function over two documents: features added, removed and changed (by id, with names and changed fields), parameter values, bodies, sketches and drawing sheets. Runs in the browser on decrypted documents only.                                                                                                                                                              |

Schema: one claimed version for `name` and `author` (additive, optional;
absent on every older checkpoint, which keeps showing its `reason`).

## L08 review links

### Drawings on share links

Share snapshots drop `drawings` today
(`packages/document-core/src/shared-snapshot.ts`) because title blocks carry
author, date and drawing-number text. The owner or an editor opts a sheet in
with a per-sheet `shareOnLinks?: true` (document route, claimed schema
version). The snapshot keeps only opted-in sheets. A link visitor opens Draw
read-only with those sheets and downloads a PDF built in the browser by the
existing sheet export. An encrypted snapshot already travels as a signed share
envelope, so this needs no format change.

### Comments

A comment is `{ commentId, parentId?, anchor, text, authorLabel, createdAt }`
plus append-only `resolve`/`reopen`/`delete` events, where
`anchor = { point: [x, y, z], normal?, bodyId?, faceKey?, documentVersion }`
in model coordinates. Anchors are positions, not live topology: a pin whose
body or face no longer exists stays where it was and says it is detached.

- **Plaintext projects.** A new D1 table holds comment events as JSON rows,
  bounded per project and per author, rate limited, deleted with the project.
- **Encrypted projects, members.** Each event is a new project envelope kind
  `comment`: a fresh version key wrapped by the project key, body encrypted,
  signed by the author's certified device key, so the server stores an opaque
  row and can only drop or withhold events. Viewers may write these: they are
  side records, not document versions, so the read-only rule for the model is
  unchanged.
- **Encrypted projects, link visitors.** A `share-comment` envelope with a
  fresh key wrapped under the link's share key (which members unwrap through
  the project key). A visitor has no certified key, so these are unsigned and
  shown as "via link" with the name the visitor typed. The server cannot read
  or forge one (it never sees the share key), but anyone holding the link can
  write one.

### Viewer and commenter roles

- **Members.** Owner, editors and viewers can all comment; no new MLS role.
- **Share links.** A link's mode gains `comment` beside `view` and `tweak`:
  read-only plus comments. On a plaintext link the Worker enforces it. On an
  encrypted link the mode lives in the owner-signed link grant, so members'
  browsers show a visitor comment only when its link's verified grant says
  `comment`, and a server cannot turn a view link into a commenting one.

## Slices

Each slice ships with unit tests, an `@ci-smoke` e2e spec and an evidence
fragment in `docs/roadmap-evidence/`.

1. **L03-1 names and versions list.** Name and rename, author columns, sync
   column (schema version claimed at the time).
2. **L03-2 read-only preview** with the banner and historical-read rule.
3. **L03-3 per-checkpoint thumbnails** (device route).
4. **L03-4 diffs** between two save states, or a save state and now.
5. **L08-1 drawings on share links** with the PDF download (schema version).
6. **L08-2 comments on plaintext projects** for members: anchoring, panel,
   replies, resolve.
7. **L08-3 commenter links** for plaintext projects.
8. **L08-4 encrypted comments and commenter links**: the `comment` and
   `share-comment` envelope kinds and the grant mode. Held for the owner and
   coordinated with the L11 thread; until it lands, comments are hidden on
   encrypted projects (nothing is sent in plaintext) and the commenter mode is
   not offered on encrypted links.

## Owner decisions

1. **New envelope kinds.** `comment` (member-signed) and `share-comment`
   (unsigned, share-key wrapped) for encrypted projects, as above. The
   alternative, comments inside the document, would let only editors comment.
2. **Unsigned visitor comments.** Accept that anyone holding a commenter link
   can write comments members will see, labelled "via link".
3. **Grant mode `comment`.** Adding a value to the owner-signed link grant's
   mode; older browsers refuse a grant with an unknown mode (fail closed), so
   a commenter link opens only on an updated build.
4. **Drawing sheets on links.** Per-sheet opt-in by an editor, rather than
   per-link by the owner. An editor can already put any text in the model a
   link serves.
5. **Comments on encryption.** Until encrypted comments exist, encrypting a
   plaintext project deletes its plaintext comments with the rest of its
   plaintext records (ADR-024 leaves the account no plaintext). Once slice 8
   lands, the migration should carry them as `comment` envelopes instead.
