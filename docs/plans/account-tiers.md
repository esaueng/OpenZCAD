# Free and manually granted Premium accounts

Roadmap: **L10**. Membership is resolved from server configuration, not stored
in client preferences, sessions, or a billing subscription.

## Membership

Set the Worker secret `PREMIUM_USER_EMAILS` to a comma-separated list of account
email addresses. Matching trims whitespace and lowercases complete addresses;
it does not support wildcards, domain grants, or plus-address aliases. Missing
or empty configuration gives every account Free membership. Never commit real
members' email addresses. Local development may use the gitignored `.dev.vars`.
Development-header identities have no verified email and remain Free.

For the official deployment, edit the secret on the `openzcad` Worker serving
`zcad.app`, or use `pnpm --filter @openzcad/web exec wrangler secret put
PREMIUM_USER_EMAILS --config ../../wrangler.jsonc` with an authenticated CLI.
Enter the full desired list at the prompt; replacing it removes omitted grants.
Changing a secret activates a configuration version using the existing Worker
code; it does not deploy this implementation or apply its migration.

The Worker computes membership on requests from verified session emails. For
shared storage it reads the project owner's account email, never the uploader's
membership. Updated membership applies to requests using the new configuration;
requests already running on an older configuration may finish under that policy.

## Allowances

| Allowance                         | Free default | Premium default |
| --------------------------------- | ------------ | --------------- |
| Hosted AI requests per 10 minutes | 6            | 600             |
| Weighted AI units per 10 minutes  | 24           | 2,400           |
| Cloud projects                    | 100          | 10,000          |
| Storage (one bucket, see below)   | 1 GiB        | 25 GiB          |
| Concurrent AI requests            | 2            | 8               |

Storage is one allowance per account (migration
`0049_unified_account_storage.sql`): projects, save states and source assets
(plaintext or encrypted) and imports, exports and encrypted files, including
pending upload reservations, all count against the same bucket. Free is
1 GiB in total, not 1 GiB for projects plus 1 GiB for files.

Account buckets remain the same across tier changes so an upgrade or downgrade
cannot reset consumption. Accounts sharing an IP have independent allowances.
The existing `AI_RATE_LIMIT_WINDOW_SECONDS` controls both tiers' window length.
Existing Free configuration names are retained. Premium overrides are:

- `PREMIUM_PROJECT_LIMIT` (positive integer, at most 100,000)
- `PREMIUM_STORAGE_LIMIT_BYTES` (positive integer, at most 1 TiB): the one
  storage allowance. When it is unset, the names from before storage was one
  allowance still apply, in this order: `PREMIUM_PROJECT_STORAGE_LIMIT_BYTES`,
  then `PREMIUM_ARTIFACT_LIMIT_BYTES`.
- `AI_PREMIUM_ACCOUNT_RATE_LIMIT_REQUESTS` (at most 1,000)
- `AI_PREMIUM_ACCOUNT_COST_LIMIT_UNITS` (at most 10,000)
- `AI_PREMIUM_ACCOUNT_CONCURRENCY_LIMIT` (at most 100)

Invalid or nonpositive overrides use the tier default. Limits are finite
operational ceilings; the UI does not promise unlimited provider availability.
Weights use configured output-token budgets and attachments, not token invoices.

The built-in MiniMax M3.1 Flash free model is available to every verified account
when `AI_DEPLOYMENT_FREE_ENABLED=true`, the configured provider is OpenRouter,
the model ID ends in `:free`, and no custom endpoint is set. Official and example
configurations enable this option. Free requests cap provider prompt, completion
and per-request prices at zero and retain the exact model through fallback;
provider rate limits and availability still apply. Missing the OpenRouter key
fails closed rather than switching the public assistant to a paid provider.

Paid or private deployment models retain the existing eligibility policy:
Premium membership or `AI_DEPLOYMENT_ALLOWED_EMAILS`.
Personal credentials still bypass deployment-funded window quotas,
while retaining concurrency guards. Local modeling and local export remain
unchanged. File size, upload-session, revision retention, geometry, authentication,
and timeout protections are unchanged.

There is no shared deployment or IP usage cap. Each authenticated account has
its own request, weighted-unit and concurrency limits. With the deployment
provider key, total spend can grow with the number of eligible accounts;
provider-side billing controls remain separate.

## Storage and downgrade behavior

Migration `0022_account_tiers.sql` adds derived `users.artifact_limit_bytes`, `project_limit`,
and `project_storage_limit_bytes`, defaulting to the existing Free ceilings. This is derived enforcement state, not a second
membership source. The Worker refreshes the owner's value on upload creation and
each upload operation, project creation and document/revision save, and each
isolate brings every account's stored values to the current policy once, on its
first authenticated API request (`syncStoredAccountLimits`): encrypted saves,
copies and migrations do not refresh the owner's row themselves. The database
fallback for a project without a `users` row stays 2 GiB, as the triggers
hard-code it; the in-flight reservation ceiling stays 2 GiB for every tier. Atomic SQLite triggers enforce the value across concurrent
Workers, single-part finalization and multipart reservations. Direct database
writers must not treat a stale derived value as a current membership lookup.

