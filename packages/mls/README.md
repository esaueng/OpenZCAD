# @openzcad/mls

The MLS group-key layer of [ADR-024](../../docs/adrs/ADR-024-end-to-end-encrypted-projects.md)
("MLS assessment", roadmap L11). Each encrypted project is one MLS group;
each device of each member is one leaf. Nothing in `apps/` imports this
package yet: Phases 3 and 5 wire it in.

- **Library:** `mls-rs` 0.56.0 with `mls-rs-crypto-rustcrypto` 0.22.1, cipher
  suite 0x0002 (P-256, AES-128-GCM, SHA-256) and no other. Every MLS crate is
  pinned with `=` in [`crate/Cargo.toml`](crate/Cargo.toml); a bump is a
  reviewed change of its own. Licences: Apache-2.0 OR MIT for the MLS crates;
  the full tree is in [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md).
- **Runtime:** the Rust crate is compiled to WASM (`pkg/`, committed) and run
  in a module Worker that `loadMls()` starts on first use, so the ~1 MB WASM
  stays out of the entry chunk. The crypto core (`@openzcad/crypto`) stays on
  WebCrypto.

## Use

```ts
const { loadMls, generateStateKey } = await import('@openzcad/mls');
const mls = loadMls();
const session = await mls.generate({ projectId, userId, deviceId });
await session.certify(
  await signWithDeviceKey(await session.certificationPayload())
);
await session.setDirectory(verifiedDeviceLists); // before any other operation
const created = await session.createGroup();
// Archive created.epochRecord, then each accepted Commit's epochRecord.
const projectKey = await session.projectKey();
const sealed = await session.seal(stateKey); // non-extractable AES-256-GCM
```

| Operation                               | Methods                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| Leaf key, certified by the device key   | `generate`, `certificationPayload`, `certify`                                            |
| Create; KeyPackage; Add + Welcome; join | `createGroup`, `keyPackage`, `commit({ add })`, `join`                                   |
| Update, Remove, roles                   | `proposeUpdate`, `commit({ remove, setRoles, dropUsers })`                               |
| Leave                                   | `proposeSelfRemove` (another member commits it)                                          |
| The room accepts or rejects a Commit    | `confirmCommit`, `discardCommit`                                                         |
| Incoming proposals and Commits          | `process`                                                                                |
| Rejoin by external Commit               | `groupInfo`, `inspectGroupInfo`, `rejoin`, `confirmRejoin`, `discardRejoin`, `rejoinPsk` |
| Keys and codes                          | `projectKey`, `epochAuthenticator`                                                       |
| History archive                         | `EpochChange.epochRecord`, `decodeEpochRecord`                                           |
| Verify members before joining           | `inspectWelcome`, `leafCertificationPayload`                                             |
| Persist                                 | `seal`, `Mls.open`                                                                       |

Seal and store the session after every operation that changes it, before
sending its output to the room. A reopened session needs `setDirectory` again.
Keep the accepted epoch records separately in the encrypted history archive.
Both `join(welcome, history)` and `rejoin(groupInfo, { psk, history, ... })`
require an ordered array of every record from epoch zero through the Welcome
or GroupInfo epoch. Deliver the Add's accepted epoch record with its Welcome.
Missing history is an error; retrying a failed join preserves its KeyPackage.

For an encrypted archive, use the staged API. `beginJoin(welcome)` opens a
provisional group and `archiveKey()` yields its exporter for decrypting the
key archive and epoch records in the browser. Call `completeJoin(history)`
only with those decrypted records, or `discardJoin()` to restore the prior
session. Normal group operations remain blocked until verification succeeds;
the provisional key and decrypted content are untrusted for document use.

A rejoin can use `beginRejoin(groupInfo, { psk, replaceLeaf? })` when it cannot
decrypt the old epoch's archive. Seal the provisional state, send its external
Commit, and wait for the room's decision. Established members independently
validate that Commit before supplying the archive encrypted under the **new**
epoch's exporter. The joiner decrypts it with `archiveKey()`, calls
`completeRejoin(history)` with the chain through that new epoch, then
`confirmRejoin()` after room acceptance. Completion also rechecks the original
request against the authenticated pre-Commit removal cutoffs; the replacement
in this Commit does not count as its own prior removal. `confirmRejoin()`
refuses an unverified archive. A malformed archive leaves the provisional
external rejoin available for retry, including across `seal`/`open`, because
the room may already have accepted its Commit. A verified policy rejection
or explicit discard restores the prior state. If no established member can supply the archive,
recover the account-key-wrapped project keys and use `rejoin(..., { history })`,
or the ADR's recovery Add/reset path; missing history is never accepted.

