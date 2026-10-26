# @openzcad/crypto

End-to-end encryption primitives for ADR-024, end-to-end encrypted projects
(roadmap L11, Phase 2). The ADR and its L11 roadmap row are proposed in
[esaueng/OpenZCAD#743](https://github.com/esaueng/OpenZCAD/pull/743); this
reference becomes a link to `docs/adrs/` once that lands. WebCrypto and web streams only, with no
dependencies, so the same code runs in browsers, Web Workers, the Tauri
WKWebView and Node 20+. Phase 3's account keys (device lists, unlock targets,
device approval) are its first application use; Phase 4 adds the project
data formats below (new envelope kinds, the version log, epoch bindings and
bodies), and Phase 5 sharing (contacts lists, share links and invitations).

All integers are big-endian. Every label below is UTF-8 and prefixed with
`OpenZCAD E2EE `, so `v1 wrap version-key` means the bytes of
`OpenZCAD E2EE v1 wrap version-key`. Each format starts with a version byte,
and a reader refuses a version it does not know (`unsupported-version`)
before doing any cryptography. A new algorithm, such as a hybrid post-quantum
seal, gets a new version byte; existing data never needs re-encrypting. Every
failure is an `E2eeError` with a stable `code`.

## Envelopes v1

Both classes share one layout:

```
"OZE" (4f 5a 45) | u8 version = 1 | u32 header length | header | chunk 0 | chunk 1 | …
```

Every header starts with `u8 class | u8 kind | u8 compression | u32 chunk size | u64 plaintext length`:

| Field            | Encoding                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| class            | 1 project envelope, 2 content blob                                                                                                                                  |
| kind             | project: 1 document, 2 measurements, 3 view-state, 4 share-snapshot, 5 project-info, 6 key-archive; content: 1 import-source, 2 mesh-payload, 3 thumbnail, 4 export |
| compression      | 0 none, 1 gzip (applied before encryption; the default)                                                                                                             |
| chunk size       | 64 B to 16 MiB (default 1 MiB); at least the prefix length when the prefix exceeds 1 KiB; at most 65,536 chunks of plaintext                                        |
| plaintext length | the exact size after decompression; part of the header, so every chunk's AAD binds it                                                                               |

A **project envelope** header continues with `u32 schema version | u32 key
epoch | u64 document version | u8 previous-version
hash length (0 or 32) + hash | 32-byte epoch binding hash | u8 length +
project id | u16 count + blob ids (u8 length + id each)`. Ids are 1–128 bytes
of printable ASCII. A project lists at most 4096 blob ids, without
duplicates, in the order given. Kind codes are append-only: `project-info`
(5) and `key-archive` (6) came after the first four, whose codes never move.

The epoch binding hash (`epochBindingHash`) occupies the 32 bytes Phase 2
called the roster entry hash; only the name changed, not a byte of the
layout or of any vector. It holds `epochBinding(projectId, keyEpoch,
epochAuthenticator)` (Codes, below). The key epoch is a monotonic
project-key generation: it names the project key the version key is wrapped
under and keeps increasing across identity-authorized group resets, so it is
not the epoch number of any one MLS group.

A **content blob** header continues with only `u8 length + blob id`. It names
no project, so the server can copy it byte for byte into another project.

Call everything before chunk 0 the _prefix_.

### Keys and nonces

- **One key, one envelope.** Each envelope is encrypted under a fresh random
  256-bit `EnvelopeKey`, used directly as the AES-256-GCM key. The encoder
  consumes the key and refuses it a second time (`key-reused`). Decryption
  takes the raw 32 bytes.
- **STREAM chunks.** The payload is split into chunk-size pieces; the last may
  be shorter, and an empty payload is one empty chunk. Chunk _i_ uses the
  nonce `uint88_be(i) || last`, where `last` is `0x01` on the final chunk only,
  so a one-chunk body is chunk 0 with `last = 0x01`. Its AAD is the prefix
  followed by `u32 i`.
- Each chunk is ciphertext plus the 16-byte tag, so chunk _i_ starts at
  `prefix length + i × (chunk size + 16)`. Multipart parts and ranged reads
  need no alignment with chunks.

Changing any header byte, dropping, reordering or duplicating a chunk, cutting
the file short, or moving a chunk or body into another envelope fails
authentication. `parseEnvelope` checks structure without a key, which is all a
server can do; `parseEnvelopeShape(head, length)` runs the same checks from the
prefix and the total length, for a body held in an object store.

### Decompression limits

A small, highly compressible envelope from a buggy or hostile editor could
otherwise exhaust the browser before any validator runs. `decodePayload`,
which every decrypt path uses, prevents that:

- It inflates gzip as a stream and stops the moment output passes the
  smaller of the declared plaintext length and the kind's ceiling
  (`PLAINTEXT_CEILINGS`). That returns `limit-exceeded`.
- It fails with `malformed` unless the result is exactly the declared length.

