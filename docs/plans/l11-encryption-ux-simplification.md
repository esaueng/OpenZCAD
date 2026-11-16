# L11: simpler encryption setup, unlock and device flows

**Status:** proposal for owner review, 2026-11-16. No code yet.
**Row:** [L11](../../ROADMAP.md#l11). **Design record:**
[ADR-024](../adrs/ADR-024-end-to-end-encrypted-projects.md).
**Picks up:** design review 2026-11-13 items I75, I76, I80, I83
([review](../reviews/design-review-2026-11-13.md)).

This plan makes end-to-end encryption easier to turn on, to unlock on a new
device and to manage. It changes the Settings › Encryption UI, moves every
key-authorized action into one dialog, and makes two client-policy changes
to the device trust model. It does not change the cryptography: envelopes,
the key hierarchy, wraps, device-list format, MLS, Worker routes and D1
schema stay as they are.

## 1. What is wrong today

**One page holds everything.** `EncryptionSettings.tsx` (1,775 lines) renders
up to 15 groups in one column: the status summary, the fingerprint, unlock
options, passkey unlock, devices asking to join, invitations, "Encrypt new
projects", "Encrypt existing projects", pin recovery, devices, add-a-device
help, read-only devices, keys and passkeys, contacts with the contact code,
assistant access, and a folded "Recovery and beta tools" group (project
group reset, stop encrypting, devices from replaced keys). The order does not
say what to do next.

**Flows open far from what started them.** Remove device, revoke read-only,
replace recovery key, add and remove passkey, and approve all expand as new
groups at fixed places down the page. Each repeats the same recovery-key
field and button row in a slightly different way (`RecoveryKeyEntry`,
`RecoveryKeyFlow`, the approval form, `EncryptedProjectRecovery`, contacts
sealing).

**Setup is long, and it stops halfway.** Set up › save key › tick › retype
56 characters › "Last step: Encrypt new projects?" Encrypting existing
projects is a separate group further down, and a passkey can only be added
afterwards with the recovery key typed a second time. A passkey is what would
make every later key operation a single touch.

**Too many concepts are visible:** certified and read-only devices, the
device key, the fingerprint and the contact code (two different 40-digit
numbers on one page, I76), identity, key sets and generations, and devices
from replaced keys.

**Approval quietly gives a weaker result.** By default a newly approved
device is *read-only*: it can open projects but cannot save them until it is
certified. Certifying needs the identity key, which only a passkey or the
recovery key opens. The approving device asks for this in an optional field
labelled "Certify the new device", and it accepts only the recovery key, not
a passkey. Most people leave it empty, and then the new device cannot save.

**Locked-project messages send people looking.** The indicator and the
refusals say "Unlock encryption on this device (Settings › Encryption)" as
text instead of offering an Unlock action.

## 2. Goals and non-goals

Goals:

- Setup is one guided dialog that ends with projects actually encrypted.
- A new device unlocks from one dialog, with a single recommended path.
- Every action that needs the passkey or the recovery key confirms in one
  shared dialog, next to the action, with the error at the field.
- The overview shows one status and one next action. Rare tools move to
  Advanced.
- An approved device can always save. The read-only tier disappears from the
  product.
- People see one code for verifying each other.

Non-goals:

- No change to envelopes, wraps, key hierarchy, device-list or grant
  formats, MLS policy, Worker routes or migrations.
- The identity key stays off device unlock keys (see
  [Rejected](#5-rejected-alternatives)).
- Recovery-key confirmation stays a full retype (owner decision 2026-11-16).
- Default-on and the plaintext freeze stay behind the outside review.

## 3. Trust-model changes

These are client-policy changes. Each needs an ADR-024 amendment and an
update to the review packet (`docs/reviews/adr-024-e2ee-review-packet.md`,
§ device approval and decision D4). They are cheaper to make before the
review tag is frozen than after it.

### T1. Approving a device always certifies it

Today `approveDevice(…, recoverySecret: Uint8Array | null)` certifies only
when the approver types the recovery key. Otherwise it seals the account key
with the `device-approval` method, which makes the device read-only.

Proposed:

- Approval asks for the identity authorization every time, with a passkey
  first and the recovery key as the fallback. `approveDevice` takes an
  `UnlockAuthorization` (`Uint8Array | 'passkey'`), the same type
  `removeDevice` and `revokeReadOnlyDevices` already take, through
  `withIdentityKey`.
- The UI stops creating read-only approvals. The protocol keeps reading them,
  so existing read-only devices keep working:
  - on that device, the status says **Finish setting up this device**, with
    Use passkey, Use recovery key, or Ask again (a fresh approval, which now
    certifies);
  - on a certified device, they show in the one Devices list with a
    **Not finished** chip. "Revoke read-only devices" moves to Advanced and
    shows only while any remain.
- Cost: approving now takes a passkey touch, or the recovery key when the
  approver has no passkey. T2 makes the passkey the normal case. A user
  without either at hand can instead unlock the new device with its own
  recovery key, with the first-sight freshness limit ADR-024 already states.
- Follow-up, separate PR once no read-only devices remain in the beta: stop
  the Worker accepting `sealedAccountKey` grants and remove the
  `device-approval` creation path. Reading stays for archived history.

### T2. A passkey becomes the everyday authorization

- The setup dialog offers "Add a passkey" right after the recovery key is
  confirmed. It reuses the in-memory recovery secret that `addPasskey`
  already requires, so nothing is typed twice. The step is skipped where
  `passkeysAvailable()` is false (the desktop WebView, for example).
- Every authorize dialog leads with **Confirm with passkey** when the account
  has one and this browser supports PRF, and tucks the recovery key behind
  **Use recovery key instead**.
- The recovery key stays the backup that opens everything, and setup still
  requires it.

### T3. One code for verifying people

- The **contact code** is the only code shown for verifying another person.
  It already covers the identity and the devices.
- The **fingerprint** leaves the overview. It appears in Advanced and inside
  the "Device list did not verify" notice, which is where comparing it helps.
- The **project state code** stays in the project indicator only.
- The ADR-024 key-hierarchy row "its fingerprint is what other people
  verify" is amended to say that people compare the contact code, which
  commits to the fingerprint.

### T4. Setting up means encrypting new projects

- The last setup step has **Encrypt new projects** ticked. Unticking it is
  allowed.
- The same step offers **Also encrypt my N existing cloud projects**, which
  runs the existing Phase 7 migration.
- If someone unticks it, the headline says **Keys ready · new projects aren't
  encrypted** instead of "Encryption is on" (the alternative fix I75
  proposed).

## 4. UX design

### 4.1 Vocabulary

| Shown to people                    | Replaces                                       |
| ---------------------------------- | ---------------------------------------------- |
| Encryption keys                    | identity, account key, key set, generation     |
| This device / your devices         | certified device, device key                   |
| Not finished (device chip)         | approved, read-only                            |
| Recovery key                       | (unchanged)                                    |
| Passkey                            | (unchanged)                                    |
| Contact code                       | fingerprint (moved to Advanced)                |
| Requests to join                   | devices asking to join                         |

"Certified", "identity", "generation" and "key set" remain in code and in
Advanced only.

### 4.2 Setup dialog

The dialog opens from **Set up encryption** on the overview and from any
setup prompt elsewhere (the share dialog, the locked-project refusal). It
replaces the in-page `RecoveryKeyFlow` setup.

```
┌ Set up encryption ─────────────────────────── 1 of 5 ┐
│ Only your devices will be able to read your cloud     │
│ projects. OpenZCAD can't read them, and can't recover │
│ them for you.                                         │
│                                                       │
│ You'll save a recovery key. If you lose every device, │
│ every passkey and the recovery key, encrypted cloud   │
│ projects can't be recovered, by you or by us.         │
│                                     [Cancel] [Start]  │
└───────────────────────────────────────────────────────┘
2 of 5  Save your recovery key
        ABCD-EFGH-…  [Copy] [Download] [Print]
        ☐ I saved my recovery key somewhere other than this device
                                       [Back] [Continue]
3 of 5  Type your recovery key to confirm
        [______________________________]  ← error shown here
                                     [Back] [Turn on encryption]
        → setUpEncryption runs here; the account now has keys
4 of 5  Add a passkey  (skipped where unsupported)
        Unlock and confirm changes with one touch, instead of
        typing the recovery key.          [Skip] [Add passkey]
5 of 5  Your projects
        ☑ Encrypt new projects (recommended)
        ☐ Also encrypt my 7 existing cloud projects
                                                    [Done]
```

- Cancel or close before step 3 discards everything. From step 3 on, the
  account has keys. Closing then counts as Skip for steps 4 and 5, and both
  stay reachable from the overview.
- The recovery key is zeroed when the dialog closes.
- Focus, Escape and return focus follow `CloudDataDeletionDialog`.

### 4.3 Unlock dialog (new or locked device)

This dialog opens from the overview's status action, the encryption
indicator, and every "keys are locked" refusal (each gets an **Unlock**
button instead of the "Settings › Encryption" sentence).

```
┌ Unlock encryption on this device ────────────────────┐
│ ► Approve from another device        (recommended)   │
│   Shows a QR code and six digits. On a device that's │
│   already unlocked, accept the request.              │
│                                                      │
│   No other device?                                   │
│   [Use passkey]   [Use recovery key]                 │
└──────────────────────────────────────────────────────┘
```

- Approval stays first because a fresh browser's passkey or recovery-key
  unlock cannot confirm that the device list is current (ADR-024, Unlock and
  devices).
- While it waits, the dialog shows the QR code and, once the approver
  chooses Compare, the six digits. Only one waiting screen is shown, with
  Cancel request.
- When it finishes, the device is unlocked and can save (T1).

### 4.4 Approving on an unlocked device

- **Requests to join** sits at the top of the overview when one is waiting.
  It is also announced through the toast host with an Open action, so the
  request is seen without browsing to Settings.
- Each request offers **Scan code** and **Compare codes**, then **Deny**.
  After the codes match, **Approve** opens the authorize dialog (§4.5). The
  optional "Certify the new device" field goes away.

### 4.5 One authorize dialog

`AuthorizeDialog` replaces `RecoveryKeyEntry`, the approval form's recovery
field, `EncryptedProjectRecovery`'s confirm, and the contacts-sealing confirm.

```
┌ Remove "Chrome on Linux" ───────────────────────────┐
│ It won't open anything new. Your keys are replaced; │
│ your other devices keep working.                    │
│                                                     │
│ [Confirm with passkey]                              │
│ Use recovery key instead ▾                          │
│   [________________]  ← "That isn't your recovery   │
│                          key" shown here            │
│                          [Cancel] [Remove device]   │
└─────────────────────────────────────────────────────┘
```

The props are the title, one consequence sentence, the action label, the
tone (normal or danger), `onAuthorize(auth: UnlockAuthorization)` and
whether a passkey is offered. The secret is zeroed in `finally`, as today.

### 4.6 The overview

The status card shows one of these, each with one primary action:

| State                                      | Title                               | Action                    |
| ------------------------------------------ | ----------------------------------- | ------------------------- |
| not set up                                 | Encryption is off                   | Set up encryption         |
| ready, encrypt-new on                      | Encryption is on                    | (none)                    |
| ready, encrypt-new off                     | Keys ready · new projects aren't encrypted | Encrypt new projects |
| locked / none                              | Locked on this device               | Unlock                    |
| pending                                    | Waiting for approval                | Show request              |
| approved (legacy read-only)                | Finish setting up this device       | Finish                    |
| identity-changed                           | Keys changed on another device      | Unlock                    |
| removed                                    | Removed from your account           | Forget this device's keys |
| fork                                       | Device list didn't verify           | Retry                     |

Below the card, four groups, in this order:

1. **Devices and unlock:** requests to join, then one list of devices with
   This device and Not finished chips and Remove, then Add a device (it
   explains where to start the request), Passkeys (add and remove), and
   Recovery key (Replace…).
2. **Projects:** Encrypt new projects, Encrypt existing projects, Assistant
   access.
3. **People:** Your contact code (Show, with QR), Contacts, Invitations.
4. **Advanced** (folded): Fingerprint, Reset a project's encryption group,
   Stop encrypting a project (beta), Devices from replaced keys, Revoke
   read-only devices (only while any exist), and the pin recovery notice.

Refresh moves into Advanced. The page already reloads on encryption-state
events.

## 5. Rejected alternatives

- **Wrap the identity key to certified devices**, so any unlocked device
  could certify another with no passkey or recovery key. This breaks
  ADR-024's rule that a device stolen while unlocked does not hold the
  identity key. Rejected.
- **Spot-check recovery-key groups instead of a full retype.** Declined by
  the owner on 2026-11-16.
- **Make passkey or recovery-key unlock the recommended path on a fresh
  device.** That loses the verified-head handoff that approval gives (the
  first-sight freshness limit).

## 6. Code structure

Move the encryption UI into `apps/web/src/components/encryption/`:

| File                       | Holds                                                                    |
| -------------------------- | ------------------------------------------------------------------------ |
| `EncryptionSettings.tsx`   | session gate, state load, status card, section order                     |
| `useEncryptionFlow.ts`     | the `run`/busy/error lifetime and one flow reducer (replaces `Flow` + `setFlow` drilling) |
| `SetupDialog.tsx`          | §4.2                                                                     |
| `UnlockDialog.tsx`         | §4.3, including the waiting/compare screen (from `EnrollPanel`)          |
| `AuthorizeDialog.tsx`      | §4.5                                                                     |
| `DevicesSection.tsx`       | the device list, requests to join, passkeys, recovery key                |
| `ApprovalRequests.tsx`     | §4.4 (from `ApprovalsPanel` and `ApproveDevice`)                         |
| `QrScanner.tsx`, `ScanCode.tsx` | as today                                                            |
| `copy.ts`                  | status table §4.6 and shared sentences (from `deviceSummary`, `messageFor`) |

The existing sub-panels (`ProjectEncryptionPreference`,
`ExistingProjectEncryption`, `StopProjectEncryption`, `EncryptionContacts`,
`EncryptedInvitations`, `EncryptedProjectRecovery`, `EncryptedPinReset`,
`AssistantAccessSettings`) keep their logic. They move under the new groups,
and their confirms switch to `AuthorizeDialog`. `lib/e2ee/accountKeys.ts`
changes only for T1 (`approveDevice` authorization).

## 7. Delivery

Each slice is its own PR, independently mergeable, with its own roadmap
evidence fragment.

1. **Authorize dialog and file split.** Move the files, add `AuthorizeDialog`
   with the passkey-first layout, and route remove, revoke, replace, the
   passkey actions, group reset and contacts sealing through it. Behaviour is
   otherwise unchanged.
2. **Setup dialog** (T2, T4). Includes the passkey step and the projects
   step.
3. **Overview restructure** (T3, vocabulary, §4.6). The fingerprint moves to
   Advanced, and the status table replaces `deviceSummary`.
4. **Approval certifies** (T1). Changes `approveDevice` authorization,
   handles legacy read-only devices, adds the ADR-024 amendment, and updates
   the review packet. Needs an independent review (security).
5. **Unlock dialog and entry points.** Indicator and refusal Unlock actions,
   and the requests-to-join toast.
6. Later: the Worker stops accepting read-only grants, and the creation
   path is deleted (§T1).

Tests: component tests for each new file. Update the e2e specs
`encryption-settings`, `encryption-device-approval`, `encryption-passkeys`,
`encryption-session` and `encryption-contacts`, and tag a setup-dialog case
and an approve-with-passkey case `@ci-smoke`. Existing assertions keep their
strength. Where copy changes, tests read the shared strings from `copy.ts`.

## 8. Questions for the owner

1. **T1 fallback.** When the approver has neither a passkey nor the recovery
   key at hand, is "unlock the new device with its own recovery key" an
   acceptable answer, or should read-only approval stay as a hidden escape
   hatch?
2. **T4 default.** Tick "Encrypt new projects" by default in setup? This
   affects only accounts that chose to set up. Product default-on stays
   behind the outside review.
3. **Layout.** Four folded groups on one page (proposed), or sub-tabs inside
   Settings › Encryption?
4. **Timing.** Land T1 and T3 before the review tag is frozen, so the
   reviewer sees the final approval policy?
