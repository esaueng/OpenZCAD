# L11: simpler encrypted sharing and encryption settings

**Status:** decided, 2026-11-25 (owner decisions in §8); building in the slices of §7.
**Row:** [L11](../../ROADMAP.md#l11). **Design record:**
[ADR-024](../adrs/ADR-024-end-to-end-encrypted-projects.md).
**Builds on:** [l11-encryption-ux-simplification.md](l11-encryption-ux-simplification.md)
(setup dialog, authorize dialog, approval certifies; built 2026-11-16).

The 2026-11-16 pass tidied the encryption screens but kept the trust model.
Most of the remaining friction comes from that model: people must be verified
before anything is shared with them. This plan changes that one rule, and
then removes the steps that only existed to serve it. Envelopes, the key
hierarchy, MLS, wraps and share-link cryptography stay as they are. The
server still holds only ciphertext.

## 1. What is wrong today

### Sharing by email

An email invite to someone who hasn't used encryption yet takes about nine
human steps across two people. Three of them are synchronous code
comparisons:

| #   | Who     | Step                                                                                                               |
| --- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | Owner   | Type the email, pick a role, Invite. If a verified contact matches, choose "email only" or "this contact (code …)" |
| 2   | Invitee | Open the link, sign in, land on Settings › Encryption (not the project)                                            |
| 3   | Invitee | Set up encryption: five steps, including retyping a 56-character recovery key                                      |
| 4   | Invitee | Accept invitation                                                                                                  |
| 5   | Invitee | **Verify the owner**: compare contact codes with them, then confirm with a passkey or recovery key                 |
| 6   | Owner   | **Come back** (within 7 days, by opening Settings › Encryption or this project's Share dialog)                     |
| 7   | Owner   | **Verify the invitee**: compare codes, confirm with a passkey or recovery key                                      |
| 8   | Owner   | **Confirm add**: read the acceptor's contact code again, click Add                                                 |
| 9   | Invitee | Open Settings again (or the project) so the Welcome is picked up                                                   |

Steps 5, 7 and 8 need both people to talk to each other while looking at the
same screen. Step 6 doesn't happen by itself: nothing completes invitations in
the background (`syncInvitations` runs only from the Encryption settings
panel, and `completeReadyInvitations` only from the Share dialog). An
email-only invitation always ends in a manual Add, even after both sides have
verified each other (`ownerState`, `lib/e2ee/invitations.ts`). The statement
expires after 7 days (`MAX_PROJECT_INVITATION_LIFETIME_MS`).

### Share links

Create link asks for a passkey or the recovery key whenever the 30-day share
delegation is missing, expired or in its last week. The composer asks for a
name, mode, history and comments before the first link exists. Link upkeep
runs only while the Links tab is open.

### Setup

Five screens: a warning, save the key and tick a box, retype all 56
characters, an optional passkey, then the project choices. Typing the recovery
key is the slowest part, and the passkey, which makes every later action one
touch, comes last.

### The Encryption page

The screenshot from 2026-11-25 shows the page with 11 devices. Most of them
are old browsers, and there is no way to tell which ones are still used.
Further down are a permanent "Add a device" paragraph, passkeys, the recovery
key, "Encrypt new projects", and an "Encrypt existing projects" card that
still shows when nothing is left to encrypt. Below those come contacts,
invitations and assistant access. Everything is always visible, so the page
reads as a to-do list even when nothing needs doing.

## 2. The one trust-model change: trust on first use

**Today:** a project key is wrapped only to someone whose identity the owner
has _verified_ by comparing codes, and the invitee joins only after verifying
the owner.

**Proposed:** the same model as Signal, WhatsApp and iMessage.

- **First introduction is trusted, with one confirmation.** If the invitee
  proves control of the invited email (sign-in) and holds the emailed link
  token, their signed acceptance is enough: no codes are compared. Someone
  new to the owner takes one confirmation ("Alex accepted, confirm with
  Touch ID"), which signs a `trust` entry for their identity into the
  owner's contacts list and then adds them. The invitee likewise confirms
  an owner new to them once. People already pinned are added, or joined,
  with no prompt (D5).
- **Verification becomes optional, and it is shown.** Each person in the Share
  dialog and in People carries **Verified** or **Not verified**. "Verify…"
  opens the existing mutual code comparison. Nothing waits on it.
- **A change is still an alarm.** If a pinned person's identity key changes,
  nothing is added or re-wrapped for them automatically. The row reads
  "_Alex's encryption keys changed_", with **Review** (compare codes) and
  **Trust new keys** (a signed `trust` entry replacing the pinned identity,
  still not verified). The rules for removed members (`addGate`) stay:
  re-adding someone who was removed always asks.
- **The signed contacts list is the pin (D5).** First-use pins are entries of
  the identity-signed, hash-chained contacts list: a `trusted` state,
  distinct from verified, under the list's signature, fork-consistency and
  rollback checks, so every device of the account compares against the same
  identity. It costs one passkey touch per new person. Once someone is
  pinned, inviting them to another project adds them as soon as their
  devices publish KeyPackages. The background never signs: a new person's
  acceptance surfaces a Confirm (toast and Share dialog row).

**What this keeps.** A database or storage breach, a curious operator, or a
passive network or server observer still sees only ciphertext. Keys are
still wrapped only to the invitee's own device KeyPackages, checked against
their signed device list. Removal, epochs, signed rosters, version integrity
and the share-link chain are unchanged.

**What this gives up.** A server that is _actively malicious at the moment of
the first introduction_ could substitute its own identity for the invitee's
(or the owner's), and nobody would notice unless they compared codes. This is
the same bound the large E2EE messengers accept. It is detectable afterwards:
the codes won't match, and the rogue member shows in the member list. It
needs an ADR-024 amendment and an update to the review packet
(`docs/reviews/adr-024-e2ee-review-packet.md`). The ADR is in outside review,
and this is the cheapest moment to change it.

**Considered and rejected:** putting a decryption secret in the invitation
email. The server writes and sends the email, so it would read the project
key passively. That is worse than TOFU, which needs an active, detectable
attack.

## 3. Sharing by email, after

```
Owner                                    Invitee
─────                                    ───────
Type email · Viewer ▾ · [Invite]
Row: "Invited · waiting for Alex"   ──►  Email: "Peter shared Cheery Duckling"
                                         Open link → sign in
                                         "Peter shared Cheery Duckling with you.
                                          Turn on encryption to open it."
                                         [Continue with passkey]   (setup §5)
                                         Acceptance signed automatically
Alex is new: toast "Alex accepted ·  ◄──  "Waiting for Peter's device…" (only
Confirm" → one Touch ID → added.         while no owner device is online)
(Already pinned: added in the            Project opens by itself
background, toast "Alex joined".)        (A new owner: one Confirm first.)
Row: Alex · Viewer · Not verified ⓘ
```

Changes:

1. **Owner:** one input, one button. The "email only / this contact" radio
   group goes away. If the email belongs to someone the owner already shares
   with (same pinned identity), they are added as soon as their devices
   publish; someone new takes one signed Confirm.
2. **Invitee lands on the project, not on Settings.** The invite link opens a
   "Shared with you" screen. It runs setup inline when needed. The opened
   link token is the acceptance intent, so there is no separate Accept or
   Join click. A listed invitation without a link (opened on another
   device) still shows one **Join** button.
3. **Background completion.** An app-level invitation worker runs on any
   unlocked owner device: at startup, on encryption-state events, every 60 s
   while the tab is visible, and when the room or notification channel
   reports an acceptance. It completes ready invitations with no dialog open
   and announces them through the toast host. The invitee's side picks up
   the Welcome the same way and opens the project.
4. **Invitations don't lapse while pending.** The owner's devices re-sign a
   pending statement before it expires. Each statement keeps its 7-day
   bound, and the chain stops when the owner cancels the invitation.
5. **The invitation email** still names the sender, not the project (ADR
   rule). The landing screen shows the project name once the statement
   decrypts.

## 4. Share links, after

- **Create link is one click.** The default is a view-only frozen snapshot
  named after the project. Name, mode, history and comments move into the
  link card's edit menu after creation.
- **The delegation renews itself where it can.** Any passkey-authorized
  action, including unlock, also renews the delegation when it has less than
  14 days left. Create link prompts only when the delegation has actually
  expired. The Links tab shows a quiet "Confirm by Dec 20" chip instead of a
  banner.
- **Upkeep runs in the background**, through the same worker as invitations,
  instead of only while the Links tab is open.
- Optional (§8 D4): a longer delegation, 60 or 90 days. This widens the
  window in which a stolen and removed owner device can keep vouching for
  links when the server replays an old delegation.

## 5. Setup, after

Three screens, one touch, no typing when a passkey is used:

```
1  Turn on encryption
   Only your devices can read your cloud projects. Not OpenZCAD, not us.
   [Continue with passkey]      Use a recovery key only
       → passkey created, keys generated (one touch)
2  Save your backup key
   ABCD-EFGH-…   [Download] [Copy] [Print]
   ☐ I saved it somewhere other than this device
   (no passkey: type the last group to confirm)
3  You're set
   ☑ Encrypt new projects
   ☑ Encrypt my 7 existing cloud projects
                                                    [Done]
```

- Generating keys needs the recovery secret, and the passkey's target
  private key is wrapped like today. Only the screen order changes: the
  recovery key is still created first, in memory. If the passkey step fails
  or is cancelled, the user falls back to the recovery-key-only path.
- When setup is started by an invitation, screen 3 is replaced by opening the
  shared project.
- Where `passkeysAvailable()` is false (desktop WebView), screen 1 offers
  only the recovery key, and screen 2 asks for the last group to be typed.

## 6. The Encryption page, after

```
Encryption
┌─────────────────────────────────────────────────────────────┐
│ 🛡  Encryption is on · this device is unlocked               │
│    Your cloud projects are encrypted before they leave       │
│    your devices.                                             │
└─────────────────────────────────────────────────────────────┘
[ needs-attention cards only when present: requests to join,
  shared with you, keys changed, N projects not yet encrypted ]

Encrypt new projects                                    [on ]

Unlock
  Passkeys · 1                                      [Add]
  Recovery key · saved Oct 28                       [Replace]

Devices · 11                                [Add a device]
  Firefox on macOS        This device · now
  Safari on iOS           used 2 days ago
  Chrome on macOS         used 5 days ago
  Show all 11
  ⚠ 8 devices haven't been used in 30 days   [Remove them]

People · 3        (verified and not verified, Verify…)

▸ Advanced  (fingerprint, contact code, assistant access,
             group reset, stop encrypting, replaced keys)
```

- **Status:** one line and no Refresh button. The page already reloads on
  state events, and Refresh moves into Advanced.
- **Action cards appear only when something needs doing.** "All your
  projects are encrypted" disappears instead of showing a disabled button.
- **Devices show "last used".** The Worker records a coarse last-used day per
  device id when that device fetches its wrap or signs a version. It is
  plaintext metadata about the account's own devices, at day resolution, and
  is added to ADR-024's plaintext metadata table.
- **Bulk clean-up:** "Remove them" removes every stale device with one key
  rotation and one authorize dialog, instead of eight rotations.
- **"Add a device"** opens a dialog with the steps and the scan or compare
  flow. The permanent paragraph goes away.
- **Contacts become "People".** The list shows who you share with, each
  marked Verified or Not verified. Your own contact code moves into the
  Verify dialog and Advanced.

## 7. Delivery

Each slice is its own PR with its own evidence fragment. Slices 1 and 2
change the trust model and need independent security review (ADR-024
amendment and review packet update).

1. **Trust on first use, owner side.** Auto-add a signed acceptance that
   matches the invitation's email hash and link token. Pin through the
   group. Show Verified or Not verified. Handle key changes with Review and
   Trust new keys. Remove the contact radio. Amend the ADR and update the
   review packet.
2. **Trust on first use, invitee side.** Accept the owner named in the
   signed statement without verifying first. The link token is the intent.
   Remove the Accept click.
3. **Background invitation and link worker.** App-level sync, toasts,
   Welcome pickup, statement re-signing, link upkeep.
4. **"Shared with you" landing screen** with inline setup.
5. **Setup in three screens**, passkey first (D2), and passkey-first unlock
   on a new device (D3, ADR-024 amendment).
6. **Encryption page restructure.** Last-used (Worker, migration, plaintext
   metadata amendment), bulk device removal, People, action cards.
7. **One-click links** and delegation piggy-backing (and D4, if chosen).

Tests: component tests per changed file. Update the e2e specs
`encrypted-sharing`, `encryption-contacts`, `encryption-settings`,
`encryption-passkeys` and `encryption-device-approval`. Add a `@ci-smoke`
case for invite → setup → auto-add with no code comparison, and one for the
key-change alarm blocking an automatic add.

## 8. Owner decisions (2026-11-25)

1. **D1, trust model: trust on first use** (§2), with optional verification
   and key-change alarms. Needs the ADR-024 amendment and a review-packet
   update in slices 1 and 2.
2. **D2, recovery key confirmation:** with a passkey made in setup, download
   or copy plus "I saved it", with no retype. Without a passkey, type the
   last group. Supersedes the 2026-11-16 full-retype decision.
3. **D3, new device unlock:** "Unlock with passkey" is primary when the
   account has a passkey, and approval from another device is second.
   Accepts ADR-024's first-sight freshness limit for that path. Supersedes
   §5 of the 2026-11-16 plan.
4. **D4, link delegation:** keep 30 days, renew automatically during any
   passkey-authorized action, and prompt only once it has expired.
5. **D5, signed contacts list for TOFU pins** (2026-11-25, after three review
   rounds on a merged sealed record): trust on first use is recorded as a
   signed `trust` entry in the identity-signed contacts list, the only
   cross-device trust store, rather than in an account-key-sealed record
   that devices merge. One passkey touch per new person; people already
   pinned are added automatically; the background never signs. Supersedes
   §2's "the project group is the pin" bullet.