| Kind                                | Ceiling | Source                                                   |
| ----------------------------------- | ------- | -------------------------------------------------------- |
| document, share snapshot            | 24 MiB  | `MAX_CLOUD_PROJECT_DOCUMENT_BYTES`                       |
| measurements                        | 512 KiB | `MAX_PROJECT_MEASUREMENT_BYTES`                          |
| view state                          | 1 MiB   | judgment: camera and saved views only                    |
| project info, key archive           | 1 MiB   | judgment: names and references; keys and an epoch record |
| thumbnail                           | 512 KiB | `MAX_THUMBNAIL_BYTES`                                    |
| import source, mesh payload, export | 128 MiB | `MAX_SOURCE_IMPORT_BYTES`, `MAX_ARTIFACT_DOWNLOAD_BYTES` |

`MAX_ARTIFACT_UPLOAD_BYTES` (1 GiB) is a storage reservation and is never a
decompression limit. Both classes declare their exact length in the header,
and a content blob's `ContentBlobReference` must agree with it
(`context-mismatch` otherwise). Writers and the stream encryptor take the
size up front and refuse plaintext that ends up longer or shorter.
Encryption refuses anything above the ceiling, and a test pins the ceilings
to the constants they mirror.

### What authenticates what

- **Project envelopes** are decrypted with `decryptProjectEnvelope` and an
  `expect` object (project, kind, version, epoch, schema, previous-version
  hash, epoch binding hash); an authentic envelope that differs is refused
  with `context-mismatch`. Their version keys are wrapped under the project
  key (`version-key` below).
- **Content blobs** are authenticated by the project envelope that references
  them. Its encrypted body carries a `ContentBlobReference` for each blob:
  the blob id, kind, random key, ciphertext hash and plaintext length. The
  ciphertext hash is computed while streaming, with bounded state however
  many chunks the blob has: `h = SHA-256(label "v1 content blob hash")`, then
  for the prefix and each chunk in order `h = SHA-256(h | SHA-256(part))`.
  A blob swapped in from elsewhere fails decryption or the hash; one with the
  right key but the wrong id or kind fails with `context-mismatch`.
  `checkBlobReferences` checks that the header's blob ids and the body's
  references agree. `contentBlobReferenceToJson` gives a JSON form with
  base64url bytes. Copying a project re-encrypts only the project envelope,
  with the same references, while the server copies the blobs.

`createContentBlobWriter`, `createContentBlobReader` and the
`encryptContentBlobStream`/`decryptContentBlobStream` helpers process large
blobs incrementally. Streamed plaintext is unconfirmed until the stream
closes cleanly, because only the final chunk and the hash prove that nothing
was cut off or swapped. The `reference` promise from `encryptContentBlobStream` always
settles: it resolves when the envelope finishes, and it rejects with
`aborted` if the source fails or the consumer cancels.

A content blob's id is fresh and random. The one exception is
`ContentBlobOptions.blobId`, for storing again a blob the account lost or
collected while a document still names it by that id: the blob is encrypted
under a fresh key, so one key still encrypts exactly one envelope, and the
new reference (new key, new ciphertext hash) replaces the old one in the
next version that names the blob.

## Versions and signatures

- `versionHash(envelope)` is SHA-256 of a whole project envelope. The next
  version stores it as its previous-version hash.
- `verifyVersionChain` checks that envelopes link by hash with rising
  versions in one project, and that they contain the newest version this
  browser has pinned. That refuses rollback and forks. One call takes at
  most 1,024 versions and 256 MiB (`MAX_CHAIN_ENVELOPES`, `MAX_CHAIN_BYTES`),
  since it copies what it checks; check a longer history in overlapping
  windows, pinning the newest hash of each.
- `signProjectEnvelope` signs, with ECDSA P-256 / SHA-256,
  `label "v1 version signature" | u32 prefix length | prefix | versionHash | u64 signedAt`.
  The signature is `u8 version = 1 | u64 signedAt (Unix ms) | r ‖ s`, and
  verification returns the signed timestamp. Which keys may sign is up to the
  caller.
  The version hash is SHA-256 over the serialized prefix followed by every
  chunk's ciphertext and tag. A signature over the header alone would not
  be enough: any member holding the symmetric key can re-encrypt altered
  content under the same header with valid tags, and a test shows such a
  forgery fails verification.

### Version log

An autosave overwrites the previous envelope, so a browser cannot walk the
hash chain through versions the server no longer keeps. The server instead
keeps a version log: one record per signed envelope it ever accepted.

```
"OZV" (4f 5a 56) | u8 version = 1 | u32 prefix length | prefix | 32-byte versionHash | u8 signature length | signature
```

