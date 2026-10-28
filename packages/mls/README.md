# @openzcad/mls

The MLS group-key layer of [ADR-024](../../docs/adrs/ADR-024-end-to-end-encrypted-projects.md)
("MLS assessment", roadmap L11). Each encrypted project is one MLS group;
each device of each member is one leaf. The browser integrates it through
`apps/web/src/lib/e2ee/mls/` for live sessions, joins and stateless historical
authorization.

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
// certifiedEpoch: the group's current epoch (0 for a group about to be created)
await session.certify(
  await signWithDeviceKey(await session.certificationPayload(certifiedEpoch))
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
| History archive                         | `EpochChange.epochRecord`, `decodeEpochRecord`, `JoinArchive`                            |
| Verify members before joining           | `inspectWelcome`, `leafCertificationPayload`                                             |
| Persist                                 | `seal`, `Mls.open`                                                                       |

Seal and store the session after every operation that changes it, before
sending its output to the room. A reopened session needs `setDirectory` again.

For an encrypted archive, `beginJoin(welcome)` opens a provisional group and
`archiveKey()` yields its exporter for decrypting the key archive and epoch
records in the browser. Supply the resulting `JoinArchive` to
`completeJoin(archive)`, or call `discardJoin()` to restore the prior session.
Normal group operations remain blocked until verification succeeds; the
provisional key and decrypted content are untrusted for document use.

If a rejoin cannot decrypt the old epoch's archive, use
`beginRejoin(groupInfo, { psk, replaceLeaf? })`, seal the provisional state,
and submit its external Commit. Established members independently validate
that Commit before supplying the archive under the **new** epoch's exporter.
Decrypt it with `archiveKey()`, call `completeRejoin(archive)` with the chain
through the new epoch, then `confirmRejoin()` after room acceptance.
Completion rechecks the original request against its authenticated pre-Commit
removal cutoffs; this Commit's replacement is not its own prior removal.
Normal operations and unverified confirmation remain blocked across `seal`/`open`.
A malformed archive preserves an accepted provisional rejoin for retry;
verified policy rejection or explicit discard restores the prior state. A
solo recovery uses the account-key-wrapped historical project keys with
`rejoin(..., { archive })`, or the ADR's recovery Add/reset path.

All native transcript replay and raw WASM join/rejoin admission is bounded to
8,192 supplied epoch records and 64 MiB of input. A checkpoint starts the
count at its own epoch; a high absolute epoch is permitted with a short valid
suffix. Oversized arrays are refused before copying them into WASM memory.
Failed Welcome completion rolls back the provisional join, while a malformed
or oversized rejoin archive preserves the accepted provisional rejoin for a
retry. A newer certified owner checkpoint is required for longer histories.

The public session and production Worker protocol expose no sender-check
override. Receiver-policy scenarios use the internal test helper and a
separate, explicitly enabled test Worker; production `worker.ts` refuses
even a directly forged request for that method.

Ownership transfer is unsupported by the application's encrypted-project
routes. Although a raw MLS group can change its owner role, full-history
admission across that transfer fails closed because replay requires the
anchor and target to name the same trusted owner. Do not use a raw role
change as a supported project transfer or recovery operation.

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
  directory). A member Add never reuses a previously removed leaf key.
  External rejoins instead enforce the same-device/key removal cutoff through
  their PSK fence; they do not apply the member-Add key-reuse rule.
- **The certified epoch is signed.** The leaf certification payload
  (`leafCertificationPayload`, `certificationPayload`) is the MLS encoding of
  the label `openzcad mls leaf certification v2`, project id, user id, device
  id, cipher suite, leaf key and `certifiedEpoch` (u64): the group's current
  epoch when the device certified the key. The policy cannot verify
  signatures, so the app sets `certifiedEpoch` in the directory only from a
  certification whose signature it has checked over that epoch; a server
  cannot move it. Version 1 of the payload (no epoch, label `... v1`) is
  no longer produced.
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
  revoked credential and each revocation names this joiner as replacement,
  it may rejoin with a PSK from before those stale leaves' revocations if the
  same external Commit removes one of them. The exception waives the
  revocation cutoffs of all those stale leaves, including ones not removed
  by this Commit. Other revoked devices' cutoffs still apply, as do the
  role-change, prior same-device/key removal and rejoin-window fences.
  An external Commit removes at most one leaf, so the replacement removes the
  rest in its next Commit; until then they can sign nothing anyone accepts.

Leaf-removal records come from the group's own Commits. A signature on the
committer's GroupInfo (extension 0xF0A3) alone cannot prove those records are
complete: an inviter could omit a removal and make a joiner accept a stale
rejoin or removed signing key that established members reject (#817).

Both `join(welcome, archive)` and `rejoin(groupInfo, { psk, archive, ... })`
therefore require a `JoinArchive`: retain the signed epoch-zero `groupInfo()`
at group creation, then append every accepted `EpochChange.epochRecord` for
epochs 1 through the joining epoch, including the Commit producing the Welcome.
The app decrypts these records before completing admission. The verifier uses
mls-rs's public observer to authenticate proposals and Commits, checks each
record's context and tree and the final joining context/tree, and derives
removals from the applied proposals and prior roster. Carried removals must
match exactly, independent of order or duplicate entries; missing history,
omitted records and fabricated records fail closed. Failed joins restore the
session and its one-use KeyPackages, so a valid invitation can be retried.

This authenticates the public transcript, not historical device-list policy,
PSK possession or the secret key schedule. Live credential, role, and rejoin
checks still run unchanged. Today's revocations do not retroactively invalidate
old archived signatures. Full replay from epoch zero is currently required;
checkpoint-based replay remains future work. A malicious inviter can still
present an entirely different group fork to a new device without a prior pin;
this is the existing fork-consistency limit, not proof of the same history.
The archive argument is a required API change in this private package, which
has no application callers yet. `EpochRecordV1` and `JoinArchive` stay unchanged.
Sealed session contents now use version 2: version 1 sessions are refused
because their stored removal records may have trusted an inviter's omissions.
The sealed envelope format is unchanged; no automatic session migration is
provided. Rust rejects revoked devices without an explicit revocation cutoff,
matching the TypeScript directory guard; cutoff zero remains valid.

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
and `test:browser` runs it in a real module Worker in Chromium, WebKit and
Firefox (Playwright browsers required:
`pnpm exec playwright install chromium webkit firefox`; `-- --chromium-only`
runs Chromium alone).
