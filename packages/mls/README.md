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
await session.createGroup();
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
  existing role. When a non-owner does, the leaf key must be certified at or
  after the identity's latest leaf removal (`certifiedEpoch` in the
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
by Welcome, or rejoins, starts from the records in the committer's signed
GroupInfo (extension 0xF0A3); records can only make rejoin stricter.

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
exact pins. The scenario suite (`src/scenarios.ts`) runs in Node in-process
and through the Worker protocol (`src/mls.test.ts`, part of `pnpm test`),
and `test:browser` runs it in a real module Worker in Chromium and WebKit
(Playwright browsers required; `-- --chromium-only` skips WebKit).