`versionLogRecord(envelope, signature)` builds a record and
`encodeVersionLogRecord`/`decodeVersionLogRecord` serialize it. The v1
signature covers exactly `label | prefix | versionHash | signedAt`, so a
record verifies without the envelope body. `verifyVersionLog(records,
{ pinnedVersionHash, projectId, resolveSigningKey })` checks, oldest first:
one project and one kind; strictly increasing document versions; each
record naming the previous record's version hash (a missing record breaks
this); key epochs that never decrease; the pinned version present (rollback
or fork otherwise); and each signature under the key the resolver returns
for that record's header. The v1 signature names no signer, so the caller
pairs each record with its author. Each refusal is a `VersionLogError` with a
`reason` (`empty`, `project-mismatch`, `kind-mismatch`,
`version-not-increasing`, `previous-hash-mismatch`, `epoch-decreased`,
`signer-unknown`, `signature-invalid`, `pinned-missing`) and the record
index; its `code` is `authentication-failed` for the two signature reasons
and `chain-broken` otherwise. One call takes at most 4,096 records and
64 MiB.

`verifyAuthoredEnvelope(envelope, signature, { deviceLists, cutoffs })` (and
`verifyAuthoredLogRecord` for a record) finds the device signing key, among
the live and revoked devices of the given verified device lists, that signed
the version. A revoked device is accepted only at or before its cutoff for
this project, which the caller passes in a map keyed by
`authorCutoffKey(userId, deviceId)`: below the cutoff's document version, or
the cutoff version itself by hash. Refusals are `AuthorshipError`s
(`unknown-signer`, `ambiguous-signer` when two lists certify the same key,
`revoked-without-cutoff`, `outside-cutoff`), all `authentication-failed`. Both copy and check the
record, the device keys and every cutoff (each hash buffer included) before
their first await, so a caller editing the map meanwhile changes nothing. A
stolen device picks its own version numbers, so a version below a cutoff is
trusted only once the caller also shows it is an ancestor of the cutoff
head, for example with a version log that contains both.

### Bodies

Project envelope bodies are UTF-8 JSON with `version: 1` (2 for a document
body that carries share links, below), written by the
encoders and read strictly by the decoders: unknown or missing fields, wrong
types and sizes are `malformed`, a newer `version` is `unsupported-version`,
and a body over its kind's ceiling, or nested past a lexical depth and
separator limit checked before `JSON.parse`, is `limit-exceeded`. Bytes are
unpadded canonical base64url. Every encoder and decoder runs
`checkBlobReferences` against the envelope header, so a body referencing a
blob the header omits, or the reverse, is refused (`context-mismatch`).

