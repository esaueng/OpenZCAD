# MLS library spike — October 2026

Roadmap: [L11](../../ROADMAP.md#l11) ([ADR-024](../adrs/ADR-024-end-to-end-encrypted-projects.md), "MLS assessment"). Spike code: [`spikes/mls/`](../../spikes/mls/).
Nothing in `apps/` or `packages/` imports it.

**Decision (2026-10-19):** the owner chose mls-rs with the RustCrypto
provider, as recommended below. ADR-024 records it in
[PR #757](https://github.com/esaueng/OpenZCAD/pull/757). The Phase 8 outside
review covers the MLS integration and the pinned mls-rs version.

## Recommendation

Use **mls-rs 0.56 with its RustCrypto provider** (`mls-rs-crypto-rustcrypto`),
built to WASM and run in a module Worker. Do not use its WebCrypto provider
yet. Keep OpenMLS as the fallback: it passed the same scenario.

Why:

- **The WebCrypto provider does not work in Safari or WKWebView.** It fails
  every Commit with `KeyDerivationError` in Safari 27.0.1, Playwright WebKit
  26.6 and Node 22. It works only in Chrome. The macOS desktop shell is
  WKWebView, so this rules it out. The cause is described below; it needs an
  upstream fix.
- **The policy hooks fit ADR-024.** Role checks live in one callback that
  runs both when sending and when receiving (`MlsRules::filter_proposals`).
  Device certification and the "own devices only" external-commit rule live
  in `IdentityProvider`. OpenMLS has no hook. The app has to inspect every
  `StagedCommit` before merging it, and there is no check when sending.
- **The rejoin rules fit as one more policy clause.** They run before PSK
  lookup, so every refusal names its reason. Neither library can carry a
  resumption PSK in an external Commit. Both can carry an exporter-derived
  epoch PSK, which the spike uses (see "Rejoin by external Commit").
- **A wiped device rejoins in one Commit.** mls-rs's
  `external_commit_builder().with_removal(old_leaf)` replaces the stale leaf
  with the device's new key, gated by `valid_successor`. OpenMLS removes a
  stale leaf only when the signature key matches. A wiped browser has lost
  that key, so another member must commit a separate Remove, which takes an
  extra epoch.
- **Smaller state and binary.** Complete device state is 4.0–4.4 KB against OpenMLS's
  25–30 KB. The lazy WASM is 407 KB gzip against 579 KB.
- **Permissive licences only.** OpenMLS pulls `hpke-rs` (MPL-2.0).
- **The risk: mls-rs has no third-party audit.** Its README says it "has not
  yet received a full security audit by a 3rd party". It publishes no
  security advisories. OpenMLS has had more outside scrutiny: five GitHub
  advisories since 2025, all fixed by 0.9.1. ADR-024's planned outside review
  (Phase 8) must cover the MLS integration and the chosen library version.

The ADR wants WebCrypto only, and this choice departs from that. MLS
primitives would run in RustCrypto inside WASM. Project envelopes (Phase 2)
can stay on WebCrypto. The Worker harness is re-runnable, so the WebCrypto
provider can be adopted once it passes the WebKit run.

## Scenario

Both libraries run the same scenario: one exported async function per WASM
package. They use cipher suite **0x0002**
(MLS_128_DHKEMP256_AES128GCM_SHA256_P256), which both support, so the
fallback to 0x0001 was never needed. The cast is owner A with devices A1 and
A2, and editor B with device B1. Roles live in a GroupContext extension
(0xF0A1). Each leaf credential names its user and device. A certified-device
directory stands in for ADR-024's verified device lists.

| Step                                                                                          | mls-rs | OpenMLS                      |
| --------------------------------------------------------------------------------------------- | ------ | ---------------------------- |
| Create the group; A2 joins from its KeyPackage via Add and Welcome                            | pass   | pass                         |
| Owner adds B1 and grants the editor role in one Commit                                        | pass   | pass                         |
| B1 proposes an Update, A1 commits it; 12 rotating path-only Commits                           | pass   | pass                         |
| 5 add-and-remove rounds with a temporary device (timed Welcome)                               | pass   | pass                         |
| Policy: an editor's Add, built by a client that skips its own checks, is refused by A1 and A2 | pass   | pass                         |
| Policy: an external Commit from an uncertified device of A is refused                         | pass   | pass                         |
| Two Commits for one epoch: the first wins, the stale one is refused, the loser rebases        | pass   | pass                         |
| A1's state round-trips through IndexedDB, sealed under a non-extractable key, then commits    | pass   | pass                         |
| A2's storage is wiped: it rejoins by external Commit with a new key                           | pass   | pass, plus a separate Remove |
| A1 removes A2; A2 sees the removal and cannot process the next Commit                         | pass   | pass                         |
| B leaves by **SelfRemove**, which A1 commits                                                  | pass   | pass                         |
| `epoch_authenticator` and the exporter secret are equal on every member at every check        | 26/26  | 26/26                        |

The exporter secret uses label `openzcad project key`, with the project id as
context and length 32.

The mls-rs row covers both providers. The WebCrypto provider passes only in
Chrome and in Node with a shim; the RustCrypto provider passes in every
runtime listed below.

## Numbers

Hardware: Apple Silicon Mac. Each figure is the median within a run; for
Chrome and WebKit it is then the median of three runs. Each run has 13 Commit
creations, about 60 Commit receptions and 7 Welcome joins. Group size is 3–4
leaves. Safari is a single run. Safari and WebKit coarsen
`performance.now()` to about 1 ms, so their figures are whole milliseconds.
These are the original timing runs, before the persistence and PSK-pruning
corrections below. They do not establish complete mls-rs restart recovery.

| Median ms (create / process / Add+Welcome / join / external) | Chrome 155                  | Safari 27.0.1     | WebKit 26.6       | Node 22 (Vitest, one run)          |
| ------------------------------------------------------------ | --------------------------- | ----------------- | ----------------- | ---------------------------------- |
| mls-rs + WebCrypto                                           | 1.1 / 0.7 / 1.5 / 0.8 / 1.7 | **fails**         | **fails**         | 2.1 / 1.2 / 2.8 / 1.4 / 2.9 (shim) |
| mls-rs + RustCrypto                                          | 4.1 / 2.1 / 5.9 / 3.6 / 8.0 | 5 / 3 / 9 / 4 / 9 | 3 / 2 / 5 / 3 / 7 | 3.9 / 2.0 / 5.8 / 3.5 / 7.7        |
| OpenMLS + RustCrypto                                         | 4.3 / 2.3 / 5.6 / 3.9 / 7.4 | 5 / 3 / 6 / 4 / 9 | 3 / 2 / 5 / 4 / 6 | 4.2 / 2.2 / 5.5 / 3.9 / 7.3        |

In those original Mac runs, every operation takes single-digit milliseconds in a Worker, so commit cost
does not decide between the libraries. The wire sizes match because both
libraries implement the same protocol. Approximate sizes: KeyPackage 400 B,
path-only Commit 660 B, Welcome 1.06 KB for one joiner into two members and
1.7 KB into four, GroupInfo with `external_pub` 1.3 KB.

| Lazy chunk (no wasm-opt; `opt-level = "s"`, LTO) | WASM raw | WASM gzip -9 | WASM brotli | JS glue gzip |
| ------------------------------------------------ | -------- | ------------ | ----------- | ------------ |
| mls-rs + WebCrypto                               | 1,016 KB | 340 KB       | 264 KB      | 3.8 KB       |
| mls-rs + RustCrypto                              | 1,241 KB | 407 KB       | 311 KB      | 3.3 KB       |
| OpenMLS + RustCrypto                             | 1,651 KB | 579 KB       | 443 KB      | 3.2 KB       |

These sizes include the spike's own scenario code. Adding the rejoin
scenario grew each binary by 70–100 KB raw (20–30 KB gzip), so the
libraries alone are smaller.

- **Entry chunk.** The spike's entry chunk is 1.6 KB (862 B gzip) and refers
  to no `.wasm` or library code: everything loads from the Worker. The
  app's entry chunk is unchanged, and `pnpm build`, including the bundle
  check, stays green.
- **Budget change if adopted.** `report-bundle-sizes.mjs` gives every lazy
  asset a 1 MiB raw default. mls-rs + RustCrypto (1.24 MB) and OpenMLS
  (1.65 MB) would each need an `APPROVED_LAZY_ASSETS` entry, as the SQLite
  WASM has. A `wasm-opt -Oz` pass was not run because the tool is not
  installed here; it usually trims WASM by 10–20%, which is an estimate.

| Complete device state (A1, sealed blob) | 3 members  | 1 member   | Leaf signature key, included in state    |
| --------------------------------------- | ---------- | ---------- | ---------------------------------------- |
| mls-rs (both providers)                 | 4.0–4.4 KB | 2.4–2.9 KB | 32 B raw, or 138 B PKCS#8 with WebCrypto |
| OpenMLS                                 | 25–30 KB   | 21–25 KB   | 0.8 KB stored record                     |

These main-scenario figures include the signer and an empty rejoin-PSK cache.
The separate mls-rs rejoin scenario seals five retained epoch secrets with the receiver
and verifies an external Commit after discarding and restoring that receiver.
Both libraries keep three past group epochs. OpenMLS stores JSON-encoded records,
which is most of the gap.
The complete-state figures are from the corrected Linux runs in
[`review-2026-10-19`](../../spikes/mls/results/review-2026-10-19/).
The original mls-rs size measurements omitted the leaf signer and are not
complete-device storage measurements.

## IndexedDB persistence under a non-extractable key

The host generates an AES-256-GCM key with `extractable: false` and confirms
that `exportKey` throws. It seals the exported group state, using the label
as AAD, and stores both the `CryptoKey` and the ciphertext in IndexedDB. It
then reads both back through a fresh connection, decrypts, and hands the
bytes to WASM. The reloaded A1 commits again, and every member agrees on the
epoch. The initial mls-rs experiment reused its live device's signing key,
so the original Safari/WebKit results proved a sealed group-state round trip,
not recovery of a complete device after restart.

The corrected mls-rs payload contains the group id, stored group and retained
epochs, public signing identity, leaf signing secret and retained external
rejoin PSKs. The experiment
drops the old device, client, group and signer before restoring everything
from that payload and committing again. The corrected Node and Chromium
runs pass for both mls-rs providers. Chromium also exercises real IndexedDB;
Node uses the harness's encrypted in-memory store. These corrected restart
cases have not been rerun in Safari or WebKit.

## Corrections and verification (19 October)

- The complete mls-rs payload now includes the leaf signer; the post-reload
  Commit cannot borrow a private key from the discarded client. A second
  restart after PSK accumulation restores the retained cache, then accepts an
  authorized external Commit using a pre-restart PSK. The receiver does not
  retain its old live client or cache for this test.
- OpenMLS explicitly deletes external PSKs older than `WINDOW` from its
  `MemoryStorage` and prunes the matching saved-secret list. A removed device
  keeps its old secret for the negative test, but active members no longer
  have it. The outside-window Commit now fails with
  `InvalidCommit(PskError(KeyNotFound))` before app policy. The harness checks
  that exact refusal instead of accepting a policy-only window rejection.
- OpenMLS validates every queued Update leaf against the certified-device
  directory and preserves its proposer's user identity before merging a staged
  Commit. Isolated by-reference Update trials reproduce and refuse an
  uncertified replacement key and a certified key for another user; a certified
  same-user key rotation remains accepted. These trials supplement the
  committer-path check and the normal Update scenario.
- All six Node scenarios and all three variants' main and rejoin scenarios
  pass in Chromium 153 on Linux x86_64. The corrected group-state figures,
  timings and bundle measurements are preserved separately in
  [`results/review-2026-10-19`](../../spikes/mls/results/review-2026-10-19/).
  These runs used Rust 1.98.0, wasm-bindgen 0.2.126 and Node 24.14.0 while
  other local validation was running. Their timing values are diagnostic;
  they do not replace the original Mac timing comparison.

Use `MLS_SPIKE_RESULTS_DIR` to keep a new run separate from historical
evidence, and `--chromium-only` when only Playwright Chromium is available.

What this does not give:

- **Neither library can await IndexedDB from Rust.** mls-rs storage traits
  require `Send` futures, and WebCrypto/IndexedDB futures are not `Send`.
  OpenMLS's `StorageProvider` is synchronous and has about 70 methods. The
  workable pattern, used in the spike, is an in-memory store whose blob the
  host seals and writes after each epoch. mls-rs's `GroupStateStorage` has
  four methods. OpenMLS ships no persistence helper outside `test-utils`, so
  the spike wrote its own.
- **The MLS leaf signing key is raw bytes in WASM memory** and lives inside
  the sealed blob in both libraries. It cannot be the ADR's non-extractable
  device signing key. Treat it as a per-project leaf key that the device key
  certifies. Untested: mls-rs's WASM `CipherSuiteProvider` is async and not
  `Send`, so a wrapper provider could send `sign` to a non-extractable
  `CryptoKey`. OpenMLS's `Signer` is synchronous and cannot.

## Why mls-rs's WebCrypto provider fails off Chrome

MLS derives HPKE key pairs from path secrets (RFC 9180 `DeriveKeyPair`).
`mls-rs-crypto-webcrypto` 0.15.1 computes the public key in an indirect way:
it imports a PKCS#8 P-256 private key with the public key left out, exports
it again, and expects the engine to have filled in the public point.
Chromium does. Node and WebKit do not. The provider retries 255 times, then
fails. The spike confirms this directly in Node: the re-exported key has no
public key. The Node harness gets past it by completing the key with
`node:crypto` before import (`harness/node-webcrypto-shim.mjs`). No browser
shim exists.

The provider has two more problems:

- It reaches SubtleCrypto through `web_sys::window()`. That needs a
  `Window` global, which Workers and Node lack (`installWindowShim()`
  supplies one).
- It needs the whole library built with `--cfg mls_build_async`.

The mls-rs README lists the provider as "Experimental". A fix would compute
the point in Rust (the `p256` crate) and keep WebCrypto for everything else.
That is a small upstream change, but until it lands, the provider adds no
WebCrypto-only benefit.

## Rejoin by external Commit (ADR-024 review rules)

ADR-024's revised rejoin rule has members accept an external Commit only if
all of these hold:

- the credential is not revoked;
- the identity is still listed, with its current role, in the current
  epoch's roles extension;
- the Commit carries an epoch PSK later than the user's newest device
  revocation and the identity's latest removal or role change;
- that PSK is within a retention window.

Both crates run `run_rejoin_scenario` with a window of 4 epochs. All eight
steps pass in both libraries, in Node, Chrome and WebKit, and in Safari
27.0.1 for both RustCrypto builds. (mls-rs + WebCrypto again fails off
Chrome, for the reason given further down.)

| Step                                                                                      | Result in both libraries                                                                      |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Wiped **sole member** recovers its sealed PSK and rejoins by external Commit              | Accepted. OpenMLS keeps the wiped leaf (new key), so the device removes it in a second Commit |
| Removed and **revoked** device, PSK from the current epoch                                | Refused: `credential revoked`, and no other reason                                            |
| Removed, unrevoked device, PSK from **before the user's newest revocation**               | Refused: `PSK epoch 2 before newest revocation 3`                                             |
| Same device, PSK after the revocation and inside the window                               | Accepted; members agree on the epoch                                                          |
| Same device, PSK **outside the window** (epoch 7 at epoch 12)                             | Refused: `outside the 4-epoch window`                                                         |
| Member **downgraded** to viewer and removed in one Commit, PSK from before the change     | Refused: `PSK epoch 12 before role change 13`                                                 |
| Member **dropped from the roles extension**, devices not revoked, PSK from before removal | Refused: `identity not listed in the roles extension`                                         |

What the spike found about the ADR's design:

- **Neither library lets an external joiner use a resumption PSK.** mls-rs's
  `ExternalCommitBuilder` takes only external PSK ids (`with_external_psk`),
  and its joiner starts with an empty resumption secret. OpenMLS accepts a
  resumption PSK proposal in `add_psk_proposal`, but `load_psks` looks it up
  in the new group's resumption store, which is empty for a joiner, and fails
  with `PskError(KeyNotFound)`. OpenMLS does expose the secret (`resumption_psk_secret`), so a device could
  save it, but a joiner has no way to load it into the group it is building.
  mls-rs does not expose it.
- **What works in both: an exporter-derived epoch PSK sent as an external
  PSK.** Each epoch, every member computes `export_secret("openzcad rejoin
psk", project id, 32)` and stores it under the id `ozc-rejoin/<epoch>`.
  Devices keep copies sealed under the account key; the spike seals the
  copy with the IndexedDB hook. Every member of that epoch derives the same
  value, and a removed device never sees later epochs. It does what the ADR
  asked of the resumption PSK and carries its epoch in the id, where policy
  can read it. The ADR should name this mechanism instead of a resumption
  PSK.
- **Retention.** For this PSK the app chooses the window: members prune
  their store, and policy refuses anything older. Each library's own
  resumption-PSK retention is configurable but does not apply here. In
  mls-rs, resumption secrets live in the epoch records the
  `GroupStateStorage` keeps (the in-memory default is 3; this spike also
  keeps 3). In OpenMLS it is `number_of_resumption_psks` on the group config,
  which defaults to 0.
- **Rejecting a credential.** mls-rs gives two places: `IdentityProvider::validate_member`
  (the spike refuses revoked and uncertified keys there) and
  `MlsRules::filter_proposals`. The rejoin rules live in `filter_proposals`,
  which runs **before** PSK resolution. A PSK the members have already pruned
  is therefore refused by policy with a clear reason, not by a lookup
  failure. OpenMLS has no callback: the app checks the `StagedCommit` after
  `process_message`, which has already resolved PSKs. A PSK missing from a
  member's store fails inside OpenMLS before app policy runs.
- **Reading the roles extension during external-Commit validation.**
  - mls-rs passes the current `GroupContext` (with `epoch` and
    `extensions.get_as::<RolesExtension>()`) to `filter_proposals`, and the
    post-Commit extensions to `validate_member` through
    `MemberValidationContext::ForCommit`.
  - OpenMLS reads `group.extensions()` for the current epoch and
    `staged.group_context().extensions()` for the next, as raw
    `UnknownExtension` bytes the app decodes itself.
- **OpenMLS hides the PSK id of a received proposal.**
  `PreSharedKeyProposal` exposes no public accessor (`into_psk_id` is
  crate-private). The spike re-serializes the proposal and parses the id
  out of the TLS bytes.

## API ergonomics for the app's policy

| Need                                               | mls-rs                                                                                                                                                                 | OpenMLS                                                                                                                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reject Commits by role (viewer, editor, owner)     | `MlsRules::filter_proposals(direction, source, roster, context, proposals)`: one function for send and receive, with each proposal's sender. An error fails processing | No hook. After `process_message`, inspect `StagedCommit::queued_proposals()` and senders, then merge or drop. Send side has only a `\|_\| true` filter on the commit builder |
| Restrict external Commits to own certified devices | `CommitSource::NewMember` in the same rule, plus `IdentityProvider::validate_member` (certification) and `valid_successor` (same user on resync)                       | Inspect `Sender::NewMemberCommit` and `update_path_leaf_node()` by hand                                                                                                      |
| Check every leaf on joining                        | Automatic: the `IdentityProvider` runs on Welcome                                                                                                                      | Manual: iterate `StagedWelcome::members()` before `into_group`                                                                                                               |
| Roles in a GroupContext extension                  | Register the type on the client                                                                                                                                        | Must also list it in a RequiredCapabilities extension, and external joiners must repeat their capabilities, or the Commit is refused                                         |
| Rejoin a wiped device                              | `with_removal(old_leaf)`, one Commit                                                                                                                                   | Auto-removal only for the same signature key; otherwise a second member commits Remove                                                                                       |
| External PSK in an external Commit                 | `with_external_psk(id)`; members resolve it through `PreSharedKeyStorage`                                                                                              | `add_psk_proposal(..)` plus `load_psks`; members resolve it from storage                                                                                                     |
| Resumption PSK in an external Commit               | Not offered                                                                                                                                                            | Accepted by the builder, then `KeyNotFound`: a joiner has no resumption secrets                                                                                              |
| SelfRemove                                         | `propose_self_remove` (feature `self_remove_proposal`)                                                                                                                 | `leave_group_via_self_remove` (needs plaintext handshakes)                                                                                                                   |
| Conflicting Commits                                | `clear_pending_commit`, process the winner, commit again                                                                                                               | Same, with `clear_pending_commit(storage)`                                                                                                                                   |
| Rough edges                                        | Callbacks need `Send` futures, so certification must be checked before entering them. Client config types are sealed, so code is generic or uses `impl Trait`          | Many places where a missed check is silent; storage trait is large                                                                                                           |

## Licensing and dependencies

- **mls-rs:** mls-rs, mls-rs-core, mls-rs-codec and both providers are
  Apache-2.0 OR MIT. The WASM dependency tree is MIT and Apache-2.0, plus
  `subtle` (BSD-3-Clause), `memchr` (Unlicense OR MIT) and `unicode-ident`
  (adds Unicode-3.0). `cargo audit`: no advisories in 121 crates.
- **OpenMLS:** OpenMLS and openmls_rust_crypto are MIT. The tree also has
  `hpke-rs` ×4 (MPL-2.0) and the dalek crates (BSD-3-Clause).
  `cargo audit` flags RUSTSEC-2026-0330 and RUSTSEC-2026-0331 in
  `libcrux-kem` 0.0.9 (hybrid PQ KEM). It sits in the lockfile but is not in
  the wasm32 normal-dependency tree, so it is not compiled into the spike.
  It also flags `proc-macro-error2` as unmaintained (build-time only).

## Audit status

- **mls-rs:** No third-party audit, by its own README, and no published
  advisories. It claims RFC 9420 conformance and ships interop test vectors.
- **OpenMLS:** The README names no audit. ADR-024 cites an SRLabs audit
  published on 2026-05-27, but this spike could not confirm it. Neither the
  project's pages nor a web search found the report; the Sovereign Tech
  Agency page lists only 2022–2023 funding. Add a source link to the ADR or
  drop the claim. Five GitHub advisories have been published since 2025 (two
  High), all fixed by 0.9.1 (the latest, GHSA-gc79-23g3-8g52, in 0.9.1 itself).

## Not covered

- `ts-mls`: the optional third reference was not built.
- Interop between mls-rs and OpenMLS.
- A `wasm-opt` pass.
- Network load time: Worker load plus WASM compile measured 4–20 ms from a
  local server with a warm cache.
- Firefox: Playwright's Firefox build is not installed here.
- A non-extractable leaf signing key through a custom mls-rs provider.
- Groups larger than four leaves.

## Reproduce

See [`spikes/mls/README.md`](../../spikes/mls/README.md). Raw results are in
`spikes/mls/results/`.
