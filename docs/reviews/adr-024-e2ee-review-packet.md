# ADR-024 end-to-end encryption: outside review packet

This packet is for the outside security reviewer that
[ADR-024](../adrs/ADR-024-end-to-end-encrypted-projects.md) Phase 8 requires
before encryption becomes the default (roadmap row
[L11](../../ROADMAP.md#l11)). It covers the cryptography, the key flows and
the MLS integration, including the crate itself at the exact pinned `mls-rs`
version. It points into the code rather than restating it: every path,
function name and version below was checked against the repository when the
packet was written, and the review target commit (below) is what counts.

The ADR is the design record. Where the code and the ADR differ, the code
and the ADR's
[amendment of 2026-10-24](../adrs/ADR-024-end-to-end-encrypted-projects.md#amendment-2026-10-24-project-data)
describe what is built; please report any difference you find.

## 1. Scope and target

### Review target

<!-- TODO(review-freeze): the coordinator sets the frozen tag and commit when the review starts. -->

| Item                   | Value                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository             | `esaueng/OpenZCAD`                                                                                                                                  |
| Review tag             | **TBD**: set when the review is scheduled                                                                                                           |
| Review commit          | **TBD**: the full 40-character SHA of that tag                                                                                                      |
| Historical audit basis | `8b2f68d3eda33092eba97a062e58934c9deec1e3`, the merged [#959](https://github.com/esaueng/OpenZCAD/pull/959) tree                                    |
| Packet refreshed       | 2026-10-27: audit follow-ups in held [#968](https://github.com/esaueng/OpenZCAD/pull/968); select its final qualified commit before freezing review |

Review the frozen commit, not `main`. Phase 8 slices land behind
off-by-default flags while the review runs; findings against later commits
are welcome but should name the commit.

### In scope

- `packages/crypto` (all of `src/`): envelopes, STREAM chunking, key
  wrapping and sealing, signatures, version log, device lists, contacts,
  share links, invitations, account-key MACs and fixed codes.
- `packages/mls` (all of it): the Rust crate `crate/src/*.rs`, its pinned
  dependency tree (`crate/Cargo.toml`, `crate/Cargo.lock`), the committed
  WASM in `pkg/`, and the TypeScript Worker, engine, client and sealed
  storage in `src/`.
- The browser key flows and the MLS session code in
  `apps/web/src/lib/e2ee/` (including `mls/`).
- The Worker's encrypted routes in `apps/web/worker/e2ee*.ts` and the
  encrypted collaboration room (`apps/web/worker/e2eeRoom.ts`,
  `packages/cloudflare-adapters/src/e2ee-room.ts`), as defense in depth and
  as the MLS Delivery Service.
- The Phase 7 migration (plaintext to encrypted) and its beta-only reverse
  path.
- The desktop Keychain device keys (`apps/desktop/device-keys/`,
  `apps/desktop/src-tauri/src/device_keys.rs`,
  `apps/web/src/lib/e2ee/keychainDeviceKeys.ts`).

### Out of scope

- Geometry, CAD modeling and the Remus kernel.
- Email-code sign-in (ADR-012) except as the thing that must never unlock
  keys.
- Cloudflare's own platform security, and the plaintext (format 1) project
  pipeline that Phase 8 will delete, except where it touches migration.
- The AI assistant's provider, beyond what leaves the device under consent.

### Repository map

| Area                        | Where                                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Crypto core (WebCrypto)     | `packages/crypto/src/`, specification in `packages/crypto/README.md`                                                                         |
| MLS layer (mls-rs in WASM)  | `packages/mls/crate/src/`, `packages/mls/src/`, notes in `packages/mls/README.md`                                                            |
| Browser key and group logic | `apps/web/src/lib/e2ee/`, `apps/web/src/lib/e2ee/mls/`                                                                                       |
| Settings and dialogs        | `apps/web/src/components/Encryption*.tsx`, `EncryptedShareLinks.tsx`, `ExistingProjectEncryption.tsx`, `StopProjectEncryption.tsx`           |
| Worker routes               | `apps/web/worker/e2ee*.ts`, gate in `apps/web/worker/projectFormatGate.ts`                                                                   |
| Flags and storage readiness | `packages/cloudflare-adapters/src/index.ts` (`isE2eeKeysEnabled`, `isE2eeProjectsEnabled`, `isE2eeMigrationEnabled`, `isE2eeReverseEnabled`) |
| Shared wire types and codes | `packages/shared/src/index.ts`                                                                                                               |
| D1 schema                   | `apps/web/migrations/0029_*.sql` to `0043_*.sql` (there is no 0035)                                                                          |
| Library spike evidence      | `docs/plans/mls-spike-2026-10.md`, harness in `spikes/mls/`                                                                                  |

### Pinned versions (verified)

| What                       | Pin                                                                                                                                                         | Where                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `mls-rs`                   | `=0.56.0`, `default-features = false`, features `std`, `external_client`, `by_ref_proposal`, `custom_proposal`, `self_remove_proposal`, `psk`, `tree_index` | `packages/mls/crate/Cargo.toml`                                                             |
| `mls-rs-core`              | `=0.27.0`                                                                                                                                                   | same                                                                                        |
| `mls-rs-codec`             | `=0.7.0`                                                                                                                                                    | same                                                                                        |
| `mls-rs-crypto-rustcrypto` | `=0.22.1`, feature `browser`                                                                                                                                | same                                                                                        |
| Transitive MLS crates      | `mls-rs-crypto-hpke` 0.21.1, `mls-rs-crypto-traits` 0.22.0, `mls-rs-codec-derive` 0.2.0                                                                     | `packages/mls/crate/Cargo.lock`                                                             |
| RustCrypto primitives      | `p256` 0.13.2, `ecdsa` 0.16.9, `aes-gcm` 0.10.3, `hkdf` 0.12.4, `sha2` 0.10.9, `rand_core` 0.6.4, `getrandom` 0.2.17                                        | `packages/mls/crate/Cargo.lock` (116 packages)                                              |
| `wasm-bindgen`             | `=0.2.126` (crate and CLI must match)                                                                                                                       | `Cargo.toml`, `build.sh`, `pkg/BUILD.json`                                                  |
| Rust toolchain             | `1.96.0`, target `wasm32-unknown-unknown`, profile `minimal` (crate MSRV `rust-version = "1.88"`)                                                           | `packages/mls/crate/rust-toolchain.toml`                                                    |
| Cipher suite               | `MLS_128_DHKEMP256_AES128GCM_SHA256_P256` (0x0002) and no other                                                                                             | `SUITE` in `packages/mls/crate/src/model.rs`; reported by `buildInfo` in `crate/src/lib.rs` |
| Committed WASM             | `pkg/openzcad_mls_bg.wasm`, SHA-256 `fb4709149d413113b71de97cb7acf0c5aaf672a010de8195b62fb22b80acdecc` (1,118,707 bytes)                                    | `packages/mls/pkg/BUILD.json`                                                               |

`pkg/BUILD.json` also records the SHA-256 of every crate source,
`Cargo.toml`, `Cargo.lock` and `rust-toolchain.toml`. When this packet was
written all of them matched the files on disk, and the five `pkg/` outputs
matched their recorded hashes. `packages/mls/src/pkg.test.ts` repeats that
check and the exact pins in `pnpm test`, because CI has no Rust toolchain.

Randomness and time in the WASM come from the host: the wasm-bindgen glue
in `pkg/openzcad_mls.js` calls `crypto.getRandomValues` (or Node's
`randomFillSync`), and the one snippet,
`pkg/snippets/mls-rs-core-*/inline0.js`, is `Date.now()`.

### Build and reproduce

```bash
pnpm install --frozen-lockfile          # needs network: the lockfile pins a GitHub tarball

# The MLS WASM (macOS or Linux; see the note on Windows below)
rustup toolchain install 1.96.0 --target wasm32-unknown-unknown --profile minimal
cargo install wasm-bindgen-cli --version 0.2.126 --locked
packages/mls/build.sh --check           # fresh build in a temp dir; fails unless byte-identical to pkg/
packages/mls/build.sh                   # rebuild pkg/ and BUILD.json

# Rust unit tests: the MLS crate's archive regressions, and the desktop device keys
(cd packages/mls/crate && cargo test --locked)
cargo test --locked --manifest-path apps/desktop/device-keys/Cargo.toml
```

`build.sh` builds with `--locked`, `SOURCE_DATE_EPOCH=0` and
`--remap-path-prefix` for the crate, Cargo home and toolchain, so the
output should not depend on where the repository lives. Its own comment
notes that a build under Git Bash, MSYS2 or Cygwin on Windows still embeds
`\` path separators and differs from a macOS or Linux build; reproduce on
macOS or Linux. The historical packet checked only hashes because its
author had no Rust toolchain. The #968 follow-up runs the 19 native MLS
crate tests and a fresh byte-identical `build.sh --check` with Rust 1.96.0
and wasm-bindgen 0.2.126. This does not qualify native macOS Keychain ACLs. (The evidence for issue #817,
`docs/roadmap-evidence/l11--mls-welcome-removal-archive.md`, records a
byte-identical fresh Rust 1.96.0 build at that time.)

Everything else (tests, the web app, the Worker) is TypeScript and runs
from the repository root; see section 5.

### Flags and migrations at the review commit

Everything encrypted is behind off-by-default flags, read in
`packages/cloudflare-adapters/src/index.ts` and reported to browsers by
`GET /api/e2ee/config` (`apps/web/worker/e2ee.ts`):

| Flag                                         | Gates                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `E2EE_KEYS_ENABLED` and `E2EE_CANARY_EMAILS` | Account keys, devices, unlock methods (Phase 3); the allowlist limits who sees them |
| `E2EE_PROJECTS_ENABLED`                      | Encrypted (format 2) projects, groups, sharing, assistant consent (Phases 4 to 6)   |
| `E2EE_MIGRATION_ENABLED`                     | Encrypting existing projects (Phase 7)                                              |
| `E2EE_REVERSE_ENABLED`                       | The beta-only reverse path back to plaintext (Phase 7, slice 7-3)                   |

Phase 8 adds `E2EE_DEFAULT_ON` and `E2EE_PLAINTEXT_FROZEN` (slices 8-1 and
8-4), also off by default; whether they exist at the review commit depends
on when it is frozen. The held deletion PR (8-5) later removes the
plaintext paths and these flags. Migrations `0029_e2ee_account_keys.sql`
through `0043_e2ee_reverse_staging.sql` define the encrypted tables; each
route answers 503 or reports disabled while its tables are missing.

## 2. Threat model

The threat model is the ADR's
[Threat model](../adrs/ADR-024-end-to-end-encrypted-projects.md#threat-model)
section, sharpened by
[Version integrity](../adrs/ADR-024-end-to-end-encrypted-projects.md#version-integrity),
[Plaintext metadata](../adrs/ADR-024-end-to-end-encrypted-projects.md#plaintext-metadata)
and [Consequences](../adrs/ADR-024-end-to-end-encrypted-projects.md#consequences).
In short:

- **Adversary.** Anyone who controls stored data or the server side: a
  leaked D1 database, R2 bucket, backup or Time Travel snapshot; a
  compromised Cloudflare account or API token; operator staff; legal
  requests for stored contents; a taken-over email inbox (which signs in
  but unlocks no key). The server is untrusted for confidentiality and for
  integrity (tampering must be detected, never accepted); it is trusted
  only for availability.
- **Not defended.** Altered application code (the web server delivers the
  JavaScript; the signed desktop app is the stronger client); the AI
  assistant's request, which must reach the provider in plaintext; metadata
  (account emails, member lists and roles, sizes, counts, timestamps,
  envelope headers, device lists); a removed member's earlier copies; a
  compromised device or its local IndexedDB copies; deletion or
  withholding; and a server that keeps members on permanently separate
  branches or serves a stale history to a browser that never saw the
  project (fork consistency only).

### What product copy may and may not claim

No public encryption claim is made today, and a privacy policy is a
prerequisite for any (ADR Phase 0; the draft is
`docs/legal/privacy-policy-draft.md`, not published). When copy is written
it **may** say:

- for an encrypted project, the server stores its contents (documents,
  revisions, imports, names, thumbnails, measurements, view state,
  archived exports) only as ciphertext it cannot decrypt;
- a member is never silently moved backwards from a version their browser
  has already seen;
- removal protects later project versions;
- encryption starts at an account's first sign-in after the switch.

It **must not** say or imply:

- that the server cannot fork or roll back a project (ADR, Version
  integrity, "Not in scope");
- that removal protects later snapshots of share links that were not
  reissued, or recalls anything already downloaded;
- that metadata (who works with whom, sizes, timing, device lists) is
  hidden;
- that the web app protects against a compromised deployment;
- that migrated plaintext is gone at once: D1 Time Travel and the room's
  point-in-time recovery keep it for up to 30 days, and release notes must
  say so;
- that the assistant works on ciphertext, or that what it sent can be
  recalled;
- that lost keys can be recovered by support (there is no escrow).

## 3. Key flows with code pointers

`packages/crypto/README.md` is the byte-level specification for every
format named below (labels, field order, wrap contexts). Each flow lists
the browser side first, then the Worker's defense in depth.

### 3.1 Setup and the recovery key

- Setup creates the identity key (ECDSA P-256), the account key, the
  encryption key pair and this device's signing and unlock keys, signs the
  first device-list entry and requires the recovery key to be saved and
  confirmed: `setUpEncryption` in `apps/web/src/lib/e2ee/accountKeys.ts`;
  UI in `apps/web/src/components/EncryptionSettings.tsx`.
- Recovery key: 256 bits, `generateRecoveryKey`, `formatRecoveryKey`,
  `parseRecoveryKey` in `packages/crypto/src/codes.ts`. It and each passkey
  are public-key targets: the target's private half is wrapped under the
  method's secret (`unlock-target-key`, AES-GCM, binds the identity key
  hash) and the account and identity keys are sealed to the certified
  public half (`sealKey`, `openSealedKey` in `packages/crypto/src/wrap.ts`).
- Device lists: `signDeviceListEntry`, `verifyDeviceList`,
  `nextDeviceListEntry`, `accountKeyCommitment` in
  `packages/crypto/src/devices.ts`. Unlocking: `loadEncryption`,
  `enrollWithRecoveryKey`, `withIdentityKey` (identity key opened per
  operation, never cached), `openAccountKeyChain` (older account keys
  through `previous-account-key` wraps).
- Device keys: non-extractable `CryptoKey`s in IndexedDB
  (`apps/web/src/lib/e2ee/deviceStore.ts`, database `openzcad-e2ee`), or
  the macOS Keychain on desktop (`keychainDeviceKeys.ts`; the Tauri
  commands in `apps/desktop/src-tauri/src/device_keys.rs`; the key logic
  and its tests in `apps/desktop/device-keys/src/lib.rs`, crate
  `openzcad-device-keys` with `p256` =0.14.0). Sign-out choice:
  `endKeySession` in `signOut.ts`, `forgetThisDevice` in `accountKeys.ts`;
  key-session teardown across tabs in `keySession.ts`.
  Desktop Keychain items hold software private-key bytes readable by the
  native host. They are not Secure Enclave keys; the non-exportability
  guarantee is at the renderer/IPC boundary. Frontend code can invoke sign
  and derive without an individual consent prompt, like browser WebCrypto.
  Keychain ACL and signed-host behavior still require the manual macOS run.
- Worker: `POST /api/e2ee/setup`, `/api/e2ee/device-list`,
  `/api/e2ee/identity`, `GET /api/e2ee/account` and
  `/api/e2ee/account-key-history` in `handleE2eeRequest`
  (`apps/web/worker/e2ee.ts`).

### 3.2 Device approval: QR scan and commitment code

- `pk_new = deviceKeysHash(signing_pub, unlock_pub)`; the QR carries the
  full 256-bit hash (`deviceScanCode`, `parseScanCode` in
  `accountKeys.ts`, encoder `qrCode.ts`; check `verifyScannedDeviceKey` in
  `codes.ts`).
- Remote comparison: `commitDeviceApproval`, `createApprovalNonce`,
  `verifyDeviceApprovalCommitment` and `deviceApprovalCode` (six digits,
  `getUint32(0) % 1_000_000` over a labelled SHA-256) in `codes.ts`.
- Flow: `requestApproval`, `advanceApprovalAsNewDevice`,
  `beginCompareApproval`, `approverComparisonCode`, `confirmApprovalCode`,
  `approveDevice`, `denyApproval`, `cancelApprovalRequest` in
  `accountKeys.ts`. The approver seals the account key to the committed
  unlock key and signs a grant (`signDeviceApprovalGrant`,
  `verifyDeviceApprovalGrant` in `devices.ts`) naming the approved
  `deviceKeysHash`, the device-list head and whether that head certifies
  the device. It does not carry the contacts head (see section 6).
- Worker: `/api/e2ee/approvals` in `e2ee.ts`, with `APPROVAL_TTL_MS`
  (10 minutes), `MAX_OPEN_APPROVALS` (3) and `MAX_APPROVALS_PER_HOUR` (10).
- An approved but uncertified device can read but not write
  (read-only devices hold no MLS leaf, decision D4;
  `revokeReadOnlyDevices` in `accountKeys.ts`).

### 3.3 Passkey PRF

- `apps/web/src/lib/e2ee/passkeys.ts` (`browserPasskeys`): discoverable
  credential, `userVerification: 'required'`, relying-party id
  `location.hostname`, PRF input `passkeyPrfInput()`
  (`packages/crypto/src/keys.ts`); an assertion follows creation when PRF
  was enabled without output. Missing PRF, cancellation and malformed
  output fail closed.
- Target id `pk_` plus the SHA-256 hex of the credential id, certified in
  the device list. Adding a passkey needs the recovery key (`addPasskey`);
  `enrollWithPasskey` unlocks a fresh browser with one; `removePasskey`
  rotates like a device removal (all in `accountKeys.ts`). No assertion or
  PRF output is sent to the Worker.

### 3.4 Device removal and its rotations

- `removeDevice` in `accountKeys.ts` with the participant step
  `removalParticipant` in `apps/web/src/lib/e2ee/deviceRemoval.ts` (page
  wiring in `pageDeviceRemoval.ts`). Order: catch every project up; sign a
  per-project revocation cutoff (next key epoch and newest head) with the
  identity key (`signRevocationCutoffs`, `verifyRevocationCutoffs` in
  `devices.ts`); append the revoking device-list entry, which rotates the
  account key and encryption key pair and names the replacement device;
  then rotate every owned and shared project (Remove of the revoked
  device's leaves or an empty Commit, new project key and rejoin PSK under
  the new account key, key archive with a new dedupe secret, decision D8).
- Readers honour cutoffs: `revocationStatements` in `deviceRemoval.ts`;
  `projectRevocationCutoffs`, `memberRevocationCutoffs`,
  `UNSIGNED_SHARED_CUTOFF`, `ensureProjectRotated` and
  `pendingMemberRotation` in `apps/web/src/lib/e2ee/projectGroups.ts`.
- Share links after removal: `renewShareDelegationAfterRemoval`
  (`pageDeviceRemoval.ts`), `shareLinksAfterDeviceRemoval` (`shareLinks.ts`).
- Worker: `apps/web/worker/e2eeDeviceRemoval.ts`
  (`appendedRevocationCutoffs` stores the revocation and its statement in
  one batch; `memberRotationFence` and `ownRotationDue` refuse writes until
  a due rotation lands).

### 3.5 Recovery-key replacement, identity replacement and group reset

- `replaceRecoveryKey` in `accountKeys.ts` always replaces the identity key:
  a fresh device list with only this device and a new recovery key, and a
  transition statement signed by the old identity or an unrevoked device it
  certified (`signIdentityTransition`, `verifyIdentityTransition`,
  `decodeIdentityTransition` in `devices.ts`). Contacts see the key as
  changed (section 3.6); share links naming the old identity are
  tombstoned and offered for reissue (`shareLinks.ts`).
- Solo group reset (decision D9): `signGroupReset`, `verifyGroupReset` in
  `devices.ts`; `signGroupResetWithIdentity` in `accountKeys.ts`;
  `resetProjectGroup`, `GROUP_RESET_CONFIRMATION`, `recoverProjectGroup`,
  `groupBaseForKeyEpoch` in `projectGroups.ts`; UI in
  `EncryptedProjectRecovery.tsx`.

### 3.6 Contacts and pins

- Identity-signed, hash-chained contacts list: `signContactsEntry`,
  `nextContactsEntry`, `verifyContactsList`, `contactDeviceListPin` in
  `packages/crypto/src/contacts.ts`; comparison code
  `contactVerificationCode` (identity key plus device-list head) and
  `formatComparisonCode` in `codes.ts`, never below 128 bits.
- Browser: `inspectContact`, `verifyContact`, `recordKeyChange`,
  `untrustContact`, `verifiedEncryptionKey` in
  `apps/web/src/lib/e2ee/contacts.ts`; seen pins and list pins in
  `contactPins.ts` (database `openzcad-e2ee-contacts`); UI
  `EncryptionContacts.tsx`. Worker: `apps/web/worker/e2eeContacts.ts`.

### 3.7 Envelopes, STREAM nonces and wrapping (`packages/crypto/src/*`)

- Format: `encodeEnvelopePrefix`, `decodeEnvelopePrefix`, `checkHeader`,
  `normalizeProjectHeader`, `PLAINTEXT_CEILINGS` in `header.ts`.
- One key per envelope (`EnvelopeKey`, which refuses reuse with
  `key-reused`), STREAM nonce `uint88_be(i) || last` (`chunkNonce`) and AAD
  prefix plus `u32 i` (`chunkAad`); `EnvelopeWriter`, `EnvelopeReader`,
  `encryptProjectEnvelope`, `decryptProjectEnvelope`, the content-blob
  writers, readers and streams, `contentBlobReference`,
  `checkBlobReferences`, `parseEnvelope`, `parseEnvelopeShape` in
  `envelope.ts`.
- Decompression limits: `plaintextCap`, `decodePayload` in `envelope.ts`
  and `compression.ts`; in the app, decompression and JSON parsing run in
  a terminable worker (`apps/web/src/lib/e2ee/decodeWorker.ts`,
  `decodeJobs.ts`: `decodeCeiling`, `parseGuardedJson`).
- Wraps (`wrap.ts`): AES-256-KW (wrap version 2) with the context in the
  HKDF-derived KEK; AES-256-GCM (wrap version 1) for PKCS #8 private keys;
  ECDH P-256 seal. `unwrapKey` re-wraps and compares in constant time
  because one WebKit build skips RFC 3394's integrity check (README,
  "Security notes"). `wrapShareSnapshotKey` wraps a snapshot key twice.
- Bodies: `encodeEncryptedDocumentBody` (revision-hash map, version 2 adds
  the share-link set), project-info and key-archive bodies in `bodies.ts`.
- Dedupe: `generateAssetDedupeSecret`, `assetDedupeHash` (HMAC) in
  `codes.ts`; `dedupeSecretForProject` in `projectGroups.ts`.
- Signatures: `versionHash` (SHA-256 over the prefix and every chunk with
  its tag), `signProjectEnvelope`, `verifyProjectEnvelopeSignature`,
  `verifyVersionChain` in `signing.ts`; device keys may be Keychain-held
  external keys (`ecdsaSign`, `ecdhDeriveBits` in `external-keys.ts`).

### 3.8 Version log, pins and epoch binding (`apps/web/src/lib/e2ee/*`)

- Crypto: `versionLogRecord`, `verifyVersionLog`, `verifyAuthoredLogRecord`,
  `verifyAuthoredEnvelope`, `authorCutoffKey` in
  `packages/crypto/src/version-log.ts`; `epochBinding` (project id, key
  epoch, MLS epoch authenticator) and `projectStateCode` in `codes.ts`.
- Browser: `createEncryptedProjectStore` in `encryptedProjectStore.ts` binds
  each header to its epoch, verifies the log from the pin in windows of at
  most 4,096 records, checks the author's device (with revocation cutoffs)
  and its role in that very epoch (`epochRoles` in `projectGroups.ts`,
  parser `mls/epochRoles.ts`), and warns on a stale head
  (`STALE_HEAD_WARNING_MS`). Pins: `envelopeMayFollow`, `swappedPin`,
  `indexedDbVersionPins` in `versionPins.ts` (database
  `openzcad-e2ee-versions`); replaced envelopes (project info,
  measurements, view state) in `replacedEnvelopes.ts`.
- Worker: `writeVersion` in `apps/web/worker/e2eeProjectDocuments.ts`
  (forward-only versions, previous hash equals the stored head, current key
  epoch fenced in the same batch, signer certified by the newest device
  list); other envelopes in `e2eeProjectEnvelopes.ts`; content blobs in
  `e2eeContentBlobs.ts`.
- The account opt-in (decision D2): `macProjectPreferences`,
  `openProjectPreferences` in `packages/crypto/src/account-records.ts`;
  `projectPreferences.ts`, `preferencePins.ts`; Worker
  `accountRequiresEncryptedProjects` in `e2eeProjectPreferences.ts` and
  `EncryptedProjectsRequiredError` in
  `packages/persistence/src/project-format.ts` (409
  `ENCRYPTED_PROJECTS_REQUIRED`).

### 3.9 Share links: authority and delegation

- Crypto (`packages/crypto/src/share-links.ts`): delegation ("OZS",
  identity-signed, at most 30 days), share-authority statement ("OZA",
  owner device named by the delegation, at most 7 days), grant ("OZL"),
  permanent tombstone ("OZY"), forget request ("OZF"),
  `verifySharedSnapshot` (the ADR's check order), `checkShareLinkSet`,
  `verifyShareLinkSet`, `openShareKey`, `shareKeyHash`; clock skew
  `SHARE_CLOCK_SKEW_MS` (10 minutes).
- Owner and editors: `createShareLink`, `revokeShareLinks`,
  `forgetRevokedShareLinks`, `issueShareAuthorities`,
  `renewShareDelegation`, `publishShareSnapshots`, `sealSnapshot`,
  `reissueShareLinks` in `apps/web/src/lib/e2ee/shareLinks.ts`; head set
  verification in `shareLinkSet.ts`; fragment `#share=<token>.<key>.<owner>`
  in `shareLinkFragment.ts`; UI `EncryptedShareLinks.tsx`.
- Visitor: `loadEncryptedSharedProject` in `sharedSnapshotLoader.ts`,
  `openSharedSnapshot` in `sharedSnapshot.ts`.
- Worker: `apps/web/worker/e2eeShareLinks.ts`
  (`handleE2eeShareLinkRequest`, anonymous `handleEncryptedSharedSnapshot`
  and `handleEncryptedSharedBlob`, `MAX_LIVE_SHARE_LINKS`).

### 3.10 Invitations

- Crypto: `signProjectInvitation`, `verifyProjectInvitation`,
  `invitationEmailHash` ("OZI", seven days) in
  `packages/crypto/src/invitations.ts`.
- Browser: `inviteToEncryptedProject`, `acceptEncryptedInvitation`,
  `publishInvitationKeyPackages`, `addInvitedMember`,
  `completeReadyInvitations`, `joinWelcomedProjects` in
  `apps/web/src/lib/e2ee/invitations.ts`; `addInvitee` and
  `joinProjectByWelcome` (full-history verification, issue #817) in
  `projectGroups.ts`; link capture in `encryptedInvitationLink.ts`.
- Worker: `apps/web/worker/e2eeInvitations.ts` (`prepareAddCommit` gates an
  Add Commit on a claimed KeyPackage of an accepted invitation). Emails name
  the sender, not the project.

### 3.11 Assistant consent

- Record MAC'd under an HKDF of the account key and pinned by sequence:
  `macAssistantConsent`, `openAssistantConsent` in
  `packages/crypto/src/assistant-consent.ts`; `loadAssistantConsent`,
  `saveAssistantConsent`, `consentPermits` in
  `apps/web/src/lib/e2ee/assistantConsent.ts`; the send gate in
  `apps/web/src/lib/assistant/consentGate.ts`; copy in
  `apps/web/src/components/assistant/AssistantConsentSummary.tsx`.
- Worker: `apps/web/worker/e2eeAssistantConsents.ts`
  (`liveAssistantConsentRoute`), a defense-in-depth gate; the assistant is
  off on encrypted projects without consent (decision D7).

### 3.12 Phase 7 migration: lease, cutover and purge

- Browser: `createProjectMigrationEngine` in `projectMigrationEngine.ts`
  (save states oldest first, head at `sourceVersion + 1`, device and leaf
  checks before cutover), `createMigrationController` in
  `projectMigrations.ts` (Web Lock per account), reads through
  `migrationPlaintextSource.ts`; shared projects re-add members first
  (`prepareMigrationMembers`, `readdMigrationMembers` in
  `migrationMembers.ts`). UI `ExistingProjectEncryption.tsx`.
- Worker: `apps/web/worker/e2eeProjectMigrations.ts` (`start`, `renew`,
  `cutover`, `abandon`, `purge` and `purgeStep` are internal;
  `purgeMigratedProject` and `sweepProjectMigrations` are exported), lease
  fences in `e2eeMigrationLease.ts` (`checkStagingLease`), member readiness
  in `e2eeMigrationMembers.ts`, the 409 `PROJECT_MIGRATING` gate in
  `projectFormatGate.ts`; schema `0042_e2ee_project_migrations.sql`.

### 3.13 The beta-only reverse path

- Browser: `createProjectDecryptionEngine` in `projectDecryptionEngine.ts`,
  `createDecryptionController` in `projectDecryption.ts`;
  UI `StopProjectEncryption.tsx`.
- Worker: `startDecrypt`, `cutoverDecrypt`, `decryptPurgeStep` and the
  exported `decryptLeaseDeviceFence` in `e2eeProjectMigrations.ts`;
  `stageDecryptedRevision`, `stageDecryptedHead` in `e2eeReverseStaging.ts`;
  `decryptStagingFence` in `e2eeMigrationLease.ts`; schema
  `0043_e2ee_reverse_staging.sql`. Open only to an owner-only project with
  no members, links or pending invitations, on an account whose opt-in is
  off. Default-on closes it (slice 8-1) and 8-5 deletes it.

## 4. MLS integration

ADR sections:
[MLS assessment](../adrs/ADR-024-end-to-end-encrypted-projects.md#mls-assessment)
and its [Decision](../adrs/ADR-024-end-to-end-encrypted-projects.md#decision-1).
Each encrypted project is one MLS group (group id `openzcad/project/` plus
the project id, `group_id` in `model.rs`); each device of each member is one
leaf with a per-project leaf key, certified by the device signing key.

### 4.1 Policy (`packages/mls/crate/src/policy.rs`)

- `ProjectRules` implements `MlsRules::filter_proposals`, run when sending
  and when receiving; `check_member_commit` and `check_external_commit`
  carry the rules. `commit_options` and `encryption_options` fix the rest.
- Roles live in GroupContext extension 0xF0A1 (`ProjectRoles`,
  `check_shape`, `check_transition` in `model.rs`): exactly one owner; only
  the owner changes it; any member may Add a leaf for a listed identity
  with its existing role (key certified at or after that identity's latest
  leaf removal); otherwise a member changes only its own identity.
- External Commits are rejoins: listed identity, certified and unrevoked
  credential, exactly one PSK `ozc-rejoin/<epoch>` no earlier than the
  user's newest revocation, the identity's latest role change and the
  latest Remove of a leaf with the same device or key, inside the rejoin
  window (the app creates groups with the default, `DEFAULT_REJOIN_WINDOW`
  16 epochs in `packages/mls/src/constants.ts`; the spike used four;
  `MAX_REJOIN_WINDOW` 1024), and the last-leaf exception for a named
  replacement. `packages/mls/README.md` ("Policy") lists every rule and
  the reason codes.

### 4.2 Identity provider and device directory

- `ProjectIdentity` implements `IdentityProvider` (`validate_member`,
  `valid_successor`) in `policy.rs`; credential type 0xF0A2
  (`DeviceCredential` in `model.rs`).
- `DeviceListVerifier` and `DeviceDirectory` (`credential_status`,
  `revocation_cutoff`, `certified_epoch`, `replaces`) in
  `crate/src/directory.rs`. The policy runs synchronously and cannot await
  WebCrypto, so the browser verifies everything first and installs a
  snapshot: `buildDeviceDirectory` in
  `apps/web/src/lib/e2ee/mls/directory.ts` (refuses a revoked device
  without a cutoff, `revocation-cutoff-missing`); leaf certifications
  (version 2, label `openzcad mls leaf certification v2`, binds the
  certified epoch) are signed and checked only in `mls/certify.ts`
  (`certifyLeaf`, `verifyLeafCertification`).

### 4.3 History archive and replay (`crate/src/archive.rs`)

- `replay` and `verify` authenticate a join archive with mls-rs's public
  observer: from the signed epoch-zero GroupInfo, every public proposal and
  Commit through the target epoch; each GroupContext and public tree
  checked against its record; removals derived from applied Remove and
  SelfRemove proposals and required to match exactly (issue #817).
  `EpochRecordV1` and `epoch_record` in `crate/src/session.rs`; decoder
  `decodeEpochRecord` in `crate/src/lib.rs`.
- Provisional admission: `begin_join`, `complete_join`, `discard_join`,
  `begin_rejoin`, `complete_rejoin`, `confirm_rejoin`, `discard_rejoin`,
  `archive_key` in `session.rs`.
- Checkpoints: see section 6. Today a join replays from epoch zero.

### 4.4 Exporter, PSK and epoch authenticator

- Project key: `MLS-Exporter("openzcad project key", project id, 32)`
  (`project_key`, `PROJECT_KEY_LABEL`); rejoin PSK:
  `MLS-Exporter("openzcad rejoin psk", project id, 32)` registered as
  `ozc-rejoin/<epoch>` (`rejoin_psk`, `enter_epoch`, `REJOIN_PSK_LABEL`,
  `rejoin_psk_id`); `epoch_authenticator` feeds `epochBinding` (section
  3.8). All in `session.rs` and `model.rs`.
- Key epoch = group key-epoch base plus MLS epoch, monotonic across resets
  (decision D10); every epoch's project key and rejoin PSK are also wrapped
  under each member's account key (decision D1); older epochs come from
  account-key wraps or key archives (`projectKeyForEpoch`,
  `epochAuthenticatorForEpoch` in `projectGroups.ts`).
- In-WASM storage: `GroupStore` (`EPOCH_RETENTION` 3) and `PskStore` in
  `crate/src/storage.rs`.

### 4.5 Sealed storage

- The exported session (`export` and `import` in `session.rs`,
  `STATE_VERSION` 2; version 1 is refused) holds the leaf signing key and
  group secrets. It leaves the Worker only sealed: `sealState`, `openState`
  in `packages/mls/src/sealed.ts` (magic `OZMS`, version 1, a 12-byte
  IV, then ciphertext and tag; the AAD binds the project id; AES-256-GCM
  under a non-extractable key from `generateStateKey`).
- App store: `indexedDbMlsSessionStore` in
  `apps/web/src/lib/e2ee/mls/sessionStore.ts` (database
  `openzcad-e2ee-mls`, one state key per account, Web Lock per project,
  compare-and-swap on a revision so two tabs cannot fork a group).

### 4.6 TypeScript engine, client and protocol (`packages/mls/src/`)

- `loadMls` in `index.ts` starts the module Worker (`worker.ts`) lazily,
  outside the entry chunk; `connectEngine` and `serveEngine` in
  `protocol.ts`; `MlsEngine` in `engine.ts` wraps the WASM; `Mls` and
  `MlsSession` in `client.ts` are the API; errors and policy reason codes
  in `errors.ts`; JSON shapes in `types.ts`. `insecureSkipSendChecksForTests`
  and the in-process engine are deliberately not exported.

### 4.7 App-side session code (`apps/web/src/lib/e2ee/mls/`, `projectGroups.ts`)

- `MlsProjectSessions` in `mls/projectSessions.ts` (lock, reopen, install
  the directory, seal and store before returning anything to send);
  `mlsLoader` in `mls/loader.ts`.
- `projectGroups.ts`: `createProjectGroup`, `joinProjectGroup` (own devices
  by External Commit, decision D3), `joinProjectByWelcome`,
  `commitProjectGroup`, `catchUpProjectGroup`, `changeMemberRole`,
  `removeMember`, `leaveProject` (SelfRemove), `commitPendingDepartures`,
  `postOwnEpochKeys`, `epochRoles`, `recoverProjectGroup`,
  `resetProjectGroup`.
- Historical authority: `epochAuthority` invokes the stateless Rust policy
  verifier, verifies embedded leaf certifications from bounded untrusted
  roster hints, and returns the exact authenticated roster and roles. Head,
  retained-revision, replaced-envelope and version-log checks require the
  author's device in that roster. Read-only approved devices use the same
  path without creating a session or leaf.
- Independent trust: `projectAuthority.ts`, `projectAuthorityStore.ts`,
  `packages/crypto/src/mls-authority.ts`, and key-archive body version 2.
  Inspect owner intent from creation and verified recipient-bound
  invitations, immutable generation roots/bases, periodic owner checkpoints,
  account-key MAC plus certified-device signature, sequence/context pins,
  CAS and lost-response recovery, revoked-device refusal and repair,
  reset-root retention, and key-session cleanup. Replay must reach the
  independently accepted terminal GroupContext, including when checking
  an older epoch; a competing policy-valid chain is insufficient. A reset
  root carries its predecessor's terminal GroupInfo and an identity-signed
  version-2 reset whose hash binds the prior immutable roots and exact
  state. That explicit approval permits solo cold recovery from a retired
  last writer; ordinary reads still refuse an unpinned retired signer.
  A cold shared replacement with independent expected-owner intent may
  instead verify the archive's owner-signed roots and full transcript,
  join, and CAS-publish its own account record without adopting any part
  of the retired record.
  The separate IndexedDB database is `openzcad-e2ee-project-authority`.

### 4.8 The Worker as Delivery Service

- `apps/web/worker/e2eeProjects.ts`, routes
  `/api/e2ee/projects/:id/(mls/commits|mls/group-info|mls/leaves|mls/proposals|keys|keys/archives)`:
  `createGroup`, `submitCommit` (first valid Commit per epoch wins,
  `refuseIfEpochTaken`; the Commit lands in one D1 batch with its
  GroupInfo, account-wrapped keys and key archive), `postWraps`,
  `listCommits`, `listLeaves`, `listArchives`; `requireCertifiedDevice`
  and `requireCertifiedSigner` check the sender against the newest device
  list. Membership mirror and proposals: `prepareMembershipCommit`
  (`e2eeMembership.ts`), `postProposal`, `prepareProposalSettlement`
  (`e2eeProposals.ts`). It never sees a project key, PSK or MLS secret.
- `/api/e2ee/projects/:id/authority` (`e2eeProjectAuthority.ts`, migration 0044) stores only the caller's signed opaque trust record with CAS,
  membership/session/device-list fences and erasure cleanup. The browser
  verifies its account MAC; the Worker can verify only the public signature.

### 4.9 The encrypted room

- `E2eeRoomLedger` in `packages/cloudflare-adapters/src/e2ee-room.ts` and
  the Worker's `ProjectCollaborationRoom` in `apps/web/worker/e2eeRoom.ts`:
  the room relays signed envelopes it cannot read, orders them by the
  header's previous-version hash and version under the group's current key
  epoch, keeps up to `MAX_E2EE_ROOM_RETAINED` (20) older envelopes as merge
  bases, and writes through the same `writeVersion` fences
  (`roomVersionStore`). It does not carry MLS handshake messages; those go
  through the routes in 4.8.
- Browser codec: `createEncryptedRoomCodec` in `encryptedRoomCodec.ts`
  (every relayed head is a current-head read; a viewer seals nothing,
  through `requireOwnEditingRole` in `encryptedProjectStore.ts`).

## 5. Tests, vectors and fuzzing

Root Vitest (`pnpm exec vitest run`) and web Vitest (`pnpm test:web`) are
separate projects; `pnpm test` runs both. Single files run with
`pnpm exec vitest run <path>` from the root, or
`pnpm --filter @openzcad/web exec vitest run <path>` for `apps/web/src`.

| Suite                       | Files                                                                                                                                                                                                                                                    | Run                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Crypto unit tests           | `packages/crypto/src/*.test.ts` (envelope, wrap, signing, version-log, devices, contacts, share-links, invitations, bodies, account-records, assistant-consent, external-keys, portability)                                                              | `pnpm exec vitest run packages/crypto`                                    |
| Fixed vectors               | `packages/crypto/src/vectors.test.ts` (re-derives nonce layout, both envelope classes, wraps and the epoch binding with raw WebCrypto)                                                                                                                   | same                                                                      |
| Seeded parser fuzzing       | `packages/crypto/src/fuzz.test.ts` (every server-supplied parser fails only with `E2eeError`)                                                                                                                                                            | same                                                                      |
| Crypto in real browsers     | `packages/crypto/browser/scenarios.ts`; Node mirror `test/crypto-browser-scenarios.test.ts`                                                                                                                                                              | `pnpm --filter @openzcad/crypto test:browser`                             |
| MLS scenarios               | `packages/mls/src/scenarios.ts`, run in-process and through the Worker protocol by `src/mls.test.ts`                                                                                                                                                     | `pnpm exec vitest run packages/mls`                                       |
| MLS package checks          | `packages/mls/src/pkg.test.ts` (BUILD.json, pins), `sealed.test.ts`, `protocol.test.ts`, `boundary.test.ts`, `certification.test.ts`                                                                                                                     | same                                                                      |
| MLS in real browsers        | `packages/mls/browser/` (module Worker in Chromium, WebKit, Firefox; checks no WASM in the entry chunk)                                                                                                                                                  | `pnpm --filter @openzcad/mls test:browser` (`-- --chromium-only` for one) |
| MLS crate (Rust)            | `#[cfg(test)]` in `packages/mls/crate/src/session.rs` (archive omissions, fabrications, reordering, trailing bytes, retry)                                                                                                                               | `cd packages/mls/crate && cargo test --locked`                            |
| Desktop device keys (Rust)  | `apps/desktop/device-keys/src/lib.rs` tests; the Tauri commands and Keychain run only in the manual Apple Silicon workflow (`.github/workflows/macos-desktop.yml`)                                                                                       | `cargo test --locked --manifest-path apps/desktop/device-keys/Cargo.toml` |
| App MLS and key logic       | `apps/web/src/lib/e2ee/**/*.test.ts`, e.g. `mls/directory.test.ts`, `mls/projectSessions*.test.ts`, `mls/epochRoles.test.ts`, `projectGroups.test.ts`, `versionPins.test.ts`, `contactPins.test.ts`, `deviceStore.test.ts`, `keychainDeviceKeys.test.ts` | `pnpm test:web`                                                           |
| Worker and flows end to end | `test/e2ee-*.test.ts` (account keys, passkeys, device removal, contacts, project groups, documents, content blobs, room, invitations, member roles and removal, share links and visitor, assistant consent, migrations and reverse path, and more)       | `pnpm exec vitest run test/e2ee-`                                         |
| Playwright                  | `test/e2e/encryption-*.spec.ts`, `test/e2e/encrypted-*.spec.ts`, `test/e2e/mls-client.spec.ts`                                                                                                                                                           | `pnpm test:e2e` (builds with `VITE_E2E=1` and serves the app)             |

The browser runs need Playwright browsers
(`pnpm exec playwright install chromium webkit firefox`) and are not part
of `pnpm test`. The `test/e2ee-*` suites run the real Worker, its room
class and SQLite with Node devices and the in-process MLS engine. Rust
`cargo fuzz` targets do not exist; MLS parsing relies on mls-rs's codec
and on the scenario and archive tests.

## 6. Known limitations and deferrals

- **Fork consistency only.** A server can keep members on separate
  branches forever. An independently accepted account state now rejects a
  competing MLS transcript, including on a fresh browser, but a participant
  with no previous independent state can still receive a consistent fork.
  The manual anchor is the full 40-digit project state code
  (`projectStateCode`), shown in the top-bar project information and sharing
  dialog from this page's verified saved head (slice 8-C5a). It binds that
  version's hash, version number and signing member's identity fingerprint.
  Locked keys, failed verification and teardown hide it. No transparency
  log or automatic gossip.
- **Web code delivery.** The server ships the JavaScript; publishing bundle
  hashes next to `/build-meta.json` narrows but does not close this. The
  signed desktop app is the stronger client.
- **mls-rs is unaudited** and publishes no advisories; OpenMLS (audited by
  SRLabs, 2026-05-27) passed the same spike scenarios and stays the
  fallback (`docs/plans/mls-spike-2026-10.md`).
- **MLS crypto runs in RustCrypto inside WASM**, not WebCrypto: the
  `mls-rs-crypto-webcrypto` provider failed every Commit in Safari and
  WKWebView (`KeyDerivationError`). Everything outside MLS stays on
  WebCrypto. The provider can be adopted once it passes the WebKit run.
- **Checkpoint and historical authority bounds.** The implementation from #959
  produces owner checkpoints, verifies old author membership with the
  native policy, and binds replay to independent owner intent and accepted
  terminal state (section 4.7). It permits at most 8,192 records and 64 MiB
  per replay; a longer history needs a newer certified owner checkpoint.
  Revoking the checkpoint signer requires full replay or a fresh checkpoint.
  The held #968 follow-up applies those budgets to native join/rejoin replay
  as well, with raw-WASM checks before copying archive arrays. Welcome
  failures roll back; failed archive downloads during an accepted provisional
  rejoin remain retryable. Cadence tests drive a real group through epoch 256
  and exercise refresh after an owner-device revocation.
- **Recovery enrollment without pins.** A recovery key authenticates the
  identity, not the freshness of a device-list head supplied to a pin-less
  browser. A consistent pre-removal fork may issue new wraps to a removed
  device; later fork detection cannot undo disclosure. Prefer approval from
  an existing unlocked device, whose verified head is transferred. The
  recovery screen and ADR state this limitation explicitly.
- **Cutoff head freshness.** A removal statement may bind a server-advertised
  head newer than the browser's saved pin. This is the existing removal
  tradeoff: a later post-rotation member write rejects the old epoch; the
  signature alone does not establish an independently witnessed latest head.
- **Authenticated config visibility.** `/api/e2ee/config` exposes the global
  `plaintextFrozen` bit to authenticated accounts, including accounts outside
  the canary. It carries no project/account state and supports legacy-write
  refusal; it is not an account enrollment signal.
- **Contacts on a fresh device.** Version-2 device approval grants carry
  the approver's contacts head and confirmation state. Durable main and
  pending pins reject older prefixes and conflicts transactionally. An
  account-key-only enrollment or a version-1 grant leaves contacts seen
  until this device compares them or receives authenticated confirmation.
  Empty approval heads transfer no trust. See
  [the implementation evidence](../roadmap-evidence/l11--approval-contacts-head.md).
- **Archive verification limits** (ADR #817 resolution): it authenticates
  the public transcript and removals, not historical device-list
  authorization from today's revocations, historical PSK possession or the
  secret schedule. Unknown-time revocations count as historical credentials
  only within an independently accepted prefix whose exact GroupContext
  and tree the native verifier reaches before returning any authority.
  Signed cutoffs remain enforced there; live joins retain the conservative
  unknown-time fence. Document-author cutoff checks are separate and do not
  accept that prefix as a replacement for a signed cutoff.
- **Passkey qualification.** Chromium virtual-authenticator tests only;
  real authenticators, Safari, platform passkey providers and desktop are
  not qualified. The desktop WebView has no WebAuthn.
- **Safari storage eviction.** Safari clears a site's IndexedDB after seven
  days without a visit unless installed to the Home Screen, deleting device
  keys, pins and MLS state. The user unlocks again with a passkey or the
  recovery key, the device rejoins its groups by External Commit, and its
  version and device-list pins start again from what the server shows.
  Contacts remain unconfirmed until independently confirmed as above.
- **D1 Time Travel and the room's point-in-time recovery** keep migrated
  plaintext for up to 30 days after the purge.
- **Unrecoverable accounts** are accepted: no escrow.
- **Activation and deletion held for outside review.** Default-on gates,
  plaintext freeze, sign-in auto-migration and browser legacy reads are
  implemented behind off-by-default flags. Production activation and the
  plaintext-pipeline deletion (8-5) remain held until written outside-review
  clearance; the review is not completed. The review tag and SHA above
  must be frozen before that review begins.
- **Experimental archive-format cutover.** Migration 0044 refuses an
  installation containing any earlier MLS groups, before supported deploy
  commands publish code. V1 archives cannot supply the independent roots
  this verifier requires, and the server must not invent them. Such
  installations retain the prior release until owners authorize the
  documented client-side transition in
  [Self-hosting](../SELF_HOSTING.md#flags). There is no automatic
  encrypted-to-encrypted legacy upgrader; owners who cannot consent to
  the temporary plaintext reverse path must retain the prior release.
- **Earlier deferred findings now implemented:** share-server storage,
  write fences, signed registration and anonymous repetition budgets
  ([8-C1 evidence](../roadmap-evidence/l11--share-links-hardening.md));
  durable browser reissue work and owner-removal refresh
  ([journal](../roadmap-evidence/l11--share-work-journal.md),
  [refresh](../roadmap-evidence/l11--owner-removal-share-refresh.md));
  authenticated link-set ancestry (#957,
  [evidence](../roadmap-evidence/l11--share-set-ancestry.md)); native bounded
  blob streaming and renderer-reload expiry (#938/#940,
  [streaming](../roadmap-evidence/l11--desktop-blob-streaming.md),
  [expiry](../roadmap-evidence/l11--native-blob-expiry.md)); and migration
  sweep and lease fences (8-C4). Linux native verification covers those
  desktop fixes; macOS qualification remains explicitly deferred.

## 7. Questions for the reviewer

1. **mls-rs 0.56.0 itself.** Is the crate at this version, with the
   features in `Cargo.toml` and the RustCrypto provider 0.22.1, sound for
   suite 0x0002? Anything in its external-Commit, PSK, by-reference
   proposal or SelfRemove handling that `filter_proposals` cannot see?
2. **Policy completeness.** Can any Commit or proposal pass
   `check_member_commit` or `check_external_commit` that the ADR forbids,
   in particular role changes by non-owners, a rejoin with a stale PSK, a
   revoked credential's content, or a recovery Add with an old key?
3. **Directory snapshot and pins.** Is verifying device lists and leaf
   certifications in TypeScript and handing the policy a snapshot
   (`buildDeviceDirectory`) free of time-of-check gaps, including
   `UNSIGNED_SHARED_CUTOFF` and the `activeAt` history exception? How much
   do the authenticated contacts-head handover and transactional main and
   pending pins preserve trust during approval and concurrent list loads?
4. **Archive replay.** Does `archive.rs` bind the final state to the
   joining GroupInfo strongly enough, and does provisional admission ever
   let unverified keys reach document use?
5. **Epoch binding and authorship.** Is a version's authority (epoch
   binding, signer device certified, leaf with an editing role in that
   epoch, revocation cutoffs) enforced on every read path: account load,
   historical read, the room, share snapshots, migration?
6. **Project state code.** `projectStateCode` hashes the version hash,
   document version and signer identity hash; the epoch authenticator is
   covered only through the header's `epochBindingHash`, which the version
   hash covers. Is that enough for out-of-band comparison?
7. **Short codes.** The device-approval code is
   `getUint32(0) % 1_000_000`. Is the commitment exchange, its rate limits
   and the slight modulo bias acceptable?
8. **AES-KW and engines.** Is the re-wrap check in `unwrapKey` a sound
   replacement for an engine that skips RFC 3394's integrity check? Any
   other WebCrypto engine difference that matters?
9. **Nonce discipline.** Any path that could encrypt two envelopes under
   one `EnvelopeKey`, or reuse a random-IV GCM key near its limits?
10. **Share links.** Do the delegation and statement bounds (30 and 7
    days, 10-minute skew) hold for a stolen owner device or a former
    editor, including the 8-C1 server guards and durable 8-C2 reissue work?
11. **Sealed MLS state.** Is sealing with an account-scoped non-extractable
    key, the project id in the AAD and a revision CAS enough against tab
    races and rollback of local state?
12. **Migration.** Can the lease, cutover or purge leave plaintext readable
    after cutover (beyond the stated 30-day retention), or let an
    unrevoked-then-removed device keep authority over staged content? Is
    the reverse path safe to keep until 8-5 deletes it?
13. **Reproducibility.** Does `packages/mls/build.sh --check` reproduce
    `pkg/` byte for byte on your machine at the review commit?

## 8. Finding intake

- Report anything exploitable privately, as
  [SECURITY.md](../../SECURITY.md) describes (GitHub private vulnerability
  reporting is currently disabled, so first ask for a private channel
  without details). Everything else, and each private finding once fixed,
  becomes a GitHub issue in `esaueng/OpenZCAD` titled
  `ADR-024 review: …`, naming the review commit, the file and line, the
  severity and a reproduction with synthetic data where possible.
- Severity: **P0** breaks confidentiality or integrity of stored project
  contents or keys against the stated adversary; **P1** breaks a stated
  guarantee under realistic conditions (rollback beyond fork consistency,
  authority bypass, key reuse, a removed device keeping access to later
  versions); **P2** defense-in-depth gaps, robustness and denial of
  service; **P3** documentation and hardening suggestions.
- **Any open P0 or P1 blocks `E2EE_DEFAULT_ON` and the held deletion PR
  (8-5).** Neither proceeds while any P0 or P1 is open: each must be fixed,
  with a regression test, and the reviewer must confirm the fix.
- P2 and P3 findings go to follow-up PRs and do not block default-on
  unless the maintainer decides otherwise.
- A finding in mls-rs itself is reported upstream as well; if it cannot be
  fixed or mitigated in time, the fallback is OpenMLS, per the ADR.
- The review is complete when the reviewer confirms in writing that every
  P0 and P1 is resolved; the maintainer then records that confirmation on
  roadmap row L11.
