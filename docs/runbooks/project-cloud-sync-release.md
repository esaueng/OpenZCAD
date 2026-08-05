# Project cloud-sync release runbook

Project sync is local-first: a failed account write must leave the IndexedDB
copy usable. This runbook is the production gate for the D1 metadata and R2
document-object path described by ADR-003 and ADR-016.

Migration, Cloudflare Builds configuration, deployment, production testing,
legacy backfill, and feature-flag changes are separate approvals. Do not treat
approval for one as approval for the others.

## 1. Preflight

1. Refresh `origin/main` and require its validation checks to pass.
2. Record a D1 Time Travel recovery bookmark before applying migrations.
3. Confirm the target Worker binds the intended D1 database and `ARTIFACTS` R2
   bucket. Do not create or substitute production resources from this runbook.
4. List remote D1 migrations and inspect any pending SQL before applying it.
5. Confirm `/api/health` reports both `documentStorageAccountingReady` and
   `projectObjectStorageReady` as `true` after the migration step.

## 2. Fail-closed build configuration

The default-branch Cloudflare Build must run the repository release command:

```text
pnpm run deploy:beta
```

That command applies remote D1 migrations before `wrangler deploy`. Verify the
Cloudflare build token has the required D1 and Worker permissions before
changing the production build setting. If it cannot apply migrations, make the
default-branch build fail and use a separately approved release job; never fall
back to a raw `wrangler deploy` that can publish code ahead of its schema.

Changing the Cloudflare Build command is a live configuration mutation and
requires explicit approval.

## 3. Authenticated canary

After deployment approval, use a disposable project rather than an existing
design:

1. Sign in on device A and create or adopt the canary project.
2. Make one identifiable edit and wait for both workspace indicators to report
   `Synced`.
3. Confirm D1 has a committed `project_document_objects` pointer for the canary
   and R2 has its corresponding `project-storage/` document object.
4. Reload device A and verify the exact name, document version, feature history,
   parameters, and units.
5. Sign in on device B, open the canary, and verify the same canonical document.
6. Edit on device A, then focus device B and verify polling pulls the update.
7. Take device B offline, edit both devices, reconnect B, and verify the
   conflict dialog appears. Resolve it and confirm the losing document exists
   as a local recovery project.
8. Reload both devices once more and confirm the resolved version remains
   stable with no console errors or readiness warnings.

Delete or retain the canary only under the normal project-retention policy.

## 4. Optional follow-ups

- Enabling `PROJECT_PERSONAL_SYNC_ENABLED` replaces the browser polling delay
  with owner-only Durable Object push. It does not enable sharing or leases and
  requires its own rollout approval and two-device canary.
- Desktop remains on HTTP polling until a ticketed WebSocket authentication
  handshake exists.
- Backfilling legacy D1 documents into R2 is optional because reads retain the
  legacy fallback. Any backfill must be resumable, checksum-verified, preceded
  by a recovery bookmark, and separately approved.
