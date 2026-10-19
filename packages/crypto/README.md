# @openzcad/crypto

End-to-end encryption primitives for
[ADR-024](../../docs/adrs/ADR-024-end-to-end-encrypted-projects.md)
(roadmap L11, Phase 2). WebCrypto and web streams only, with no
dependencies, so the same code runs in browsers, Web Workers, the Tauri
WKWebView and Node 20+. Nothing in the application imports it yet; Phases 3–5
wire it in.

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

Every header starts with `u8 class | u8 kind | u8 compression | u32 chunk size`:

| Field       | Encoding                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| class       | 1 project envelope, 2 content blob                                                                                                   |
| kind        | project: 1 document, 2 measurements, 3 view-state, 4 share-snapshot; content: 1 import-source, 2 mesh-payload, 3 thumbnail, 4 export |
| compression | 0 none, 1 gzip (applied before encryption; the default)                                                                              |
| chunk size  | 64 B to 16 MiB (default 1 MiB)                                                                                                       |

A **project envelope** header continues with `u32 schema version | u32 key
epoch | u64 document version | u64 plaintext length | u8 previous-version
hash length (0 or 32) + hash | 32-byte roster entry hash | u8 length +
project id | u16 count + blob ids (u8 length + id each)`. Ids are 1–128 bytes
of printable ASCII. A project lists at most 4096 blob ids, without
duplicates, in the order given. The plaintext length is the exact size after
decompression.

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

| Kind                                | Ceiling | Source                                |
| ----------------------------------- | ------- | ------------------------------------- |
| document, share snapshot            | 24 MiB  | `MAX_CLOUD_PROJECT_DOCUMENT_BYTES`    |
| measurements                        | 512 KiB | `MAX_PROJECT_MEASUREMENT_BYTES`       |
| view state                          | 1 MiB   | judgment: camera and saved views only |
| thumbnail                           | 512 KiB | `MAX_THUMBNAIL_BYTES`                 |
| import source, mesh payload, export | 1 GiB   | `MAX_ARTIFACT_UPLOAD_BYTES`           |

Project envelopes declare their length in the header, and content blobs in
their `ContentBlobReference`. Encryption refuses anything above the ceiling,
and a test pins the ceilings to the shared constants.

### What authenticates what

- **Project envelopes** are decrypted with `decryptProjectEnvelope` and an
  `expect` object (project, kind, version, epoch, schema, previous-version
  hash, roster entry hash); an authentic envelope that differs is refused
  with `context-mismatch`. Their version keys are wrapped under the project
  key (`version-key` below).
- **Content blobs** are authenticated by the project envelope that references
  them. Its encrypted body carries a `ContentBlobReference` for each blob:
  the blob id, kind, random key and ciphertext hash. The ciphertext hash is
  computed while streaming as
  `SHA-256(label "v1 content blob hash" | SHA-256(prefix) | SHA-256(chunk 0) | …)`.
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
was cut off or swapped.

## User keys and device lists

Each user has three kinds of key:

| Key                 | Algorithm   | Role                                                                                       | Kept                                                           |
| ------------------- | ----------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Identity key        | ECDSA P-256 | Signs only device-list entries; its `publicKeyHash` is the fingerprint other people verify | Wrapped by the recovery key and passkeys only (`identity-key`) |
| Device signing keys | ECDSA P-256 | One per device; signs versions, roster entries and share snapshots                         | Never leaves its device (non-extractable by default)           |
| Encryption key pair | ECDH P-256  | Receives project keys                                                                      | Wrapped by the account key (`encryption-private-key`)          |

### Chains

Device lists, contacts lists and rosters share one set of chain rules
(`checkChain`, `checkNextLink`). Each entry carries a sequence and its
predecessor's `chainEntryHash`, `SHA-256(label "v1 <kind> entry hash" | entry)`.
A browser pins the newest entry it has seen and refuses a list that does not
contain the pin, which catches both rollback and forks. Version histories
reuse the pin rule.

### Device lists

A **device list** is a chain of identity-signed entries. Each entry is a full
snapshot of the current encryption public key and every live device signing
key:

```
"OZD" | u8 version = 1 | u32 sequence | u8 previous hash length (0 or 32) + hash | u8 length + user id
      | 65-byte encryption key | u16 device count | devices | u16 cutoff count | cutoffs
```