| Body                    | Kinds                    | Fields                                                                                                                                             |
| ----------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EncryptedDocumentBody` | document, share-snapshot | `document` (object), `blobs` (references), `revisionVersionHashes` (revision id → lowercase hex); version 2 adds `shareLinks` (document kind only) |
| `ProjectInfoBody`       | project-info             | `name`, optional `thumbnail` reference, `exports` (`ref`, `fileName`, `contentType`, flat `metadata`)                                              |
| `KeyArchiveBody`        | key-archive              | `previousKeys` (`keyEpoch`, `key`), `dedupeSecret`, `epochRecord`, `epochAuthenticator`; no blob refs                                              |
| `MeasurementsBody`      | measurements             | `record` (object: the app's stored measurement record); no blob refs                                                                               |
| `ViewStateBody`         | view-state               | `session` (object: one workspace session); no blob refs                                                                                            |

A document body is version 2 exactly when it carries the project's active
share-link set, `shareLinks: { grants: [{ grant, signature }], tombstones:
[{ tombstone, signature }] }` (base64url statement and signature bytes, see
[Share links](#share-links)), even an empty one; without it the encoder
writes version 1, byte for byte as before, and the version 1 decoder is
unchanged. Each list is sorted by link id with each id at most once, no id
is both granted and tombstoned (`context-mismatch`), and no entry names a
key epoch after the envelope's (`context-mismatch`). A share snapshot never
carries a link set: the encoder refuses one (`invalid-argument`) and the
decoder refuses a version 2 body under a share-snapshot header
(`context-mismatch`), so link visitors never see the other links. The body
codec checks structure only; `verifyShareLinkSet` checks the signatures.

`revisionVersionHashes` lets a historical read prove that a retained
revision belongs to this history through the signed head, instead of a chain
walk through overwritten autosaves. A key archive's previous keys are
strictly ascending and older than its own key epoch (`context-mismatch` on
read). Project info and key archives also accept only their canonical
encoding; the document, the measurement record and the workspace session are
checked by the app's own validators after decoding.

Project info, measurements and view state are replaced as a whole. Their
header's document version is their sequence (the measurements' revision),
which the server stores in plaintext to fence writes. Project info and
measurements name the previous envelope's hash as their previous-version
hash (none for the first), so each forms its own chain; view state names
none.

Device lists and contacts lists live here (below). The custom roster is
parked on the `claude/e2ee-chains` branch: MLS (RFC 9420) replaces the
roster and epochs.

## Key wrapping

| Format       | Bytes                                                                  | Key                                                                                         | Binding                                       |
| ------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Wrap 2 (KW)  | `u8 2 \| 40-byte AES-KW output`                                        | AES-256-KW, KEK = HKDF-SHA256(parent key, empty salt, `v1 kw <purpose>` ‖ context)          | context in the KEK; RFC 3394 integrity        |
| Wrap 1 (GCM) | `u8 1 \| 12-byte random IV \| ciphertext+tag`                          | AES-256-GCM, KEK = HKDF-SHA256(parent key, empty salt, `v1 wrap <purpose>`)                 | AAD `u8 1 \| context`                         |
| Seal 1       | `u8 1 \| 65-byte ephemeral public key \| 12-byte IV \| ciphertext+tag` | HKDF-SHA256(ECDH(ephemeral, recipient), ephemeral key ‖ recipient key, `v1 seal <purpose>`) | AAD `u8 1 \| ephemeral public key \| context` |

Symmetric 32-byte keys are wrapped with AES-KW, which takes no nonce. The
context is bound by deriving the KEK from it, so a wrap opens only for the
context it was made for. Private keys use AES-GCM with a fresh random 96-bit
IV, because PKCS #8 keys are not a multiple of 8 bytes, which AES-KW
requires. A known format used for the wrong purpose is `malformed`. Public
keys are raw uncompressed P-256 points (65 bytes). The context is a
`WrapContext`, encoded canonically: fields sorted by name, each as
`u8 name length | name | u8 type | value`, where type 1 is a `u16`-length
UTF-8 string and type 2 a u64.

| Purpose                  | Format | Fields                                    | Wrapped by                                                                                                               |
| ------------------------ | ------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `account-key`            | Seal   | userId, method, unlockId                  | sealed to each certified unlock target: device unlock key, recovery-key or passkey target; or to a device being approved |
| `identity-key`           | Seal   | userId, method, unlockId                  | sealed to the recovery-key or a passkey target only (PKCS #8 bytes)                                                      |
| `unlock-target-key`      | GCM    | userId, method, unlockId, identityKeyHash | a target's private half (PKCS #8) under its secret: the recovery key or a passkey PRF output                             |
| `encryption-private-key` | GCM    | userId, keyId                             | account key (PKCS #8 bytes)                                                                                              |
| `project-key`            | KW     | userId, projectId, keyEpoch               | sealed to a member; then the member's account key                                                                        |
| `version-key`            | KW     | projectId, keyEpoch, kind, versionId      | project key                                                                                                              |
| `dedupe-secret`          | KW     | projectId, keyEpoch                       | project key: the dedupe secret, carried across epochs                                                                    |
| `share-key`              | KW     | projectId, keyEpoch, shareId              | project key; it never encrypts content                                                                                   |
| `share-version-key`      | KW     | projectId, keyEpoch, shareId, versionId   | share key: a share snapshot's version key, for link visitors                                                             |
| `rejoin-psk`             | KW     | userId, projectId, keyEpoch               | account key: an MLS epoch's rejoin PSK, for an External Commit after losing MLS state                                    |
| `archived-project-key`   | KW     | projectId, archivedEpoch, underEpoch      | a later epoch's project key: an earlier project key; `archivedEpoch` must be below `underEpoch`                          |
| `previous-account-key`   | KW     | userId, generation, keySequence           | the new account key: the account key it replaced, so older account-key wraps stay reachable                              |

`version-key` accepts every project envelope kind, `project-info` and
`key-archive` included. Integer fields are u32 values encoded as u64.

A `rejoin-psk` wrap binds
the key epoch of the MLS epoch the PSK was exported in (group key epoch
base plus MLS epoch), not the MLS epoch: MLS epochs restart at 0 after an
identity-authorized group reset, so two generations' PSKs of the same MLS
epoch would otherwise share a context, and a server could serve one as the
other. The MLS epoch follows from the key epoch and the group's base.
`rejoin-psk` bound the MLS epoch until Phase 5, before any rejoin-PSK wrap
was stored.

Every unlock method is a public-key target (ADR-024, Unlock and devices), so
a rotation can re-seal a new account key to every target without knowing any
method's secret. Sealing is therefore limited to three purposes
(`SealContext`): the account key to a certified unlock target or a device
being approved, the identity key to the recovery-key or a passkey target
(its context schema has no device method), and a project key to a member.
Any other purpose is refused (`invalid-argument`). A target's own private
half is wrapped under the method's secret as `unlock-target-key`, whose
context binds the identity key hash, so a server cannot pair a genuine
target with an identity of its own.

`wrapShareSnapshotKey` wraps a share snapshot's fresh version key twice:
under the project key for members (`version-key`, kind `share-snapshot`) and
under the share key for link visitors. Both wraps bind the snapshot's key
epoch and `versionId`, so neither can be replayed onto another snapshot.
`share-version-key` gained `keyEpoch` in Phase 5, before any code wrote
one. A link's share key is wrapped under each key epoch's project key
(`share-key`, one wrap per epoch, since the epoch is bound); `openShareKey`
unwraps it and checks it against the `shareKeyHash` the owner's grant
names (`context-mismatch` otherwise). No share context uses a counter that
restarts: key epochs rise across group resets, and a link id is never
reused (a tombstone is permanent). Blob keys are not wrapped; they travel
inside the project envelope. Unlock secrets are imported as non-extractable
HKDF keys, so a device key in IndexedDB never exposes its bytes. The passkey
PRF input is `passkeyPrfInput()`, a fresh copy on each call.

### Security notes

- **AES-KW integrity does not rely on the engine.** Playwright's Windows
  WebKit build skips RFC 3394's integrity check: an AES-KW unwrap under the
  wrong KEK, or of a tampered wrap, returns a zeroed key instead of
  throwing. Since the KEK carries the context, such an engine could detect
  neither a wrong context nor tampering. AES-KW is deterministic, so
  `unwrapKey` wraps the unwrapped key again under the same KEK and compares
  the result with the input in constant time, refusing any difference with
  `authentication-failed`. This covers every KW purpose. The wire format and
  the KW vectors are unchanged, and a test stubs a non-verifying engine to
  prove the refusal.

## Codes

- **Asset de-duplication:** lowercase hex HMAC-SHA256 keyed by a random
  per-project dedupe secret (`generateAssetDedupeSecret`,
  `importAssetDedupeSecret`). The secret is not derived from the project key,
  so hashes stay stable across epochs: it is carried into each new epoch
  wrapped under that epoch's project key (`dedupe-secret`, AES-KW). The hash
  is an index value stored beside the blob, never inside an envelope.
- **Key hash:** `publicKeyHash` is the full
  `SHA-256(label "v1 public key hash" | u8 key count | keys)`. Over the
  identity key it is the user's fingerprint (`identityFingerprint`).
  `contactVerificationCode` covers an identity key together with a 32-byte
  device-list head hash. Nothing people compare is
  shorter than 128 bits: the comparison code is 40 digits in eight groups of
  five (132.9 bits).
- **Project state code:**
  `SHA-256(label "v1 project state" | newest versionHash | u64 version | signer identity key hash)`,
  shown with `formatComparisonCode`.
- **Epoch binding:** `epochBinding(projectId, keyEpoch, epochAuthenticator)`
  is `SHA-256(label "v1 epoch binding" | u8 length + project id | u32 key epoch | u8 length + epoch authenticator)`,
  where the authenticator is the MLS `epoch_authenticator` (RFC 9420 §8.7,
  32–64 bytes) of the epoch whose exported key the version is written
  under. Every project envelope header carries it as `epochBindingHash`.
- **Device approval, scan form:** the new device shows `pk_new =
deviceKeysHash(signing, unlock)`, the `publicKeyHash` of both its public
  keys, as a QR code, and the approver checks the pair the server delivered
  with `verifyScannedDeviceKey([signing, unlock], scanned)`. Every approval
  function takes the key pair as an array and binds `pk_new` (32 bytes); a
  single raw key (65 bytes) is still bound as itself, so the two never
  collide.
- **Device approval, compare form:** the new device sends
  `SHA-256(label "v1 device approval commitment" | pk_new | n_new)` first. Only
  after it receives the approver's key and nonce `n_app` does it reveal
  `n_new`, which the approver checks against the commitment. Both show six
  digits: `SHA-256(label "v1 device approval code" | pk_new | pk_app | n_new | n_app)`
  read as a u32 modulo 10⁶. This is the only short code, and the commitment
  is what makes it safe.
- **Recovery key:** the 32-byte secret plus the first 3 bytes of its SHA-256,
  as 56 Crockford base32 characters in hyphenated groups of four. Parsing
  ignores case, spaces and hyphens and reads O as 0 and I or L as 1.

## Device lists

A user's device list is a hash chain of entries signed by their identity key
(`v1 device list signature`, `u8 1 | r ‖ s`). Each entry is a full snapshot:

```
"OZD" | u8 1 | u32 sequence | u8 (0|32) + previous entry hash | u8 length + user id
| u64 issuedAt | u8 (0|32) + replaced identity key hash | 65-byte encryption key
| 32-byte account key commitment
| u16 count + devices by id (u8 length + id, u8 length + UTF-8 label, 65-byte signing key, 65-byte unlock key, u64 addedAt)
| u16 count + unlock targets by id (u8 kind 1 recovery-key / 2 passkey, u8 length + id, 65-byte key, u64 addedAt)
| u16 count + revocations by kind, then id (u8 kind 1 device / 2 unlock target, u8 length + id)
```

Version 2 adds `u8 length + replacement device id` (0 for none) after each
revocation id. A device revocation may name the device that replaces it
(`replacedBy`, which must be live in the same entry); an entry uses version
2 exactly when one does, so each entry has one encoding and version 1 lists
verify unchanged. `verifyDeviceList` reports the replacement on the revoked
record. `accountKeySequence` names an account key by the entry that first
committed to it, which is the `keySequence` of its `previous-account-key`
wrap.

`deviceListEntryHash` is `SHA-256(label "v1 device list entry hash" | entry)`.
`accountKeyCommitment` is `SHA-256(label "v1 account key commitment" | key)`;
every unlock checks the opened account key against it. `verifyDeviceList`
enforces, oldest first: canonical bytes, the identity signature, sequence 0
then +1 with the previous hash, one user, real P-256 points, exactly one
recovery-key target fixed for the life of the identity, an explicit
revocation for anything dropped, a rotated encryption key and account key in
any entry that revokes, and no revoked id or key (or replaced encryption or
account key) ever returning. With a pin (identity key hash, sequence, entry
hash) it refuses another identity (`context-mismatch`) and a list that does
not contain the pinned entry (`chain-broken`). `nextDeviceListEntry` builds
the next entry from a verified head.

Four statements travel beside lists. An identity transition (`"OZT"`) names
the old identity hash, the new identity key and its first entry's hash, and
is signed by the old identity or a device it certified; it proves nothing to
contacts. A device approval grant (`"OZG"`) is signed by the approving
device's key and names the approved device's `pk_new`, the identity and the
device-list head the new device should pin, and whether it was certified
(`"OZG" | u8 version | u8 length + user id | 32-byte pk_new | u8 length +
device id | 32-byte identity key hash | u32 head sequence | 32-byte head hash
| u8 certified | 32-byte approver key hash | u64 issuedAt`, signed with `v1
device approval grant signature`). Version 2 appends the approver's newest
contacts head, which the approved device pins so a server cannot show it an
older contacts list (ADR-024, verified pins): `u8 flags (1 head present, 2
confirmed) | head present only: u32 contacts sequence | 32-byte contacts
entry hash`. No head means the approver has seen the list only empty;
confirmed means the approver's own pin descends from a trusted start
(setting up the identity, or an earlier approval) rather than only from the
server, and the approved device inherits it. Version 1 grants from older
builds still decode, with no contacts head; a grant built without one is
encoded as version 1, byte for byte. Builds that know only version 1 refuse
a version 2 grant (`unsupported-version`), so an approving device on this
build cannot approve one still running an older page until it reloads.
Revocation cutoffs (`"OZR" | u8 1 | u8 length + user id | u32 generation |
u32 entry sequence | 32-byte entry hash | u64 issuedAt | u16 count + (u8
length + project id, u64 cutoff epoch) by project id`, signed with `v1
revocation cutoffs signature`) are signed by the identity key at a device
removal and name, per project, the first epoch the revoked device must not
know. `verifyRevocationCutoffs` requires the identity signature, the list's
user and generation, and an entry of that list, by sequence and hash, that
revokes a device. Phase 4 stores and enforces them. A solo group reset
(`"OZX" | u8 1 | u8 length + user id | u32 generation | u32 entry sequence
| 32-byte entry hash | u8 length + project id | u32 prior group generation
| u64 prior key epoch | u64 issuedAt`, signed with `v1 group reset
signature`; decision D9) is signed by the identity key and names the
replaced group's generation and newest key epoch, so the new group's key
epochs continue after it (decision D10).

## Contacts lists

A user's verified pins for other people's keys (ADR-024, Version integrity)
live in an identity-signed, hash-chained contacts list, so a server cannot
roll a verified pin back to a key that was since replaced:

```
"OZK" (4f 5a 4b) | u8 version = 1 | u32 sequence | u8 (0|32) + previous entry hash
| u8 length + user id | u64 issuedAt | u8 action | u8 length + contact user id
| 32-byte contact identity key hash
| verify and advance only: u32 device-list sequence | 32-byte device-list entry hash
```

Actions are 1 `verify` (the user compared `contactVerificationCode` over the
contact's identity key and device-list head, and pins both), 2 `advance`
(moves a verified contact's pinned head forward), 3 `key-changed` (the
verified identity was replaced; the contact is unverified again) and 4
`untrust`. Only a verified contact can advance, change or be untrusted, and
only under the identity it was verified with; a contact verified under one
identity must have its key change recorded before another identity is
verified. An entry's hash is `SHA-256(label "v1 contacts entry hash" |
entry)`, and the identity key signs `label "v1 contacts list signature" |
entry` (`u8 1 | r || s`). `verifyContactsList` checks the whole chain under
the identity key and, with a pin, refuses a rolled-back or forked list
(`chain-broken`) or another identity (`context-mismatch`).
`contactDeviceListPin` turns a verified contact into the `DeviceListPin`
their device list must extend.

## Share links

ADR-024, Sharing and collaboration. A link is
`#share=<token>.<key>.<owner>`: `<key>` is the 32-byte share key and
`<owner>` the owner's `identityFingerprint` (`publicKeyHash` of the
identity key). The share key never encrypts content; it wraps each share
snapshot's version key (`share-version-key`). Its hash is
`shareKeyHash(key) = SHA-256(label "v1 share key hash" | key)`.

