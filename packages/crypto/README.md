# @openzcad/crypto

End-to-end encryption primitives for ADR-024, end-to-end encrypted projects
(roadmap L11, Phase 2). The ADR and its L11 roadmap row are proposed in
[esaueng/OpenZCAD#743](https://github.com/esaueng/OpenZCAD/pull/743); this
reference becomes a link to `docs/adrs/` once that lands. WebCrypto and web streams only, with no
dependencies, so the same code runs in browsers, Web Workers, the Tauri
WKWebView and Node 20+. Phase 3's account keys (device lists, unlock targets,
device approval) are its first application use; Phase 4 adds the project
data formats below (new envelope kinds, the version log, epoch bindings and
bodies), and Phase 5 sharing.

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
server can do.

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
`revoked-without-cutoff`, `outside-cutoff`), all `authentication-failed`. A
stolen device picks its own version numbers, so a version below a cutoff is
trusted only once the caller also shows it is an ancestor of the cutoff
head, for example with a version log that contains both.

### Bodies

Project envelope bodies are UTF-8 JSON with `version: 1`, written by the
encoders and read strictly by the decoders: unknown or missing fields, wrong
types and sizes are `malformed`, a newer `version` is `unsupported-version`,
and a body over its kind's ceiling, or nested past a lexical depth and
separator limit checked before `JSON.parse`, is `limit-exceeded`. Bytes are
unpadded canonical base64url. Every encoder and decoder runs
`checkBlobReferences` against the envelope header, so a body referencing a
blob the header omits, or the reverse, is refused (`context-mismatch`).

| Body                    | Kinds                    | Fields                                                                                                |
| ----------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `EncryptedDocumentBody` | document, share-snapshot | `document` (object), `blobs` (references), `revisionVersionHashes` (revision id → lowercase hex)      |
| `ProjectInfoBody`       | project-info             | `name`, optional `thumbnail` reference, `exports` (`ref`, `fileName`, `contentType`, flat `metadata`) |
| `KeyArchiveBody`        | key-archive              | `previousKeys` (`keyEpoch`, `key`), `dedupeSecret`, `epochRecord`, `epochAuthenticator`; no blob refs |

`revisionVersionHashes` lets a historical read prove that a retained
revision belongs to this history through the signed head, instead of a chain
walk through overwritten autosaves. A key archive's previous keys are
strictly ascending and older than its own key epoch (`context-mismatch` on
read). Project info and key archives also accept only their canonical
encoding; the document is checked by the shared document validators after
decoding.

Device lists live here (below). The contacts list, the custom roster and
its revocation cutoffs are parked on the `claude/e2ee-chains` branch: MLS
(RFC 9420) replaces the roster and epochs, and contacts arrive with sharing.

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
| `share-version-key`      | KW     | projectId, shareId, versionId             | share key: a share snapshot's version key, for link visitors                                                             |
| `rejoin-psk`             | KW     | userId, projectId, epoch                  | account key: an MLS epoch's rejoin PSK, for an External Commit after losing MLS state                                    |
| `archived-project-key`   | KW     | projectId, archivedEpoch, underEpoch      | a later epoch's project key: an earlier project key; `archivedEpoch` must be below `underEpoch`                          |
| `previous-account-key`   | KW     | userId, generation, keySequence           | the new account key: the account key it replaced, so older account-key wraps stay reachable                              |

`version-key` accepts every project envelope kind, `project-info` and
`key-archive` included. Integer fields are u32 values encoded as u64.

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
under the share key for link visitors. Blob keys are not wrapped; they travel
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

Three statements travel beside lists. An identity transition (`"OZT"`) names
the old identity hash, the new identity key and its first entry's hash, and
is signed by the old identity or a device it certified; it proves nothing to
contacts. A device approval grant (`"OZG"`) is signed by the approving
device's key and names the approved device's `pk_new`, the identity and the
device-list head the new device should pin, and whether it was certified.
Revocation cutoffs (`"OZR" | u8 1 | u8 length + user id | u32 generation |
u32 entry sequence | 32-byte entry hash | u64 issuedAt | u16 count + (u8
length + project id, u64 cutoff epoch) by project id`, signed with `v1
revocation cutoffs signature`) are signed by the identity key at a device
removal and name, per project, the first epoch the revoked device must not
know. `verifyRevocationCutoffs` requires the identity signature, the list's
user and generation, and an entry of that list, by sequence and hash, that
revokes a device. Phase 4 stores and enforces them.

## Tests

`vectors.test.ts` holds fixed vectors built from injected keys, blob ids, IVs,
ephemeral keys and timestamps, including version 1 and 2 device-list
entries, a recorded revocation-cutoffs signature, a paired
approval commitment, the project-info and key-archive kinds, the three
project-data wraps, an epoch binding, a version log record and a key archive
body. It also re-derives the nonce layout, both envelope classes, the content
blob hash, the wrap and the epoch binding with raw WebCrypto. A
change to a vector is a format change and needs a new version byte.
`fuzz.test.ts` mutates valid inputs, version log records and bodies included,
and requires every parser to fail only with `E2eeError`. Functions that inject keys or randomness (`…With`,
`envelopeKeyFromBytes`) are test-only and are not exported from the package
entry.