Epoch records and sealed session contents are now version 2. Version 1 sessions
are refused because their removal state may have trusted an inviter's omissions;
there is no automatic migration. Version 2 records add the signed epoch-zero
GroupInfo needed to bootstrap transcript replay. This is a breaking change to
the package's API and stored state; the application does not use the package yet.

## Policy

The rules run in `MlsRules::filter_proposals` (when sending and when
receiving) and `IdentityProvider` ([`crate/src/policy.rs`](crate/src/policy.rs)).
A refusal is an `MlsError` of kind `policy` whose `reasons` carry stable codes.

- **Roles** live in a GroupContext extension (0xF0A1): owner, editor or viewer
  per identity, the epoch each role took effect (`since`) and the rejoin
  window, so every member applies the same window. Exactly one owner.
- **Only the owner** changes the extension: adds identities, changes roles,
  drops identities (with all of their leaves, in the same Commit).
- **Any member** may Add a leaf for an identity already listed, with its
  existing role. Such a recovery Add, whoever commits it, needs a leaf key
  certified at or after the identity's latest leaf removal (`certifiedEpoch` in the
  directory). A leaf key once removed from the group is never added back.
- **Otherwise a member changes only its own identity:** Update of its leaf,
  SelfRemove, Remove of another leaf of its own identity. Viewers' Commits
  therefore change nobody else's access; they may still carry other members'
  SelfRemove and Update proposals. (ADR-024 says both "viewers may commit only
  Updates of their own leaves" and "any current member" may commit the
  recovery Add and the departing member's removal; this is the reading that
  satisfies both.)
- **Credentials** (0xF0A2: user id, device id, the device's certification of
  the per-project leaf key) are checked against an injected device-list
  verifier (`DeviceListVerifier`, fed by `setDirectory`). New leaves must be
  certified by an unrevoked device; nothing signed by a revoked credential is
  accepted. A tree being joined may still hold a revoked leaf awaiting its
  Remove.
- **External Commits are rejoins** and follow every ADR rule: the identity is
  listed; the credential is certified and not revoked; exactly one PSK
  `ozc-rejoin/<epoch>` (the exporter `openzcad rejoin psk`, context the
  project id) whose epoch is no earlier than the user's newest device
  revocation, the identity's latest role change (a removal drops the identity;
  a re-add sets a new `since`) and the latest recorded Remove of a leaf with
  the same device or key; inside the window; at most one Remove, of the
  joiner's own user.
- **The last-leaf exception:** when every remaining leaf of a user carries a
  revoked credential, the replacement the revocation named may rejoin with a PSK from
  before that leaf's own revocation (never before a later revocation of
  another device), if the same external Commit removes one of those leaves.
  An external Commit removes at most one leaf, so the replacement removes the
  rest in its next Commit; until then they can sign nothing anyone accepts.

Leaf-removal records come from the group's own Commits. A member who joins
by Welcome, or rejoins, derives them by replaying the complete public epoch
transcript with the pinned `mls-rs` observer. It verifies signatures, tree
evolution and transcript hashes, compares each record's context and tree,
and binds the result to the joining MLS GroupContext. GroupInfo removal
hints (the former extension 0xF0A3) are neither sent nor trusted.

The observer does not know historical epoch secrets, so this replay does not
verify historical confirmation MACs, PSK possession or application permissions.
The real MLS join or external Commit builder still verifies the current
cryptographic state and credential policy. Archive replay remains possible
after a historical device is revoked. This prevents omitted removal history
within the accepted transcript; it does not prevent a malicious insider from
inviting someone into an entirely different group fork.

## Build and test

```bash
packages/mls/build.sh          # rebuild pkg/ (Rust 1.96.0, wasm-bindgen CLI 0.2.126)
packages/mls/build.sh --check  # fresh build; fails unless byte-identical to pkg/
pnpm exec vitest run packages/mls
pnpm --filter @openzcad/mls test:browser
```

`build.sh` uses the toolchain in `crate/rust-toolchain.toml`, `--locked`, and
remaps absolute paths, so the WASM is identical wherever the repository
lives. `src/pkg.test.ts` checks `pkg/` against `pkg/BUILD.json` and the
exact pins. `BUILD.json` also records the hash of every crate source, so a
Rust change committed without rebuilding `pkg/` fails `pnpm test` in CI,
which has no Rust toolchain to rebuild it. The scenario suite (`src/scenarios.ts`) runs in Node in-process
and through the Worker protocol (`src/mls.test.ts`, part of `pnpm test`),
and `test:browser` runs it in a real module Worker in Chromium and WebKit
(Playwright browsers required; `-- --chromium-only` skips WebKit).
