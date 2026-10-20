# @openzcad/crypto

End-to-end encryption primitives for ADR-024, end-to-end encrypted projects
(roadmap L11, Phase 2). The ADR and its L11 roadmap row are proposed in
[esaueng/OpenZCAD#743](https://github.com/esaueng/OpenZCAD/pull/743); this
reference becomes a link to `docs/adrs/` once that lands. WebCrypto and web streams only, with no
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

Every header starts with `u8 class | u8 kind | u8 compression | u32 chunk size | u64 plaintext length`:

| Field            | Encoding                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| class            | 1 project envelope, 2 content blob                                                                                                   |
| kind             | project: 1 document, 2 measurements, 3 view-state, 4 share-snapshot; content: 1 import-source, 2 mesh-payload, 3 thumbnail, 4 export |
| compression      | 0 none, 1 gzip (applied before encryption; the default)                                                                              |
| chunk size       | 64 B to 16 MiB (default 1 MiB); at least the prefix length when the prefix exceeds 1 KiB; at most 65,536 chunks of plaintext         |
| plaintext length | the exact size after decompression; part of the header, so every chunk's AAD binds it                                                |

A **project envelope** header continues with `u32 schema version | u32 key
epoch | u64 document version | u8 previous-version
hash length (0 or 32) + hash | 32-byte roster entry hash | u8 length +
project id | u16 count + blob ids (u8 length + id each)`. Ids are 1–128 bytes
of printable ASCII. A project lists at most 4096 blob ids, without
duplicates, in the order given.

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
  hash, roster entry hash); an authentic envelope that differs is refused
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
  version stores it as its previous-version hash, and the header's roster
  entry hash is carried as an opaque 32-byte value.
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

Key management is not in this package: device lists, the signed roster and
its entry types, contacts lists, revocation cutoffs and read modes. That code
is parked on the `claude/e2ee-chains` branch while MLS (RFC 9420) is assessed
as its replacement.

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
| `dedupe-secret`          | KW     | projectId, keyEpoch                  | project key: the dedupe secret, carried across epochs                        |
| `share-key`              | KW     | projectId, keyEpoch, shareId         | project key; it never encrypts content                                       |
| `share-version-key`      | KW     | projectId, shareId, versionId        | share key: a share snapshot's version key, for link visitors                 |

Sealing to a public key is limited to two contexts (`SealContext`): the
account key with method `device-approval`, for a device being approved, and a
`project-key`, for a member. Any other purpose is refused
(`invalid-argument`), so long-term private keys never leave their wrap
hierarchy by seal.

`wrapShareSnapshotKey` wraps a share snapshot's fresh version key twice:
under the project key for members (`version-key`, kind `share-snapshot`) and
under the share key for link visitors. Blob keys are not wrapped; they travel
inside the project envelope. Unlock secrets are imported as non-extractable
HKDF keys, so a device key in IndexedDB never exposes its bytes. The passkey
PRF input is `passkeyPrfInput()`, a fresh copy on each call.

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