Devices are sorted by id, each as `u8 length + device id | 65-byte signing
key`. Cutoffs are sorted by project id, each as
`u8 length + project id | 32-byte version head | u8 length (0 or 32) + roster head`.
The identity key signs `label "v1 device list signature" | entry`
(`u8 version | r ‖ s`). A device missing from an entry is revoked from that
entry on and may never return. Only a revoking entry may carry cutoffs: for
each project the user belongs to, the newest version and roster heads the
revoking browser had accepted. `verifyDeviceList` checks the whole chain from
sequence 0 against the identity key the viewer verified, plus an optional
pin. It returns every device's `certifiedAt`, `revokedAt` and cutoffs, and
every encryption key's history. Rotation orchestration is Phase 3's.

### Device signatures

`signWithDevice` produces

```
u8 version = 1 | u8 length + user id | u32 device-list sequence | 32-byte device key hash | u64 signedAt | r ‖ s
```

over `label "v1 <purpose> signature" | u32 subject length | subject | signer fields`,
where the purpose is `version` or `roster`. `verifyDeviceSignature` reads the
signer and checks it against that user's verified device list. The device must
be certified at the sequence the signature cites. If the list has since revoked
it, the claimed sequence and timestamp prove nothing, because the stolen device
chose them. The signed item must then be the revocation's cutoff head for its
project, or an ancestor of it (`checkRevocationCutoff`). The caller supplies the
item's hash and an `isAncestorOrSelf` lookup, so the package stays
storage-free. Anything else a revoked device signed is refused.

The refusals are `key-revoked`, `authentication-failed` for an uncertified
device, `chain-broken` when the given list is older than the signature
claims, and `context-mismatch` for another user's list. A bad signature
returns null.

### Contacts lists

Verified pins of other people's identity keys live in an identity-signed
contacts list, not in plain settings, so a server cannot roll a pin back:

```
"OZC" | u8 version = 1 | u32 sequence | u8 previous hash length (0 or 32) + hash | u8 length + owner id
      | u8 action (1 verify, 2 replace, 3 distrust, 4 advance) | u8 length + contact id
      | 32-byte identity key hash | u8 length (0 or 32) + device-list head | u8 length (0 or 32) + replacement key hash
```

The identity key signs `label "v1 contacts signature" | entry`.

- **Verify** pins the contact's identity key together with their current
  device-list head. People compare `contactVerificationCode`:
  `SHA-256(label "v1 contact verification" | identity key hash | device-list head)`,
  shown as 40 digits, with the hash as the QR payload. A correct identity
  paired with an old device list therefore fails the comparison.
- **Advance** moves the pinned head forward.
- **Replace** and **distrust** name the key currently verified for that
  contact. After a replace, the new key is seen but not verified.

`verifyContactsList` checks the chain from sequence 0 and an optional pin,
and folds it into one pin per contact. Before a project key is wrapped to
someone, `checkContactDeviceList` requires three things: the pin is verified,
the device list belongs to that identity, and the list contains the pinned
head, so it chains forward from it. It returns the encryption key to wrap to,
and whether the pin should advance.

## Versions and the roster

- `versionHash(envelope)` is SHA-256 of a whole project envelope. The next
  version stores it as its previous-version hash.
- `signProjectEnvelope` is a `version` device signature over
  `u32 prefix length | prefix | versionHash`. Share snapshots and merged
  versions are project envelopes and sign the same way. Pass the project's
  ancestry lookup to `verifyProjectEnvelopeSignature` to accept a since-revoked
  device's versions within its cutoff.
- `verifyVersionChain` checks that the envelopes link by hash with rising
  versions in one project. Given the newest version this browser has seen, it
  also requires the chain to contain it, which refuses rollback and forks.
  This gives fork consistency only; the project state code is the manual
  cross-client check.
