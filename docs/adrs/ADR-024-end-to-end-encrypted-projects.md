# ADR-024: End-to-end encrypted project data

## Status

Accepted 2026-10-19 as the design for roadmap row
[L11](../../ROADMAP.md#l11). This record is Phase 0; no implementation phase
has started. Extends [ADR-012](ADR-012-email-code-identity.md),
[ADR-016](ADR-016-project-cloud-sync.md),
[ADR-018](ADR-018-client-generated-artifacts.md) and
[ADR-019](ADR-019-durable-collaboration-authorization.md). Supersedes the
server-side document handling they describe once Phase 8 lands.

## Context

The application does not encrypt project data itself today. Project documents
are gzipped JSON in R2, small or legacy documents also sit in D1
`projects.document_json` and `revisions.document_json`, and the collaboration
room keeps the latest document and up to 20 prior snapshots in Durable Object
storage. Cloudflare encrypts these stores at rest, which protects against lost
media but not against anyone who controls the account, the Worker or its API
tokens. The only data the Worker encrypts is each user's personal AI
credential (AES-GCM under `SETTINGS_ENCRYPTION_KEY`).

The server is also an active participant in the data model, not a blob store:

- `validation.ts` parses whole documents and checks structure, history, text
  budgets and import sources.
- `normalizeDocument` migrates the schema on every load and save, and
  `createSavedRevision` mints revision and checkpoint ids on the server.
- `prepareProjectStorageSnapshot` splits STEP text and meshes into
  content-addressed assets keyed by plaintext SHA-256.
- The room runs a three-way JSON merge (`mergeCollaborationDocuments`) and
  broadcasts full documents.
- Duplicate, branch, adopt, copy rollback/finalize and mesh-payload discard
  load and transform documents, or compare canonical digests of them.
- Share links are served from a projection the server builds.
- Invitation emails read the project name.

Geometry is not among them: modeling, imports, exports and thumbnails already
run in the browser. Sign-in is email codes only (ADR-012). There is no
password or passkey anywhere, so no user-held secret exists to derive a key
from.

## Threat model

End-to-end encryption protects stored project contents against:

- a leaked D1 database, R2 bucket, backup or Time Travel snapshot;
- a compromised Cloudflare account or API token;
- operator or provider staff browsing stored data;
- legal requests for stored contents;
- takeover of a user's email inbox, which signs the attacker in but unlocks no
  keys.

It does not protect against:

- altered application code. On the web the server delivers the JavaScript, so
  a compromised deployment could ship code that reads keys. The signed desktop
  app is the stronger client;
- the AI assistant, whose model summary must reach the provider in plaintext;
- metadata (see below);
- a removed member's earlier copies. Removal protects later versions only;
- a compromised device, or local IndexedDB copies, which stay as safe as the
  device's disk encryption;
- deletion or withholding by someone with storage access. Encryption makes
  tampering detectable, not impossible;
- a server that keeps members on permanently separate branches of a project,
  or serves a stale history to a browser that has never seen the project.
  [Version integrity](#version-integrity) gives fork consistency and a manual
  cross-check, not an automatic guarantee.

## Decision

### Server role

The server becomes a versioned blob store, an access-control layer and a
relay. Every content transformation listed under Context moves into the
browser. The server keeps authentication, roles and edit leases, version
fencing, quotas on ciphertext sizes, upload sessions and deletion. It checks
envelope shape and size only. Every client runs the shared document
validators after decrypting and refuses a bad version before rendering it,
keeping the last good one.

### Envelope

Every stored blob is an envelope with an algorithm version, a small plaintext
header and AES-256-GCM ciphertext. The whole header is bound into the
authenticated data, so changing it breaks decryption. Bodies are compressed
before encryption. There are two envelope classes:

- **Project envelopes** hold document versions, measurements, workspace view
  state and share snapshots. Their header carries the project id, document
  version, previous-version hash, schema version, key epoch, blob kind and the
  ids of the content blobs the version references. They are bound to one
  project and are never moved between projects.
- **Content blobs** hold imported sources, mesh payloads, thumbnails and
  archived exports. Their header carries only an immutable random blob id, the
  blob kind and the algorithm version; no project id. Large content blobs are
  split into fixed-size chunks, and each chunk binds the blob id, its index
  and a final-chunk flag, so a truncated, reordered or transplanted chunk
  fails. Multipart uploads use the same chunking per part.

A content blob is authenticated by the project envelope that references it.
That envelope records the blob id, the blob's random key and a hash of its
ciphertext, so a blob the server swaps in from elsewhere fails to decrypt or
fails the hash. Copying a project is then cheap for large files: the browser
writes a new first version of the destination's project envelope, re-encrypted
under the destination project's keys and carrying the same blob ids and keys.
The server copies the referenced content blobs byte for byte, under the same
blob ids. No STEP file is re-encrypted, and nothing in a copied blob names the
source project.

Asset de-duplication stays per project. It keys on an HMAC of the plaintext
under a key derived from the project key, so the server cannot test whether a
known file is present. The HMAC is an index column beside the blob, not part
of any envelope. A copied blob gets the destination's HMAC only when the
copying browser has the plaintext at hand; otherwise it has no de-duplication
entry, which affects only future de-duplication.

### Key hierarchy

| Layer         | What it is                                                                                       | Wrapped by                                              |
| ------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Account key   | One random 256-bit key per user, never stored unwrapped                                          | Each unlock method                                      |
| User key pair | ECDH P-256 for receiving project keys, plus an ECDSA P-256 signing pair; public halves published | Account key                                             |
| Project key   | One random key per project, versioned by epoch                                                   | Each member's public key, then the member's account key |
| Version keys  | One random key per project envelope (document version, measurements, view state, share snapshot) | Project key                                             |
| Blob keys     | One random key per content blob (import source, mesh payload, thumbnail, archived export)        | Recorded inside the referencing project envelope        |

Once a member accepts a project, their browser re-wraps its key under their
own account key, so opening the project shelf needs only symmetric unwraps.
Because blob keys travel inside the project envelope, a copy re-encrypts only
the small document, never the large STEP files it references. Every wrap
carries an algorithm version so a hybrid post-quantum
wrap can be added without re-encrypting data; ECDH wraps are not
quantum-resistant and CAD data can stay valuable for decades.

All primitives come from WebCrypto (AES-GCM, HKDF, ECDH and ECDSA on P-256,
AES-KW). No new runtime dependency is needed. The recovery key has full
entropy, so no password-hashing library is needed either.

### Unlock and devices

Email codes remain the sign-in. They grant access to ciphertext, never to
keys. Any one of these unlock methods opens the account key:

- **This device:** a non-extractable key in IndexedDB on the web and in the
  macOS Keychain on desktop, next to the existing refresh token.
- **A passkey** through the WebAuthn PRF extension where the browser and
  authenticator support it. The desktop WebView has no WebAuthn and relies on
  the other methods.
- **The recovery key:** a random 256-bit code the user must save and confirm
  during setup.
- **Approval from an unlocked device.** The new device shows a short code
  computed from its own public key. The approving device computes the code
  from the key the server handed it and wraps the account key only if the
  two match, so the server cannot substitute a device. The flow reuses the
  shape of the desktop sign-in approval.

### Key lifecycle

- **Removing a device** deletes its wrap, rotates the account key and user key
  pair, and starts a new epoch on every project the user owns. Owners of
  shared projects are prompted to start one on theirs.
- **The recovery key** can be reissued from an unlocked device, which deletes
  the old wrap. Settings warns when no recovery key has been confirmed.
- **Sign-out** asks whether to keep this device unlocked. Declining deletes
  the device key along with the session.
- **Safari** clears IndexedDB for a site after seven days without a visit
  unless it was added to the Home Screen. That deletes the device key, and the
  user unlocks again with a passkey or the recovery key.

### Version integrity

Each version's header carries the hash of the previous version, and its author
signs it. Browsers remember the newest version they have seen of each project
and refuse any version whose chain does not contain it. That gives fork
consistency, not full consistency:

- **What is detected.** A browser cannot be rolled back behind what it has
  already seen. If the server ever shows two members a forked history, then
  as soon as either one sees a version from the other branch, its chain is
  missing that member's last-seen version and the fork is reported. A server
  that forks members must keep them apart forever.
- **What is not detected.** A server that keeps members permanently apart can
  serve each one a consistent, separately signed branch. Neither browser ever
  sees evidence of the other. A new browser, or one whose storage was cleared,
  has no last-seen version, so it accepts any validly signed chain, however
  stale.
- **Cross-client anchor.** The sharing dialog and project info show a short
  project state code, derived from the newest version's hash, its version
  number and the signing member's fingerprint. Members who compare codes
  outside OpenZCAD, or a fresh browser checking against a member's code,
  detect a split view or rollback. Each signed version also carries the
  author's signed timestamp, so a fresh browser warns when the newest version
  it is offered is older than the project's last recorded activity. The
  server reports that activity in plaintext, so the warning is a heuristic.
- **Not in scope.** An automatic cross-client mechanism (transparency log,
  gossip over an independent channel, or authenticated checkpoint transfer
  between members) is deferred. Product copy must not claim that the server
  cannot fork or roll back a project. It can only claim that a member is never
  silently moved backwards from what they have seen.

Browsers pin each member's public key on first sight and warn when it changes.
The sharing dialog shows a short key fingerprint for comparison.

### Sharing and collaboration

- **Encryption follows the owner's account.** A project owned by an account
  that has not opted in stays plaintext. Invitees must set up encryption
  before they can open an encrypted project.
- **Invitations are signed by the owner.** If the invitee already has keys,
  the owner's browser wraps the project key to them at once. Otherwise the
  invitation waits, and the owner's next session completes it, but only for
  invitations it signed and only after the owner confirms the invitee's
  fingerprint. Sharing remains owner-only (ADR-019).
- **Invitation emails** name the sender, not the project.
- **Share links** become `#share=<token>.<key>`; the fragment never reaches
  the server. The share key is stored wrapped under the project key, so any
  editor's browser republishes the snapshot (current model, no history) on
  save. Revoking a link deletes the snapshot. "Make a copy" decrypts in the
  visitor's browser and saves under the visitor's keys, or locally.
- **Live editing** keeps leases, presence and roles. The room relays encrypted
  documents and orders versions. On a conflict it returns the base and the
  latest ciphertext; the browser merges with `mergeCollaborationDocuments`,
  moved to a shared package, and resubmits.
- **Removing a member** starts a new project-key epoch.
- **Viewers** hold the project key; read-only remains a server rule on writes.

### Plaintext metadata

The server still sees account emails and display names, member lists and
roles, project and revision counts, blob sizes and counts, timestamps, version
numbers and save cadence, presence during live editing, schema versions and
the envelope header fields. Project names, checkpoint names, revision reasons,
upload file names, thumbnails, measurements, workspace view state and archived
exports are encrypted. R2 keys use opaque ids only.

### AI assistant

The assistant cannot work on ciphertext. On an encrypted project it asks once
per project, stating exactly what leaves the device (the compact model digest,
the active selection, and any attached drawings or images) before the first
request.

### Settled product decisions

| Question                           | Decision                                                                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opt-in or every project?           | Opt-in per account during the beta, then on by default, then the plaintext path is removed.                                                                            |
| Assistant on encrypted projects?   | Ask once per project, stating what leaves the device.                                                                                                                  |
| Encrypt project names?             | Yes; invitation emails no longer name the project.                                                                                                                     |
| Unrecoverable accounts?            | Accepted. There is no server-held escrow key. A user who loses every unlock method loses their cloud projects; local copies remain.                                    |
| Turn encryption off again?         | Only during the beta, and not while a project is shared. After default-on, the exit is `.openzcad` export plus cloud deletion, which needs no plaintext server path.   |
| Accounts that never sign in again? | Kept and encrypted on their next sign-in; product copy says encryption starts at the first sign-in after the switch. Deletion after notice is revisited at default-on. |

## Delivery phases

Phase 1 moves the server logic into the browser while data is still plaintext,
so the existing Vitest, parity and Playwright suites prove the behavior before
any encryption lands. After that, encryption is a storage-format change.
Estimates are judgment, not measurement.

| Phase | Scope                                                                                                                                                                                                                                                                                                                                         | Estimate     |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 0     | This ADR and roadmap row L11. A privacy policy page is a prerequisite for any public encryption claim; OpenZCAD has none yet.                                                                                                                                                                                                                 | 1 PR (this)  |
| 1     | Thin server, still plaintext: the browser creates projects, mints revisions and checkpoints, duplicates, branches and adopts, splits import assets and runs the room merge. Copy rollback and finalize compare client-supplied digests. The room conflict reply carries the base version. The server keeps size and envelope checks.          | 5–6 PRs      |
| 2     | Crypto core package: envelope v1 with algorithm versioning, project envelopes and project-free content blobs, AES-256-GCM, HKDF, ECDH wrapping, authenticated-data binding, chunked blobs that detect truncation, fixed test vectors and a fuzzed envelope parser.                                                                            | 1 PR         |
| 3     | Keys and devices: D1 key tables, setup with a required recovery key, passkey unlock, key-derived device approval, desktop Keychain storage and an Encryption section in Settings with device removal, rotation, recovery-key reissue and the sign-out choice. Setup screens load lazily (entry budget). Playwright fixtures seed device keys. | 3–4 PRs      |
| 4     | Encrypted projects, opt-in per account: documents, revisions, assets, names, thumbnails, measurements, view state and archived exports; the room relay; version-integrity checks. Each project records a format version so older builds say "update to open". Breaking storage and API change.                                                | 2–3 PRs      |
| 5     | Sharing: owner-signed invitations, member key wraps, share links with fragment keys, new epochs on removal, key pinning and fingerprints, and the project state code.                                                                                                                                                                         | 2 PRs        |
| 6     | Assistant consent on encrypted projects.                                                                                                                                                                                                                                                                                                      | 1 PR         |
| 7     | Migrate existing projects: each owner's browser encrypts every revision and asset, then the server deletes the plaintext, including legacy `document_json` rows and the room's retained history. Beta-only reverse path for turning encryption off. Needs its own production authorization.                                                   | 1–2 PRs      |
| 8     | Default on; delete the server document pipeline and the off switch; keep a browser read path for legacy plaintext projects; update `docs/SELF_HOSTING.md`; outside review of the crypto and key flows.                                                                                                                                        | 1 PR, review |

Total: 17–21 PRs.

## Consequences

- Lost keys mean lost cloud data. Support cannot recover or inspect a project;
  bug reports rely on user-exported `.openzcad` backups.
- Schema migrations run only in the browser, permanently. An old project keeps
  its old format until someone opens it, every migration step ships in the app
  indefinitely, and one-off database backfills over document contents (like
  those in migrations 0002, 0010 and 0011) become impossible.
- The server can no longer stop a buggy or hostile editor from storing a
  document other members cannot open; client-side validation and keeping the
  last good version are the defense.
- Abuse reports cannot be checked against stored files; quotas and account
  suspension are the remaining levers.
- `.openzcad` backups stay plaintext files the user holds. A
  passphrase-protected backup format can follow separately.
- D1 Time Travel and the room's point-in-time recovery (it is a SQLite-backed
  Durable Object) retain migrated plaintext for up to 30 days; release notes
  must say so.
- Shelf loading unwraps one key per project, cached in memory for the session.
- Keychain storage adds Tauri commands that only the manual Apple Silicon
  workflow exercises in the real WebView; running it remains the maintainer's
  call.
- Publishing each release's bundle hashes next to `/build-meta.json` narrows,
  but does not close, the web code-delivery gap.

## Alternatives considered

- **Worker-side encryption** with per-account keys derived from a Worker
  secret. One or two PRs, keeps every server feature, and protects against
  leaked database and bucket copies, but anyone controlling the Worker or its
  secrets reads everything. It is not a step toward this design.
- **Passphrase-derived keys.** Users would need a second secret beside their
  email, and a memorable passphrase needs a memory-hard KDF (a new WASM
  dependency) to resist offline guessing. A full-entropy recovery key plus
  passkeys and device keys gives the same coverage without either.
- **Server-held escrow** of account keys for recovery. It would make support
  recovery possible and defeat the purpose of end-to-end encryption.
