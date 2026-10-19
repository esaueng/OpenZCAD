# ADR-024: End-to-end encrypted project data

## Status

Accepted 2026-10-19 as the design for roadmap row
[L11](../../ROADMAP.md#l11). This record is Phase 0; no implementation phase
has started. Extends [ADR-012](ADR-012-email-code-identity.md),
[ADR-016](ADR-016-project-cloud-sync.md),
[ADR-018](ADR-018-client-generated-artifacts.md) and
[ADR-019](ADR-019-durable-collaboration-authorization.md). Supersedes the
server-side document handling they describe once Phase 8 lands.

**Group key management is under reassessment (2026-10-19).** Review kept
finding flaws in the custom membership and key-rotation protocol, so changes
to it are paused. [MLS assessment](#mls-assessment) recommends replacing those
parts with Messaging Layer Security (RFC 9420). The sections it would replace
are marked there. Everything else in this record stands.

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
before encryption. The header records the exact plaintext size, so an
envelope that inflates beyond its declared size fails (see
[Decompression limits](#decompression-limits)). There are two envelope
classes:

- **Project envelopes** hold document versions, measurements, workspace view
  state and share snapshots. Their header carries the project id, document
  version, previous-version hash, roster entry hash, schema version, key
  epoch, blob kind and the ids of the content blobs the version references. They are bound to one
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

### Decompression limits

The server can no longer inspect what it stores, so a small, highly
compressible envelope from a buggy or hostile editor could expand until it
exhausts the browser. That would happen before the validators ever see the
document. Browsers therefore never decompress without limits:

- Decompression streams through `DecompressionStream` and stops the moment
  output exceeds the smaller of two limits: the header's declared plaintext
  size, and a fixed ceiling for that blob kind. The ceilings match today's
  server limits: `MAX_CLOUD_PROJECT_DOCUMENT_BYTES` for documents, and
  `MAX_ARTIFACT_UPLOAD_BYTES` for imported sources and archived exports.
  Thumbnails, measurements and view state get smaller ceilings of their own.
  This is the client-side counterpart of the cap in `decodeProjectStorageBody`
  (`packages/cloudflare-adapters/src/project-object-storage.ts`).
- A body that decompresses to anything other than its declared size fails,
  and the browser keeps the last good version.
- JSON parsing of a decompressed document keeps today's depth and
  value-count guards before any validator runs.
- Decompression and parsing run in a worker. A stalled or oversized job is
  terminated, not awaited, so the page stays responsive.

### Nonces and key use

AES-GCM must never repeat a nonce under the same key. The format makes that
structural rather than probabilistic:

- **One key, one blob.** Every version key and blob key is freshly random, and
  it encrypts exactly one immutable envelope. Content never changes in place:
  a changed file is a new blob with a new id and a new key. A retried upload
  re-sends the same ciphertext; it never re-encrypts under the existing key.
- **Deterministic chunk nonces.** Within one envelope, chunk `i` uses the
  96-bit nonce `uint88_be(i) || last`, where `last` is `0x01` on the final
  chunk and `0x00` otherwise (the STREAM construction). A single-chunk body
  is chunk 0 with `last = 0x01`. Each chunk's authenticated data is the
  serialized header plus the chunk index, so nonce, index, final flag and
  header are all bound. Truncation, reordering, duplication and transplanting
  chunks between blobs all fail.
- **Wrapping keys.** A key that encrypts many small items (the project key
  wrapping version keys, the account key wrapping the encryption key and project keys)
  wraps them with AES-KW, which takes no nonce. Any AES-GCM use under such a
  long-lived key takes a fresh random 96-bit nonce, stored beside the
  ciphertext, and stays far below 2^32 operations per key. Key epochs and
  rotation keep counts low in practice.
- **Test vectors** in Phase 2 fix the nonce layout, and negative tests prove
  that a reused key or nonce is refused by the encoder.

### Key hierarchy

| Layer               | What it is                                                                                                                                                                               | Wrapped by                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Identity key        | One long-term ECDSA P-256 pair per user; its fingerprint is what other people verify. It signs only certificates and revocations for the user's other keys, and the user's contacts list | The recovery key and passkeys only; never device keys or the account key |
| Device signing key  | One ECDSA P-256 pair per device, non-extractable where the platform allows, certified by the identity key. Signs versions, roster entries and share snapshots                            | Never leaves its device                                                  |
| Account key         | One random 256-bit key per user, never stored unwrapped                                                                                                                                  | Each unlock method                                                       |
| Encryption key pair | ECDH P-256 for receiving project keys; the public half is certified by the identity key                                                                                                  | Account key                                                              |
| Project key         | One random key per project, versioned by epoch                                                                                                                                           | Each member's encryption public key, then the member's account key       |
| Version keys        | One random key per project envelope (document version, measurements, view state, share snapshot); a share snapshot's key is also wrapped by its share key                                | Project key                                                              |
| Blob keys           | One random key per content blob (import source, mesh payload, thumbnail, archived export)                                                                                                | Recorded inside the referencing project envelope                         |

The identity key is kept apart so it can outlive any device. Everyday unlocking
never touches it: a device that is stolen while unlocked holds the account
key, the encryption key and its own signing key, but not the identity key.
Rotating those keys therefore leaves the identity, and every fingerprint that
other people verified, intact. A device compromised while the identity key was
briefly unlocked on it is the exception, and is handled like an exposed
recovery key. The user's device list is a chain of entries
signed by the identity key. Each entry certifies the current encryption key
and every live device signing key, or revokes one. Browsers pin it with the
same fork-consistency rule as versions.

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
keys. Any one of these unlock methods opens the account key. Only the recovery
key or a passkey also opens the identity key. It is unlocked briefly, for
certifying or revoking a device, rotating keys or replacing the recovery key,
and is then discarded from memory.

- **This device:** a non-extractable key in IndexedDB on the web and in the
  macOS Keychain on desktop, next to the existing refresh token.
- **A passkey** through the WebAuthn PRF extension where the browser and
  authenticator support it. The desktop WebView has no WebAuthn and relies on
  the other methods.
- **The recovery key:** a random 256-bit code the user must save and confirm
  during setup.
- **Approval from an unlocked device.** A short code computed from the new
  device's public key alone would be grindable: the server sees the real key
  and can generate keys offline until one matches the shortened code. The
  approval therefore uses one of two authenticated forms. The flow reuses the
  shape of the desktop sign-in approval. Approval hands over the account key,
  and the new device's signing key also needs a certificate from the identity
  key. So the approving device asks for a passkey or the recovery key, or the
  new device certifies itself later with one. Until it is certified, a device
  can read but not write: its signatures are refused like any unknown key's.
  - **Scan (preferred when the devices are together).** The approving device
    scans a QR code on the new device that carries the full 256-bit hash of
    its public key, and wraps the account key only if the hash matches the
    key the server delivered.
  - **Compare (remote).** The two devices run a commitment-based
    short-authentication-string exchange. The new device first sends a
    commitment `H(pk_new || n_new)` to a fresh random nonce. Only after it
    receives the approver's key and nonce `n_app` does it reveal `n_new`.
    Both devices then show six digits from
    `H(pk_new || pk_app || n_new || n_app)`. The commitment fixes the new
    side's values before the server can see the approver's, so offline
    grinding is impossible. A substituted key succeeds with probability
    10^-6 per attempt, and every attempt is a visible approval prompt.
    Approvals are rate-limited per account.

### Key lifecycle

A deleted server-side wrap is not revoked: a compromised server, a leaked
backup or a D1 Time Travel snapshot can keep the old wrap. So every flow
below that withdraws a secret rotates whatever that secret could open. Content
written before a rotation stays readable to anyone who already holds the old
keys and a copy of the old wraps. Rotation protects what comes after.

- **Removing a device** needs the identity key, so a passkey or the recovery
  key. The browser:
  - signs a device-list entry revoking the device's signing key. The entry
    names a cutoff for every project the user belongs to: the newest head the
    revoking browser has accepted. A claimed parent or timestamp proves
    nothing about when a version was really signed, because the stolen device
    can choose both. So once a browser has seen the revocation, it accepts
    that device's signature only on versions that are a cutoff head or one of
    its ancestors. Everything else it signed is refused, wherever it claims to
    sit. Revocations also cut off roster and epoch entries signed by that
    device;
  - rotates the account key and the encryption key pair, certifying the new
    encryption key in the same entry;
  - starts a new epoch on every project the user belongs to, owned or
    shared, before the removal completes (see
    [Epoch rotation](#epoch-rotation)). The removed device cannot unwrap the
    new project keys, because they go only to the new encryption key. If the
    browser goes offline part-way, other members' browsers finish the job
    before their next write;
  - lists any roster changes and versions the removed device signed since it
    was last seen in normal use, so the owner can review and undo them. A
    legitimate version the revoking browser had not yet seen falls outside the
    cutoff. The review list shows it, and the user can re-sign it from a good
    device.

  The identity key is unchanged, so members' verification still holds.

- **Replacing the recovery key** always replaces the identity key as well,
  whether the old code was lost or may have been seen. The old code opened
  the identity key, and a retained copy of the old wrap would let whoever
  finds the code later act as that identity: certify their own encryption
  key, steer future wraps to it, and sign as the user. No "it was only lost"
  shortcut can rule that out, so there is none. Settings explains the cost
  before the user starts: every contact verifies them again. The browser
  runs the same rotation as removing a device (new account key, new
  encryption key pair, new project epochs), then creates a new identity key. The new identity is accompanied by a
  statement signed by the old one, but that statement proves nothing to
  members, since the attacker could have signed it too. Every member who
  verified the old fingerprint sees the key as changed and must verify it
  again outside OpenZCAD. Until then they treat it as unverified: no new
  key wraps go to it, and its signatures are refused.

  In shared projects the roster still names the old, now compromised
  identity, and membership changes are owner-only. So the replacement is
  owner-mediated, under the rules in
  [Identity replacement](#identity-replacement). Until each owner acts, the
  member has no access to that project, by design.

  Settings warns when no recovery key has been confirmed.

- **A passkey that may be compromised** is removed the same way as an exposed
  recovery key, because it also opened the identity key.
- **Sign-out** asks whether to keep this device unlocked. Declining deletes
  the device key along with the session.
- **Safari** clears IndexedDB for a site after seven days without a visit
  unless it was added to the Home Screen. That deletes the device key, and the
  user unlocks again with a passkey or the recovery key.

### Version integrity

Each version's header carries the hash of the previous version, and its author's
certified device key signs it. Browsers remember the newest version they have seen of each project
and refuse any version offered as the current head whose chain does not
contain it. Two kinds of read are kept apart:

- **Current head.** The version the project opens at, or that live editing
  moves to, must descend from the pinned head, and accepting it moves the pin
  forward.
- **Historical read.** Opening a retained revision or named checkpoint
  deliberately reads an older version. It is accepted when it is the pinned
  head or one of its ancestors, proven by walking the hash chain back from
  the pinned head, and it never moves the pin. Restoring or branching from it
  writes a new version that descends from the current head, as ADR-022's
  restore does today, so history never rewinds.

That gives fork consistency, not full consistency:

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
- **Cross-client anchor.** The sharing dialog and project info show a
  project state code derived from the newest version's hash, its version
  number and the signing member's fingerprint. Like every code in this
  design that people compare by eye, it is shown at full length (see below). Members who compare codes
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

The server's key directory is not trusted: on first sight it could hand out a
key of its own. Browsers therefore keep two kinds of pin for other people's
keys:

- **Seen:** a key the browser has been shown. It is displayed with a warning
  and is never used to wrap a project key.
- **Verified:** a key whose full fingerprint the user has compared with its
  owner outside OpenZCAD, by QR in person or by reading digit groups over a
  call. A verification carries to the user's other devices and every later
  project shared with that person, but only through an authenticated path
  (below).

The identity fingerprint never changes, but the encryption key it certifies
does. A server could pair a correct identity with an old device list whose
encryption key a removed device still holds. So the live comparison covers
more than the identity. The QR code or digit groups are computed over the
identity key and the hash of the contact's current device-list head. The
verifying browser pins that head along with the identity. After that, a
project key is wrapped only to the encryption key certified in a device-list
head at least as new as the pinned one. Each time the browser sees a newer
head that chains from the pinned one, it moves the pin forward.

A pinned key that changes drops back to unverified, and the browser warns.

**Pins must not roll back.** A server that served an older copy of the user's
pins could revive a verified pin for a contact's key that has since been
replaced. Pins therefore live in a contacts list, not in plain encrypted
settings:

- The contacts list is a hash-chained list of entries signed by the user's
  identity key. Each entry verifies a contact's identity key together with
  the device-list head pinned for it, moves that head forward, or records
  that a verified key was replaced or is no longer trusted. Every device pins the
  newest entry it has seen and refuses an older or forked list, with the same
  rule as versions.
- Verifying someone, and recording that their key changed, both sign a new
  entry, so they ask for a passkey or the recovery key. Each happens once per
  person per key. When a browser notices that a verified contact's key has
  changed, it prompts for that signature at once. Until the user signs, the
  browser keeps the downgrade locally and blocks wraps to that contact.
- A device approved by another device receives the newest contacts head
  inside the authenticated approval exchange, so it cannot be handed an older
  list. A device enrolled with only a passkey or the recovery key starts from
  the newest identity-signed head the server shows it. It therefore has the
  same fork-consistency limit as everything else: a server hiding the latest
  entry can show it an older list. To narrow that, such a device treats every
  pin as seen, not verified, until another of the user's devices confirms the
  head, or the user re-verifies the contact.

**Codes people compare.** A truncated hash of a key the server can see invites
offline grinding, so no fingerprint or state code is shortened below 128
bits. They are shown as a word list or digit groups, with a QR form for
scanning. The only short code in the design is the six-digit device-approval
comparison, which is safe only because of its commitment step.

### Sharing and collaboration

- **Encryption follows the owner's account.** A project owned by an account
  that has not opted in stays plaintext. Invitees must set up encryption
  before they can open an encrypted project.
- **Invitations are signed by the owner, and a project key is only ever
  wrapped to a verified key.** If the invitee already has keys and the owner
  has verified them, from this or an earlier share, the owner's browser wraps
  at once. If the keys are only seen, or the invitee hasn't set up encryption
  yet, the invitation waits. The owner's next session completes it, but only
  for invitations it signed and only after the owner verifies the invitee's
  fingerprint. Both paths require the same comparison, so verification costs
  one comparison per person, not one per project. The comparison is mutual:
  the invitee verifies the owner's fingerprint in the same step, which anchors
  the project's roster for them. Sharing remains owner-only (ADR-019).
- **Invitation emails** name the sender, not the project.
- **Share links** become `#share=<token>.<key>.<owner>`, where `<owner>` is
  the full hash of the owner's identity key; the fragment never reaches the
  server. The share key is stored wrapped under the project key, so any
  editor's browser republishes the snapshot (current model, no history) on
  save. Each snapshot is a fresh project envelope with its own version key,
  as the nonce rules require. That version key is wrapped twice with AES-KW:
  under the project key for members, and under the share key for link
  visitors. The share key never encrypts content itself. Each snapshot is signed by its author. The visitor's browser fetches
  the signed roster (below), checks it chains to the owner key named in the
  link, and accepts the snapshot only if an owner or editor in that roster
  signed it. Revoking a link deletes the snapshot. "Make a copy" decrypts in
  the visitor's browser and saves under the visitor's keys, or locally.
- **Live editing** keeps leases, presence and roles. The room relays encrypted
  documents and orders versions. On a conflict it returns the base and the
  latest ciphertext; the browser merges with `mergeCollaborationDocuments`,
  moved to a shared package, and resubmits.
- **Removing a member** starts a new project-key epoch and a new roster entry.
- **Viewers** hold the project key, so they can decrypt, and they hold a valid
  signing key of their own. Read-only therefore cannot rest on the server
  alone, which this design treats as possibly compromised. Browsers enforce it
  through the signed roster.

### Signed roster

Each encrypted project has a roster: a chain of typed entries. Each type has
its own signer rule and its own limits on what it may change. A browser
rejects an entry whose signer or content breaks its type's rule:

| Entry type      | Who may sign it                                                 | What it may change                                                                                                                            |
| --------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Membership      | A certified device key of the owner                             | Add or remove members, change roles; when anyone loses access, the owner, a remaining member, generates the next epoch in the same entry      |
| Epoch           | A certified device key of any current member, including viewers | Nothing about membership; only a new project key wrapped to every listed member (see [Epoch rotation](#epoch-rotation))                       |
| Self-removal    | The departing member's device key, or their identity key        | Removes only the signer and carries no key; a remaining member then starts the next epoch (see [Identity replacement](#identity-replacement)) |
| Anchor transfer | The owner's old identity key                                    | Names the owner's new identity; members accept it only after verifying that identity outside OpenZCAD                                         |

Membership entries are the only ones that list members. The others apply to
the membership in force at their parent.
Each membership entry lists every member's user id, verified identity-key fingerprint and role
(owner, editor or viewer), the key epoch, a sequence number and the hash of the
previous entry. The owner's identity key, as verified by each member, anchors
the chain through the owner's device list. Browsers pin the newest roster entry they have seen, with the same
fork-consistency rule as versions.

Every project envelope names the roster entry it was written under. A browser
accepts a version only if:

- its author's device key is certified in that member's device list; if
  that device has since been revoked, the version must be within the
  revocation's cutoff for this project; and the named roster entry lists that
  member as owner or editor;
- that roster entry is the one in force for the version's parent, or a later
  one;
- the entry is the newest roster entry the browser has seen or one of its
  ancestors. A current head must also satisfy the rule above for the roster in
  force at its parent. A historical version is checked against the older
  roster entry it names, which is how it was valid when written, plus any
  revocation cutoffs learned since. A historical read never moves the roster
  pin, the same as for versions.

A version signed by a viewer, by a removed editor after the removal entry, or
by any key not in the roster is refused and reported, even if the server
accepted it. The same check covers share snapshots, named checkpoints and
merged versions written after a room conflict. ADR-019's server-side role
enforcement stays as defense in depth, and as the only enforcement on
plaintext projects.

### Identity replacement

A compromised identity must lose access at once, and its replacement gains
access only after a person has verified it. Two roster rules cover this.

- **Self-removal.** Any member may sign a roster entry that removes only
  themselves. It changes membership and nothing else. It never carries a
  project key, because whoever signs it may be an attacker holding the old
  identity, and would learn any key they chose. It can only reduce access,
  so it is safe to allow from a key the attacker also holds. When a member
  replaces an exposed identity, their browser uses the old identity, one
  last time, to sign a self-removal from every shared project.
- **Post-removal epoch.** After any entry that removes someone, whether a
  self-removal or an owner's membership entry, the next project key must be
  generated by a member who remains. The first remaining member's browser to
  see the removal starts that epoch, before any write. Readers refuse a
  version written after a removal unless it uses an epoch started after the
  removal by a device of a remaining member. So nothing written after a
  removal is ever under a key the departed identity chose or holds. This
  needs no owner: any remaining member, viewers included, can start it.
- **Owner re-adds.** The owner's browser shows the member's new identity as
  unverified. After the owner verifies it outside OpenZCAD, the owner signs a
  roster entry adding the new identity with the member's former role, and
  wraps the current project key to it. Until then the member can neither read
  new versions nor write.
- **An owner's own identity.** When the owner's identity is replaced, the
  roster's anchor changes. The owner's browser signs a self-removal of the old
  identity with an anchor-transfer entry naming the new one. Members keep
  refusing every roster or epoch entry signed by the new identity until they
  have verified it outside OpenZCAD. Until then they can still read existing
  content but treat the project as frozen: no writes, no new members. If the
  attacker holding the old owner identity signs conflicting roster entries,
  members see a fork and report it. The verified new anchor decides between
  the branches.

### Epoch rotation

A new project-key epoch is an entry in the roster chain that carries no
content. It holds the new project key wrapped to the current certified
encryption key of every member the roster lists. It is signed by a device key
of the member who started it. Any member may start one, not only the owner,
so a project never waits for an offline owner. Membership itself stays
owner-only, with the one exception below: an epoch entry cannot add, drop or
change anyone. Each browser
checks that its own wrap is present and that the wrapped set matches the
roster. An entry that leaves someone out is reported as an attack on
availability; it gives the starter no extra access.

Writers enforce the rotation. Before writing, a browser checks the device
lists of every roster member. If any member has revoked a device, replaced an
encryption key, or left the roster after the current epoch began, the browser
starts a new epoch first and writes under it. Readers refuse a version that still uses the
older epoch unless it is within the cutoff of every revocation they have seen.
Versions inside the cutoffs stay valid. So once any member's browser
has seen a revocation, no later content is written to keys the removed device
can open. The remaining gap is the one under
[Version integrity](#version-integrity): a server that hides a revocation from
everyone except the revoking browser can delay its effect on members it keeps
apart. The revoking browser itself always rotates first.

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

## MLS assessment

### Why

The custom design covers membership, per-project epochs, member key
distribution, device revocation, self-removal and owner hand-over. Ten review rounds each found real flaws in it: missing revocation cutoffs, rollback, key
substitution, epoch keys chosen by a departing member, and contradictions
between signer rules. These are exactly the problems MLS was designed and
analysed for. RFC 9420 gives a standard group key agreement: a ratchet tree of
members, numbered epochs, Add, Remove and Update proposals applied by a
Commit, Welcome messages for joiners, and forward secrecy and post-compromise
security. That replaces a protocol only this project would ever review.

### How it would map

Each encrypted project is one MLS group, and each device of each member is
one leaf. A leaf's credential is the device signing key, certified by the
user's identity key; this record's identity and contacts design acts as the
Authentication Service MLS assumes (RFC 9420 §3, §5.3.1). The collaboration
room is the Delivery Service, ordering handshake messages for the group. The
per-epoch project key becomes an MLS exporter secret (label
`openzcad project key`, context the project id). Everything this record
encrypts under the project key is unchanged.

| ADR-024 piece                                                               | With MLS                                                                                                                                                                                                                                                                        | Verdict                         |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Project key and its epochs; [Epoch rotation](#epoch-rotation)               | MLS epochs. The project key is exported per epoch. Any member's Commit starts a new epoch, so rotation never waits for an owner                                                                                                                                                 | Replaced                        |
| Encryption key pair; wrapping the project key to each member                | Per-leaf HPKE keys in KeyPackages and the ratchet tree. Joiners get secrets through Welcome                                                                                                                                                                                     | Replaced                        |
| [Signed roster](#signed-roster) membership and its entry-type table         | Group membership is the ratchet tree, agreed through the GroupContext tree hash. Roles (owner, editor, viewer) move into an application GroupContext extension                                                                                                                  | Replaced; roles stay app policy |
| Self-removal and the post-removal epoch rule                                | A Commit may not remove its own sender (§12.2), so another member commits a departing member's Remove (or a SelfRemove proposal from the MLS extensions work). The Commit's fresh path secret excludes the removed leaf, which is the rule the custom design had to add by hand | Replaced                        |
| Device lists, revocation cutoffs, device-removal rotation                   | Removing a device is a Remove of its leaf. Application content is signed by the sender's leaf key within an epoch, so a removed leaf cannot sign for later epochs                                                                                                               | Replaced                        |
| Owner anchor transfer                                                       | A GroupContext extension update naming the new owner, committed by the owner and accepted after members verify the new identity                                                                                                                                                 | Replaced, smaller               |
| Project state code (key-state part)                                         | The `epoch_authenticator` (§8.7), designed for exactly this out-of-band comparison                                                                                                                                                                                              | Replaced                        |
| Document version chain, current-head and historical reads                   | MLS orders key state, not stored documents                                                                                                                                                                                                                                      | Kept                            |
| Identity key, contacts list, verified pins, device approval, recovery       | MLS leaves identity binding to the Authentication Service                                                                                                                                                                                                                       | Kept                            |
| Envelopes, content blobs, nonces, decompression limits, dedupe, share links | Storage format and anonymous link access, outside MLS                                                                                                                                                                                                                           | Kept                            |

### What MLS does not give, and what it adds

- **History access.** MLS deletes old epoch secrets for forward secrecy. A CAD
  project must stay readable back to its first revision, and Welcome gives a
  joiner only the current epoch. So each epoch also stores an archive: the
  previous project keys, encrypted under the new exporter key. That
  deliberately trades forward secrecy for stored content, which members are
  meant to be able to read. Post-compromise security for later content
  remains.
- **Authorization.** MLS lets any member propose and commit (§3.2, §16.11).
  Every member's browser must reject, in commit validation, any Commit or
  proposal its sender's role does not allow. Viewers may commit only Updates
  of their own leaves and their own removal; only the owner adds members or
  changes roles. Rejecting commits from unauthorised senders is ordinary MLS
  application policy, and simpler than the typed roster it replaces.
- **Sequencing.** The Delivery Service must pick one Commit per epoch; the
  application must resolve conflicting Commits (§14). The room already
  serializes writes, so it accepts the first valid Commit for an epoch and
  rejects the rest, and the loser rebases. A malicious Delivery Service can
  still delay or withhold messages (§16.9), the same limit
  [Version integrity](#version-integrity) already states.
- **Binding versions to epochs.** A removed or downgraded member keeps the
  old project key, so a version could claim the old authority while naming
  the current head as its parent. Review found this hole in the custom roster
  as well. MLS fixes the key side, because the removal Commit gives later
  epochs keys the removed leaf never sees, but versions must use those epochs
  too. Every project envelope names the MLS epoch it was written in and is
  encrypted under that epoch's exported key. A version's epoch may never be
  older than its parent's. The room accepts a new current head only under the
  group's current epoch, and browsers check the role of the author's leaf in
  that epoch. A late signature under old authority is then refused, wherever
  it claims to sit. What remains is the fork-consistency limit already
  stated: a server that hides the removal Commit from some members.
- **Long-offline devices.** A device must process every Commit since it was
  last online, or rejoin. Rejoining uses an external Commit (§12.4.3.2), which
  policy allows only for the user's own certified devices. The same path
  covers a device whose browser storage was cleared.
- **A new dependency.** MLS needs a maintained implementation; this is not
  something to hand-write. It loads lazily, outside the entry chunk.

### Implementations

| Library                               | Notes                                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mls-rs` (AWS Labs, Rust, Apache-2.0) | Claims full RFC 9420 conformance and WASM builds. Its `mls-rs-crypto-webcrypto` provider runs on SubtleCrypto, which matches this record's WebCrypto-only rule. That provider's maturity and documentation need checking  |
| OpenMLS (Rust, MIT)                   | Independent SRLabs audit (sponsored by the Sovereign Tech Agency), published 2026-05-27: eight findings, one High; seven fixed in released versions. Browser use needs wasm-bindgen glue; no browser-specific audit found |
| `ts-mls` (TypeScript)                 | Pure TypeScript with `@hpke/core`, aimed at browsers. No independent audit found                                                                                                                                          |

Cipher suite `MLS_128_DHKEMP256_AES128GCM_SHA256_P256` (0x0002) keeps every
primitive on P-256, SHA-256 and AES-GCM, all native to WebCrypto. The
mandatory-to-implement X25519/Ed25519 suite (0x0001) is the fallback if a
library's P-256 path is weaker.

### Recommendation

Adopt MLS for group membership, epochs, member key distribution and device
removal. Keep this record's storage format, identity and verification layer,
recovery, share links and document version chain. Rust is already
built in this repository for the desktop shell, and the kernel already ships
as WASM, so a Rust WASM library adds a dependency, not a new toolchain.

Before Phase 3, a one-PR spike builds a two-member, three-device group in a
worker with `mls-rs` (WebCrypto provider) and OpenMLS. It measures lazy-chunk
size, IndexedDB state handling, suite 0x0002 support, external rejoin,
self-removal support and commit cost, then picks one. If adopted, the custom
pieces marked Replaced above are removed from this record, and Phases 3 and 5
are rewritten around MLS group operations. Phase 2 keeps only the envelope,
nonce, wrapping, decompression, dedupe and fingerprint work. Changes to the
custom key-management protocol stay paused until that decision.

## Delivery phases

Phase 1 moves the server logic into the browser while data is still plaintext,
so the existing Vitest, parity and Playwright suites prove the behavior before
any encryption lands. After that, encryption is a storage-format change.
Estimates are judgment, not measurement.

| Phase | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Estimate     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 0     | This ADR and roadmap row L11. A privacy policy page is a prerequisite for any public encryption claim; OpenZCAD has none yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 1 PR (this)  |
| 1     | Thin server, still plaintext: the browser creates projects, mints revisions and checkpoints, duplicates, branches and adopts, splits import assets and runs the room merge. Copy rollback and finalize compare client-supplied digests. The room conflict reply carries the base version. The server keeps size and envelope checks.                                                                                                                                                                                                                                                  | 5–6 PRs      |
| 2     | Crypto core package: envelope v1 with algorithm versioning, project envelopes and project-free content blobs, STREAM chunk nonces with one key per envelope, AES-256-GCM, HKDF, ECDH wrapping, authenticated-data binding, chunked blobs that detect truncation, fixed test vectors and a fuzzed envelope parser.                                                                                                                                                                                                                                                                     | 1 PR         |
| 3     | Keys and devices: identity keys, device lists with per-project revocation cutoffs, identity-signed contacts lists, certified device signing keys, D1 key tables, setup with a required recovery key, passkey unlock, device approval by QR scan or commitment-based code comparison, desktop Keychain storage and an Encryption section in Settings with identity-key certification of devices, device removal and recovery-key replacement with the rotations they require, and the sign-out choice. Setup screens load lazily (entry budget). Playwright fixtures seed device keys. | 4–5 PRs      |
| 4     | Encrypted projects, opt-in per account: documents, revisions, assets, names, thumbnails, measurements, view state and archived exports; the room relay; version-integrity checks. Each project records a format version so older builds say "update to open". Breaking storage and API change.                                                                                                                                                                                                                                                                                        | 2–3 PRs      |
| 5     | Sharing: owner-signed invitations, member key wraps, share links with fragment keys, the owner-signed roster with client-side role checks, new epochs on removal, member-started epoch rotation enforced by writers, seen and verified key pins, fingerprints, and the project state code.                                                                                                                                                                                                                                                                                            | 2–3 PRs      |
| 6     | Assistant consent on encrypted projects.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 1 PR         |
| 7     | Migrate existing projects: each owner's browser encrypts every revision and asset, then the server deletes the plaintext, including legacy `document_json` rows and the room's retained history. Beta-only reverse path for turning encryption off. Needs its own production authorization.                                                                                                                                                                                                                                                                                           | 1–2 PRs      |
| 8     | Default on; delete the server document pipeline and the off switch; keep a browser read path for legacy plaintext projects; update `docs/SELF_HOSTING.md`; outside review of the crypto and key flows.                                                                                                                                                                                                                                                                                                                                                                                | 1 PR, review |

Total: 18–23 PRs.

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