- **Roster entries** are typed. Only membership entries list members; the
  others apply to the roster in force at their parent:

  ```
  "OZR" | u8 version = 1 | u8 type | u32 sequence | u32 key epoch | u8 previous hash length (0 or 32) + hash
        | u8 length + project id | type fields
  ```

  | Type                | Type fields                            | Signed by                                                 | May change                                                       |
  | ------------------- | -------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
  | 1 `membership`      | `u16 count \| members \| wraps`        | a certified device key of the owner (the roster anchor)   | members and roles; may start an epoch (+1) as it removes someone |
  | 2 `epoch`           | `wraps`                                | a certified device key of any current member, viewers too | only the epoch (+1), wrapped to every member in force            |
  | 3 `self-removal`    | `u8 length + removed user id \| wraps` | the departing member's device key or identity key         | removes only the signer; epoch + 1 for the rest                  |
  | 4 `anchor-transfer` | `32-byte new identity key hash`        | the owner's old identity key                              | the anchor (owner identity); epoch unchanged                     |

  Members are sorted by user id, each as
  `u8 length + user id | 32-byte identity key hash | u8 role (1 owner, 2 editor, 3 viewer)`.
  A membership entry lists exactly one owner, who must be the anchor. Wraps
  are `u16 count`, then sorted by user id, each
  `u8 length + user id | u16 length + sealed project key`.
  `SignedRosterEntry.signedBy` says whether the signature is a `roster` device
  signature or an identity signature, `u8 version | r ‖ s` over
  `label "v1 roster signature" | entry`. `rosterEntryHash` is
  `SHA-256(label "v1 roster entry hash" | entry)`, the value project envelopes
  carry.

  A removal that does not start an epoch in the same entry, which is always
  the case for a self-removal, leaves `rotationPending` set. No version may
  then be written until the next epoch entry, which only a remaining member's
  device can sign. `checkVersionEpoch(state, keyEpoch)` refuses a version
  while the rotation is pending, or under any epoch other than the one in
  force.

  `verifyRosterChain` folds the chain into a `RosterState` (members, anchor,
  epoch, pending rotation) and enforces each type's signer and limits. Every signer's device
  list or identity key comes from `deviceLists(userId, identityKeyHash)`, and
  the identity must match the one the roster names. A since-revoked device
  counts only within its roster cutoff. The chain starts at sequence 0, or at
  a previously verified `from` state, and must contain an optional pin. The
  `authorize` callback adds Phase 5 policy, such as refusing an anchor
  transfer until members have verified the new identity outside OpenZCAD.

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

| Purpose                  | Format | Fields                               | Wrapped by                                                                   |
| ------------------------ | ------ | ------------------------------------ | ---------------------------------------------------------------------------- |
| `account-key`            | KW     | userId, method, unlockId             | device key, passkey PRF output or recovery key; sealed to an approved device |
| `identity-key`           | GCM    | userId, method, unlockId             | recovery key or passkey PRF output only (PKCS #8 bytes)                      |
| `encryption-private-key` | GCM    | userId, keyId                        | account key (PKCS #8 bytes)                                                  |
| `project-key`            | KW     | userId, projectId, keyEpoch          | sealed to a member; then the member's account key                            |
| `version-key`            | KW     | projectId, keyEpoch, kind, versionId | project key                                                                  |
| `share-key`              | KW     | projectId, keyEpoch, shareId         | project key; it never encrypts content                                       |
| `share-version-key`      | KW     | projectId, shareId, versionId        | share key: a share snapshot's version key, for link visitors                 |

`wrapShareSnapshotKey` wraps a share snapshot's fresh version key twice:
under the project key for members (`version-key`, kind `share-snapshot`) and
under the share key for link visitors. Blob keys are not wrapped; they travel
inside the project envelope. Unlock secrets are imported as non-extractable
HKDF keys, so a device key in IndexedDB never exposes its bytes. The passkey
PRF input is `PASSKEY_PRF_INPUT`.

## Codes

- **Asset de-duplication:** lowercase hex HMAC-SHA256 under
  HKDF-SHA256(project key, empty salt, `v1 asset dedupe`). It is an index
  value stored beside the blob, never inside an envelope.
- **Key hash:** `publicKeyHash` is the full
  `SHA-256(label "v1 public key hash" | u8 key count | keys)`. Over the
  identity key it is the user's fingerprint (`identityFingerprint`), which is
  the key a roster records. To verify a contact, people compare
  `contactVerificationCode`, which also covers the device-list head (see
  Contacts lists). Nothing people compare is
  shorter than 128 bits: the comparison code is 40 digits in eight groups of
  five (132.9 bits).
- **Project state code:**
  `SHA-256(label "v1 project state" | newest versionHash | u64 version | signer identity key hash)`,
  shown with `formatComparisonCode`.
- **Device approval, scan form:** the new device shows its `publicKeyHash` as
  a QR code, and the approver checks it with `verifyScannedDeviceKey`.
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

## Tests

`vectors.test.ts` holds fixed vectors built from injected keys, blob ids, IVs,
ephemeral keys and timestamps. It also re-derives the nonce layout, both
envelope classes, the content blob hash and the wrap with raw WebCrypto. A
change to a vector is a format change and needs a new version byte.
`fuzz.test.ts` mutates valid inputs and requires every parser to fail only
with `E2eeError`. Functions that inject keys or randomness (`…With`,
`envelopeKeyFromBytes`) are test-only and are not exported from the package
entry.
