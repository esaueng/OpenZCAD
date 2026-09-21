# L01 live acceptance — 2026-09-20

This record covers a bounded live check against the deployed beta at
`https://zcad.app/`. A newly created, timestamped acceptance project was used.
No existing project was edited, no invitation or share link was created, and no
deployment or migration was run.

## Deployed build observed

- `GET /api/health` returned `status: ok` and `environment: beta` at
  `2026-09-20T02:12:07Z`.
- Storage and erasure readiness flags were true: artifact accounting, document
  accounting, project object storage, measurement storage, account erasure,
  and project erasure.
- Sharing, edit-lease enforcement, and personal sync were enabled.

The health response identifies the observed deployment environment. It does not
prove that the deployment is identical to a local checkout.

## Checks

| Check | Result | Evidence |
| --- | --- | --- |
| Create and cloud-save | Pass | Created the dedicated project, added one box, waited for `Sync Synced`, and saw the saved-in-account state. |
| Save/reopen | Pass | Returned to the project list, reopened the acceptance project, and recovered the box, feature/body counts, and `Sync Synced`. |
| Owner access and lease | Pass | Sharing showed owner role, live room, active edit lease, one active owner session, zero members, and zero pending invitations. |
| Cross-device cloud sync | Not proven | A second Chrome session was unauthenticated: the UI reported `Local only` and disabled edits because the project was open in another tab. This is a second browser session, not a second authenticated device. |
| Revocation / lease-expiry takeover | Not run | Requires a second authenticated identity or device. No access change was made against the acceptance resource. |
| Migration and backup recovery | Not proven live | Health readiness passed, but remote migration history and backup restore were not inspected or changed. |
| Artifact orphan cleanup | Inconclusive | One stored file appeared after reopen although this run intentionally created only a box. The record was inspected read-only; no deletion was attempted. Reproduce with an artifact-specific test before calling it a defect. |

## Local verification

Using Node `v22.23.1`, the bounded L01 suites passed: 11 files and 191 tests.
Those synthetic tests are separate from the live result and do not prove
multi-device behavior.

## Remaining acceptance input

Finish L01 with a second authenticated browser/device identity that can open the
acceptance project: remote edit on A, fresh open on B, offline edit on B, remote
edit on A, recovery-copy resolution on B, then access removal or lease expiry and
a denied write from the former collaborator.
