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
epoch | u64 document version | u8 previous-version hash length (0 or 32) +
hash | 32-byte roster entry hash | u8 length + project id | u16 count + blob
ids (u8 length + id each)`. Ids are 1–128 bytes of printable ASCII; a project
lists at most 4096 blob ids, without duplicates, in the order given.

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
      | u8 action (1 verify, 2 replace, 3 distrust) | u8 length + contact id | 32-byte identity key hash
      | u8 length (0 or 32) + replacement key hash
```

The identity key signs `label "v1 contacts signature" | entry`. A `replace`
or `distrust` must name the key currently verified for that contact.
`verifyContactsList` checks the chain from sequence 0 and an optional pin and
folds it into one pin per contact: `verified`, `replaced` (the new key is
seen, not verified) or `distrusted`. `isVerifiedContact` is the check before
wrapping a project key to someone.

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
- **Roster entries** are `roster` device signatures over a canonical entry:

  ```
  "OZR" | u8 version = 1 | u32 sequence | u32 key epoch | u8 previous hash length (0 or 32) + hash
        | u8 length + project id | u16 member count | members | u16 wrap count | key wraps
  ```

  Members are sorted by user id, each as
  `u8 length + user id | 32-byte identity key hash | u8 role (1 owner, 2 editor, 3 viewer)`.
  Key wraps are sorted the same way, each as
  `u8 length + user id | u16 length + sealed project key`. The first entry, and
  any entry that moves the key epoch up by one, carries exactly one wrap per
  member; other entries carry none. An entry that keeps the member list and
  moves the epoch is an _epoch_ entry, which any member may start.
  `rosterEntryHash` is `SHA-256(label "v1 roster entry hash" | entry)`, the
  value project envelopes carry. `verifyRosterChain` checks each signer
  against their device list (with the roster cutoff for a since-revoked
  device, using the chain's own order unless a lookup is given), plus the
  sequence, links, epoch structure and an optional pin. Who may sign which entry is Phase 5's rule, supplied through
  the `authorize` callback.

## Key wrapping

| Format  | Bytes                                                                  | Key                                                                                         | AAD                                       |
| ------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Wrap v1 | `u8 1 \| 12-byte random IV \| ciphertext+tag`                          | HKDF-SHA256(parent key, empty salt, `v1 wrap <purpose>`)                                    | `u8 1 \| context`                         |
| Seal v1 | `u8 1 \| 65-byte ephemeral public key \| 12-byte IV \| ciphertext+tag` | HKDF-SHA256(ECDH(ephemeral, recipient), ephemeral key ‖ recipient key, `v1 seal <purpose>`) | `u8 1 \| ephemeral public key \| context` |

Wraps use AES-GCM with a fresh random 96-bit IV stored beside the ciphertext,
which ADR-024 allows in place of AES-KW; unlike AES-KW it binds the context.
Each purpose derives its own key-encryption key, and a parent key wraps far
fewer than 2³² items before an epoch or rotation replaces it. Public keys are
raw uncompressed P-256 points (65 bytes). The context is a `WrapContext`,
encoded canonically: fields sorted by name, each as
`u8 name length | name | u8 type | value`, where type 1 is a `u16`-length
UTF-8 string and type 2 a u64.

| Purpose                  | Fields                               | Wrapped by                                                                   |
| ------------------------ | ------------------------------------ | ---------------------------------------------------------------------------- |
| `account-key`            | userId, method, unlockId             | device key, passkey PRF output or recovery key; sealed to an approved device |
| `identity-key`           | userId, method, unlockId             | recovery key or passkey PRF output only (PKCS #8 bytes)                      |
| `encryption-private-key` | userId, keyId                        | account key (PKCS #8 bytes)                                                  |
| `project-key`            | userId, projectId, keyEpoch          | sealed to a member; then the member's account key                            |
| `version-key`            | projectId, keyEpoch, kind, versionId | project key                                                                  |
| `share-key`              | projectId, keyEpoch, shareId         | project key                                                                  |

Blob keys are not wrapped; they travel inside the project envelope. Unlock
secrets are imported as non-extractable HKDF keys, so a device key in
IndexedDB never exposes its bytes. The passkey PRF input is
`PASSKEY_PRF_INPUT`.

## Codes

- **Asset de-duplication:** lowercase hex HMAC-SHA256 under
  HKDF-SHA256(project key, empty salt, `v1 asset dedupe`). It is an index
  value stored beside the blob, never inside an envelope.
- **Key hash:** `publicKeyHash` is the full
  `SHA-256(label "v1 public key hash" | u8 key count | keys)`. Over the
  identity key it is the user's fingerprint (`identityFingerprint`): the QR
  form, the verified key a roster records, and, through
  `formatComparisonCode`, the code people compare. Nothing people compare is
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