Four stored signed statements, each `magic | u8 version = 1 | …`, canonical (one
encoding; lists sorted and without duplicates), with a signature
`u8 1 | r || s` over `label "v1 <kind> signature" | statement`:

| Statement (kind)                                | Signed by                            | Bytes after `magic \| u8 1`                                                                                                                                                                                                                                             |
| ----------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"OZS"` share delegation (`share delegation`)   | the owner's identity key             | 32-byte owner identity key hash \| u32 sequence \| u64 issuedAt \| u64 expiresAt \| u8 count (1–64) + 65-byte device signing keys, bytewise sorted                                                                                                                      |
| `"OZA"` share-authority (`share authority`)     | an owner device the delegation names | u8 len + project id \| u8 len + link id \| 32-byte share key hash \| u8 mode (1 view, 2 tweak) \| 32-byte owner identity key hash \| u32 sequence \| u64 issuedAt \| u64 expiresAt \| 32-byte signer key hash \| u16 count (1–2048) + 32-byte author key hashes, sorted |
| `"OZL"` link grant (`share link grant`)         | an owner device                      | u8 len + project id \| u8 len + link id \| 32-byte share key hash \| u8 mode \| u32 key epoch \| u64 issuedAt \| 32-byte signer key hash                                                                                                                                |
| `"OZY"` link tombstone (`share link tombstone`) | an owner device                      | u8 len + project id \| u8 len + link id \| u32 key epoch \| u64 issuedAt \| 32-byte signer key hash                                                                                                                                                                     |

A fifth, `"OZW"` share-key wrap (`share key wrap`), is never stored: a
certified owner or editor device signs `u8 len + project id | u8 len + link
id | u32 key epoch | u8 len + wrap` when it stores a link's share key under
an epoch's project key, and the server rebuilds the bytes from the request
and checks the signature against that device's current certified key
before keeping the first wrap for the epoch.

A sixth, `"OZF"` link forget (`share link forget`), is never stored either:
a certified owner device signs `u8 len + project id | u8 len + link id |
u32 key epoch` (the project's current key epoch) when it asks the server to
forget a link it tombstoned, and the server rebuilds the bytes from the
request, refuses any other epoch than the current one and checks the
signature against that device's current certified key before dropping the
link's snapshot, key wraps and statement, so an owner device removed while
its session stays signed in cannot break the links. The link id binds the
signature to one link (ids are never reused).

A seventh, `"OZN"` link registration (`share link registration`), is never
stored either: a certified owner device signs `u8 len + project id |
u8 len + link id | 32-byte token hash | u8 mode | 32-byte share key hash |
32-byte owner identity key hash | u32 key epoch | u8 len + wrap` (the token
hash the server keeps, the project's current key epoch and the share key
wrapped under its project key) when it asks the server to register a link
it granted, and the server rebuilds the bytes from the request, refuses any
other epoch than the current one and checks the signature against that
device's current certified key, fenced on that device list's head, before
storing the link and its first wrap. An owner device removed while its
session stays signed in cannot register links, nor fill the project's
live-link limit.

Key hashes are `publicKeyHash` of a device signing key, as
`DeviceRecord.signingKeyHash` names it. Statements a visitor sees name no
user id. Times are Unix milliseconds:

- A **delegation** lasts at most 30 days (`expiresAt - issuedAt`), a
  **share-authority statement** at most 7. Encoding refuses longer
  (`invalid-argument`), decoding too (`malformed`). A verifier refuses one
  at or past `expiresAt`, or issued more than `SHARE_CLOCK_SKEW_MS` (10
  minutes) after its `now`.
- The delegation carries the device keys whole, so a visitor needs no
  device list; the statement names its signer and the authors by hash.
- A **grant**'s key epoch is the project key epoch it was made in; a set
  never holds an entry from a later epoch than its version, and a resolver
  can judge a revoked owner device's entries against its revocation cutoff.

`verifySharedSnapshot` is the visitor's check, in the ADR's order: the
served identity key hashes to `<owner>`; the delegation is identity-signed
and valid now; the statement's signer is a delegated key; the statement's
signature, validity now, owner, and share key hash (it must be the link's
key); the snapshot's signing key is one the statement names; the snapshot
signature; and the envelope is a `share-snapshot` of the statement's
project. Only then does the visitor unwrap the version key with the share
key and call `decryptProjectEnvelope`. The snapshot comes with its author's
public key, since the statement names authors only by hash.

`verifyShareLinkSet(set, { projectId, keyEpoch, resolveOwnerKey,
seenTombstones, previous, authorIsOwner })` checks a document's link set:
each grant and tombstone is for this project, from no later epoch than the
version, and signed by the owner key `resolveOwnerKey` returns for its
signer hash; no granted id is tombstoned, in the set or among
`seenTombstones`; with `previous` (the parent's verified set), no
tombstone is dropped and, unless `authorIsOwner`, the set is unchanged
(`sameShareLinkSet`). Refusals are `ShareLinkError`s with a `reason`
(`owner-mismatch`, `delegation-signature`, `delegation-expired`,
`delegation-not-yet-valid`, `signer-not-delegated`, `authority-signature`,
`authority-expired`, `authority-not-yet-valid`, `link-mismatch`,
`author-not-named`, `snapshot-signature`, `snapshot-mismatch`,
`unknown-signer`, `grant-signature`, `tombstone-signature`,
`grant-mismatch`, `tombstoned`, `tombstone-dropped`, `changed-by-editor`).
Their `code` is `authentication-failed` for a bad signature or an
unauthorized signer, `chain-broken` for a dropped tombstone, and
`context-mismatch` otherwise, expiry included.

## Project invitations

An invitation to an encrypted project (ADR-024, Sharing and collaboration;
Phase 5) is a statement the owner's certified device signs with
`v1 project invitation signature`:

```
"OZI" (4f 5a 49) | u8 version = 1 | u8 length + project id | u8 length + invitation id
| u8 length + inviter user id | 32-byte invitee email hash | u8 role (1 editor, 2 viewer)
| u64 issuedAt | u64 expiresAt | u8 length + signer device id | 32-byte signer key hash
```

`invitationEmailHash(email)` is `SHA-256(label "v1 invitation email hash" |
UTF-8(lowercase(trim(email))))`, so the statement and the server's stored
invitation hold a hash, not the address. An invitation lasts at most seven
days. `verifyProjectInvitation(signed, signerKey, { now, expected })` takes
the signing device's key from the owner's verified device list and checks,
in order, canonical bytes, that the key's `publicKeyHash` is the named
signer, the signature, `now` within `[issuedAt - 10 min, expiresAt)`, then
the expected project, invitation, inviter and email hash. Refusals are
`ProjectInvitationError`s with a `reason` (`signature`, `signer-mismatch`,
`expired`, `not-yet-valid`, `context-mismatch`).

## Tests

`vectors.test.ts` holds fixed vectors built from injected keys, blob ids, IVs,
ephemeral keys and timestamps, including version 1 and 2 device-list
entries, a recorded revocation-cutoffs signature, a contacts entry with a
recorded identity signature, a paired approval commitment, the project-info and key-archive kinds, the three
project-data wraps, an epoch binding, a version log record, a key archive
body, and the share-link formats: a share key hash, a delegation, a
share-authority statement, a grant and a tombstone with recorded signatures
checked by raw WebCrypto, a version 2 document body, and the `share-key` and
`share-version-key` wraps, and an invitation email hash and statement with a
recorded signature. It also re-derives the nonce layout, both envelope classes, the content
blob hash, the wrap and the epoch binding with raw WebCrypto. A
change to a vector is a format change and needs a new version byte.
`fuzz.test.ts` mutates valid inputs, version log records, contacts entries,
share-link statements and bodies (version 2 included) and invitation
statements, and requires every parser to fail only with `E2eeError`. Functions that inject keys or randomness (`…With`,
`envelopeKeyFromBytes`) are test-only and are not exported from the package
entry.

### Real browsers

The Vitest suites run on Node's WebCrypto. `browser/scenarios.ts` runs the
package on each browser engine's own WebCrypto and web streams instead:
project envelopes and content blobs over many chunks (one-shot, incremental
writer and reader, and streams, with and without gzip), tampering, truncation
and a gzip bomb; AES-KW and AES-GCM wraps, including a PKCS #8 private key
and a non-extractable unlock key, and the refusals of every AES-KW purpose;
sealing and opening; project-envelope, version-chain, device-list,
approval-grant and identity-transition signatures; the project data formats
(`project-info` and `key-archive` envelopes with their bodies, the epoch
binding, the document body's revision hashes, the `rejoin-psk`,
`archived-project-key` and `previous-account-key` wraps, and
`verifyVersionLog` and `verifyAuthoredLogRecord` with their refusals); the
external-key seam (`ecdsaSign`, `ecdhDeriveBits` through a host stand-in);
and the fixed vectors from `vectors.test.ts`, which must come out
byte-identical in every engine.

```bash
pnpm exec playwright install chromium webkit firefox   # once
pnpm --filter @openzcad/crypto test:browser            # Chromium, WebKit, Firefox
pnpm --filter @openzcad/crypto test:browser -- --chromium-only
pnpm --filter @openzcad/crypto test:browser -- --browsers=chromium,firefox --verbose
```

It builds the page with the web app's Vite, serves it on `127.0.0.1` (a
secure context, so `crypto.subtle` exists) and prints pass, warning and
failure counts per browser; only failures fail the run. It needs downloaded
browsers, so it is not part of `pnpm test`;
`test/crypto-browser-scenarios.test.ts` runs the same steps in Node there so
they cannot go stale, and requires that none of them warns.

Every step goes through the package and must pass on every engine, except
the `engine` probe, which calls raw WebCrypto: does an AES-KW unwrap under a
wrong key, or of altered bytes, fail as RFC 3394 requires? Playwright's
Windows WebKit build does not (it returns a zeroed key), and the probe then
reports a warning, not a failure, because the package does not rely on the
engine here (see Security notes). The `wrap` steps show that directly: every
AES-KW purpose refuses a wrong parent key, another context and altered bytes
on the engine as it is, and again with `crypto.subtle.unwrapKey` replaced by
a stand-in that hands back a zeroed key for whatever the engine would refuse.
Each of those refusals follows an unwrap that returned a key, so it is the
package's re-wrap check that refuses.
