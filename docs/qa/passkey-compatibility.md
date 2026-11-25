# Passkey compatibility for encryption (WebAuthn PRF)

Status: **unverified on real devices.** This matrix comes from secondary
sources (listed below) and from the code paths in
`apps/web/src/lib/e2ee/passkeys.ts`. Before anyone claims a combination works,
confirm it on a real device with the [manual QA script](#manual-qa-script) and
record the result in the [results log](#results-log). Automated coverage is a
Chromium virtual authenticator only (`test/e2e/encryption-passkeys.spec.ts`),
which shows the code's behaviour, not any vendor's.

## What encryption needs from a passkey

A passkey can unlock encryption only when the browser and the place the
passkey is saved both support the WebAuthn **PRF** extension (CTAP
`hmac-secret` on security keys). The credential must be discoverable and
user-verified, and it is bound to the exact host it was made on (today
`beta.zcad.app`; a move to another host means enrolling passkeys again).
When PRF is missing, creation fails closed with platform-specific advice, and
the recovery key and device approval keep working.

Behaviour that differs by browser, handled in code:

- **Missing PRF:** Chrome reports `prf: { enabled: false }`, Firefox an empty
  `prf: {}`. Both are refused the same way.
- **Safari** enables PRF at creation without evaluating it, so setup asks for
  a second passkey prompt (an assertion restricted to the new credential).
  Two prompts on Safari are expected, not a bug.
- **1Password's extension** returns the PRF result as a plain Array rather
  than an ArrayBuffer (source 6). Accepted only when it is exactly 32
  integers from 0 to 255.
- **Password-manager extensions** (1Password, Bitwarden, Proton Pass,
  KeePassXC) return their own credential objects, so credentials are checked
  by shape, not by class.
- **Orphaned passkeys:** when a new passkey turns out to lack PRF, the browser
  is asked to delete it through the WebAuthn Signal API
  (`PublicKeyCredential.signalUnknownCredential`, Chrome and Edge 132+, recent
  Safari). A provider may ignore the signal, so the error still names the
  passkey to check for and delete if it remains. Where the API is missing
  (Firefox) or fails, it names the passkey to delete by hand.
- **Timeouts** are five minutes per prompt, for phone (QR) ceremonies and slow
  Windows Hello prompts.

## Matrix

Legend: **expected** = sources say PRF works; **known-broken** = sources say
PRF does not reach the page; **unverified** = no reliable source either way;
n/a = the provider does not exist there. "Platform" means Windows Hello on
Windows, iCloud Keychain on Apple systems and Google Password Manager (GPM) on
Linux, ChromeOS and Android. Every cell is from secondary sources.

| Browser      | OS                                             | Platform                                                          | Phone via QR                    | Security key (hmac-secret) | 1Password  | Bitwarden  |
| ------------ | ---------------------------------------------- | ----------------------------------------------------------------- | ------------------------------- | -------------------------- | ---------- | ---------- |
| Chrome       | Windows 10                                     | known-broken (Windows Hello has no PRF) [1][2]                    | expected [1]                    | unverified                 | expected   | unverified |
| Chrome       | Windows 11, Feb 2026 update (25H2 26200.7840+) | expected [2]                                                      | expected [1]                    | unverified                 | expected   | unverified |
| Chrome       | Windows 11 24H2 or older builds                | unverified (24H2) / known-broken (older) [2]                      | expected [1]                    | unverified                 | expected   | unverified |
| Edge         | Windows 10                                     | known-broken [1][2]                                               | expected [1]                    | unverified                 | unverified | unverified |
| Edge         | Windows 11, Feb 2026 update                    | expected [2]                                                      | expected [1]                    | unverified                 | unverified | unverified |
| Firefox      | Windows 10 / 11                                | same as Windows Hello above (Firefox uses the Windows API) [2][4] | unverified                      | unverified                 | unverified | unverified |
| Safari       | macOS 15+                                      | expected (iCloud Keychain on this Mac) [1][2]                     | known-broken [5]                | unverified                 | unverified | unverified |
| Chrome       | macOS                                          | unverified (iCloud Keychain); expected (GPM) [1]                  | expected [1]                    | expected [3]               | expected   | unverified |
| Edge         | macOS                                          | unverified                                                        | unverified                      | unverified                 | unverified | unverified |
| Firefox      | macOS                                          | unverified                                                        | unverified                      | expected [3][4]            | unverified | unverified |
| Chrome       | Linux                                          | expected (GPM) [1]                                                | expected [1]                    | expected [3]               | expected   | unverified |
| Edge         | Linux                                          | n/a                                                               | unverified                      | unverified                 | unverified | unverified |
| Firefox      | Linux                                          | n/a                                                               | known-broken (no hybrid) [2][4] | expected [3][4]            | unverified | unverified |
| Chrome       | ChromeOS                                       | expected (GPM) [1]                                                | unverified                      | unverified                 | unverified | unverified |
| Any (WebKit) | iOS / iPadOS 18+                               | expected (iCloud Keychain on this device) [1][2]                  | known-broken [5]                | unverified                 | unverified | unverified |
| Chrome       | Android                                        | expected (GPM) [1][2]                                             | unverified                      | unverified                 | unverified | unverified |
| Firefox      | Android                                        | unverified                                                        | unverified                      | unverified                 | unverified | unverified |

Notes:

- On Windows, Chrome and Edge can save the passkey to GPM, a phone or
  1Password instead of Windows Hello; that is the advice the app gives when
  Windows Hello returns no PRF.
- "1Password: expected" means the PRF result arrives (as an Array, which the
  app accepts); it is not confirmed per browser.
- `passkeyPrfSupport()` reads the browser's `getClientCapabilities()`. It says
  what the browser can do, not what the chosen provider will return, so a
  "supported" browser can still meet any known-broken cell above.

## Sources

1. Corbado, "Passkeys and the WebAuthn PRF extension":
   [corbado.com/blog/passkeys-prf-webauthn](https://www.corbado.com/blog/passkeys-prf-webauthn)
2. private-circle, WebAuthn PRF support notes:
   [github.com/kummahiih/private-circle/blob/main/docs/WEBAUTHN_PRF_SUPPORT.md](https://github.com/kummahiih/private-circle/blob/main/docs/WEBAUTHN_PRF_SUPPORT.md)
   (Windows 11 February 2026 cumulative update, 25H2 build 26200.7840+;
   24H2 unconfirmed)
3. Yubico developer PRF guide:
   [developers.yubico.com](https://developers.yubico.com/WebAuthn/Concepts/PRF_Extension/)
4. Mozilla bug 1863819 (Firefox PRF support):
   [bugzilla.mozilla.org/show_bug.cgi?id=1863819](https://bugzilla.mozilla.org/show_bug.cgi?id=1863819)
5. Apple Developer Forums thread 774112 (Safari cross-device PRF):
   [developer.apple.com/forums/thread/774112](https://developer.apple.com/forums/thread/774112)
6. 1Password community thread on the PRF result shape (FS-5593):
   [1password.community](https://www.1password.community/) (search for the
   issue reference FS-5593; the thread has no stable link here)

## Manual QA script

Run on each real browser, OS and provider combination you can reach. Use an
account with encryption already set up and its recovery key at hand. Note the
browser version, OS build (for Windows, `winver`), provider and app version.

1. **Create.** Settings › Encryption › Add passkey. Confirm with the recovery
   key, then save the passkey in the provider under test. Expected: one
   prompt (two on Safari), then "Remove passkey 1" appears and the device stays
   Unlocked. If it fails, copy the exact message; it should name a cause that
   fits this platform and say the recovery key still works.
2. **Orphan check (only after a failure in step 1).** Open the provider's
   passkey list. On Chrome, Edge or Safari the failed "OpenZCAD encryption …"
   passkey should be gone or going; on Firefox the error asks you to delete it,
   and it should be the only one named. No unlock method should have been
   added in Settings › Encryption.
3. **Unlock on a fresh browser.** Open a private window or a new browser
   profile on the same host, sign in, open Settings › Encryption and choose
   Unlock with passkey. Expected: the provider offers the passkey without a
   username, the device unlocks, and the fingerprint under Advanced matches
   the one on the first device.
4. **Cross-device (where the matrix says "Phone via QR").** Repeat step 3
   choosing the phone or QR option. Record whether it unlocks or shows the
   no-PRF message.
5. **Remove.** Settings › Encryption › Remove passkey 1 and confirm. Expected:
   the passkey row disappears and the device stays Unlocked. Then delete the
   passkey from the provider and confirm it no longer appears in step 3.
6. **Cancel and timeout.** Start Add passkey and cancel the prompt. Expected:
   "canceled or timed out", no cleanup message, nothing saved in the provider.

## Results log

Add one row per real-device run. Leave the matrix's labels alone until a run
confirms or refutes a cell; then update the cell and cite the row here.

| Date | Browser + version | OS + build | Provider | Steps passed | Message on failure | Tester |
| ---- | ----------------- | ---------- | -------- | ------------ | ------------------ | ------ |