Migration `0049_unified_account_storage.sql` makes storage one allowance. It
adds no column: both `artifact_limit_bytes` and `project_storage_limit_bytes`
hold the same unified value (the Worker writes it to both; the migration
copies the larger into both for any row where they differ), and every quota
trigger compares the account's combined usage with
`project_storage_limit_bytes`. Combined usage is the view
`account_project_storage` (inline D1 documents and revisions, R2 document
objects and source assets except plaintext staged for decryption, and
retained envelopes of encrypted projects) plus `artifact_account_usage`'s
finalized and reserved bytes. The per-account in-flight reservation check
keeps reading `artifact_limit_bytes`, which mirrors the same value. The
triggers redefined are `artifact_upload_session_before_insert`,
`artifact_usage_before_artifact_insert`, `artifact_upload_part_before_insert`,
`artifact_upload_part_before_update`, `e2ee_content_blob_usage_before_insert`,
`project_account_d1_project_bytes_before_insert`/`_update`,
`project_account_d1_revision_bytes_before_insert`/`_update`,
`project_account_object_bytes_before_insert`,
`project_account_asset_bytes_before_insert` and `e2ee_project_version_quota`;
each keeps its other checks verbatim.

Encryption migrations stage rows that count only from their cutover on
(decision M10): ciphertext beside a plaintext project, or plaintext beside
an encrypted one. These are bounded by the owner's projected storage:
counted usage plus what every live staging would add at its cutover, less
what that cutover's purge frees (view `migration_staging_growth`). Staging
upload sessions, part reservations, staged blobs and versions, and staged
files, documents and assets are refused once that would pass the allowance,
so staging is cumulative and bounded. A full account can still stage a
migration that shrinks it, because the purge credit makes the room. Both
cutovers (`encryptCutoverQuota` and `decryptCutoverQuota` in
`apps/web/worker/e2eeProjectMigrations.ts`) refuse, in their own statement,
a cutover that grows the combined measure past the allowance. The forward
cutover credits the plaintext upload reservations its purge discards.
Staging is not abandoned automatically for being idle: the projected rule
already bounds and charges what a staging holds, and an abandoned staging is
cleaned up by its owner's browser or by the existing sweeps.

A save that moves a project's head to a new R2 document object names the
head it replaces (`project_document_objects.supersedes_object_id`, added by
migration 0049). The object's admission and the Worker's preflight credit
that head when nothing else names it, so a save that does not grow what the
account stores is never refused, even at or over the allowance. The credit
is granted only while the project holds no other unreclaimed object (a
replaced head whose pruning failed), so at most one replacement's bytes are
ever outstanding. A source asset added by the same save names that save's
object (`project_storage_assets.added_by_object_id`) and is judged with it:
the save's assets share the one credit, so the object and all its assets less
the replaced head is what is checked. A head-replacing save first prunes any
replaced head an earlier R2 delete left behind, so a temporary failure does
not withhold credit for good.

Downgrades do not delete files. Existing reads, downloads and cleanup remain
available. Over-limit accounts cannot increase storage; shrinking an existing
reservation or document, finalizing already-reserved bytes and deleting
remain possible. The API reports the current effective quota even before the
next storage write.

`/api/session`, browser login and desktop token responses expose only the current
account's `entitlements`, with `storageLimitBytes`; the older
`projectStorageLimitBytes` and `artifactLimitBytes` stay, equal to it, for
clients that predate the single allowance. `/api/account/storage` reports
`storageBytes` (everything stored) against `storageLimitBytes`, with the
breakdown: `projectStorageBytes`, project storage as the quota triggers
measure it, and `artifactBytes`, finalized files. `projectCount` counts
projects outside the recycle bin, as the library lists them, and
`trashedProjectCount` those in it, whose bytes still count. Settings shows
membership, AI allowances and one storage meter with that breakdown.
Older responses without entitlements or the combined fields remain readable
by the frontend.

## Rollout and verification

Apply migration 0022 (and 0049 for the single allowance) before routing
traffic to the new Worker. Keep the previous
migration intact; this is an additive migration with replacement quota triggers.
Do not deploy the new upload code without the new column. An older Worker remains
compatible with the migrated schema; when rolling back tier code, also reset
the three derived quota columns to their Free ceilings if revoking all Premium storage
allowances is intended. Never delete account data as part of rollback.

Tests cover exact membership matching, hosted-AI eligibility, Free/Premium limits,
independent accounts behind one IP, forged headers, downgrade usage retention,
owner attribution, concurrent reservations, quota errors and downgrade cleanup.
Migration tests exercise both SQLite execution and Wrangler's statement splitter.
Browser tests cover both badges and effective allowance text. Run the repository
lint, typecheck, tests, parity corpus, build and Playwright gates. Record merged,
migration, deployment and live-account evidence separately in ROADMAP.md.
