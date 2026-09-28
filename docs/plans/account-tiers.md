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

| Allowance                                       | Free default | Premium default |
| ----------------------------------------------- | ------------ | --------------- |
| Hosted AI requests per 10 minutes               | 6            | 600             |
| Weighted AI units per 10 minutes                | 24           | 2,400           |
| Cloud projects                                  | 100          | 10,000          |
| Cloud project document/asset storage            | 2 GiB        | 100 GiB         |
| Concurrent AI requests                          | 2            | 8               |
| Cloud artifacts, including pending reservations | 2 GiB        | 100 GiB         |
| Requests per IP per window                      | 30           | 3,000           |
| Weighted units per IP per window                | 120          | 12,000          |
| Concurrent requests per IP                      | 8            | 32              |

Premium IP buckets are separate from Free buckets. Account buckets remain the
same across tier changes so an upgrade or downgrade cannot reset consumption.
The existing `AI_RATE_LIMIT_WINDOW_SECONDS` controls both tiers' window length.
Existing Free configuration names are retained. Premium overrides are:

- `PREMIUM_PROJECT_LIMIT` (positive integer, at most 100,000)
- `PREMIUM_PROJECT_STORAGE_LIMIT_BYTES` (positive integer, at most 1 TiB)
- `PREMIUM_ARTIFACT_LIMIT_BYTES` (positive integer, at most 1 TiB)
- `AI_PREMIUM_ACCOUNT_RATE_LIMIT_REQUESTS` (at most 1,000)
- `AI_PREMIUM_ACCOUNT_COST_LIMIT_UNITS` (at most 10,000)
- `AI_PREMIUM_ACCOUNT_CONCURRENCY_LIMIT` (at most 100)
- `AI_PREMIUM_IP_RATE_LIMIT_REQUESTS` (at most 10,000)
- `AI_PREMIUM_IP_COST_LIMIT_UNITS` (at most 100,000)
- `AI_PREMIUM_IP_CONCURRENCY_LIMIT` (at most 100)

Invalid or nonpositive overrides use the tier default. Limits are finite
operational ceilings; the UI does not promise unlimited provider availability.
Weights use configured output-token budgets and attachments, not token invoices.

Premium grants hosted-AI eligibility alongside `AI_DEPLOYMENT_ALLOWED_EMAILS`.
Free membership does not newly enable deployment-funded AI for all signups.
Personal credentials still bypass deployment-funded window and daily quotas,
while retaining concurrency guards. Local modeling and local export remain
unchanged. File size, upload-session, revision retention, geometry, authentication,
and timeout protections are unchanged.

The official deployment daily budget becomes 10,000 requests / 40,000 weighted
units, shared across tiers, instead of 100 / 400. This increases the maximum
permitted hosted-AI spend; it is not a monetary budget. Self-hosted defaults stay
100 / 400 unless configured. Budget exhaustion still stops Premium requests.

## Storage and downgrade behavior

Migration `0022_account_tiers.sql` adds derived `users.artifact_limit_bytes`, `project_limit`,
and `project_storage_limit_bytes`, defaulting to the existing Free ceilings. This is derived enforcement state, not a second
membership source. The Worker refreshes the owner's value on upload creation and
each upload operation, project creation and document/revision save. Atomic SQLite triggers enforce the value across concurrent
Workers, single-part finalization and multipart reservations. Direct database
writers must not treat a stale derived value as a current membership lookup.

Downgrades do not delete files. Existing reads, downloads and cleanup remain
available. Over-limit accounts cannot increase artifact usage; shrinking an
existing reservation and finalizing already-reserved bytes remain possible.
The API reports the current effective quota even before the next storage write.

`/api/session`, browser login and desktop token responses expose only the current
account's `entitlements`. `/api/account/storage` reports the owner's effective
artifact allowance. Settings shows membership, AI allowances and artifact usage.
Older responses without entitlements remain readable by the frontend.

## Rollout and verification

Apply migration 0022 before routing traffic to the new Worker. Keep the previous
migration intact; this is an additive migration with replacement quota triggers.
Do not deploy the new upload code without the new column. An older Worker remains
compatible with the migrated schema; when rolling back tier code, also reset
the three derived quota columns to their Free ceilings if revoking all Premium storage
allowances is intended. Never delete account data as part of rollback.

Tests cover exact membership matching, hosted-AI eligibility, Free/Premium limits,
shared IP isolation, global budgets, forged headers, downgrade usage retention,
owner attribution, concurrent reservations, quota errors and downgrade cleanup.
Migration tests exercise both SQLite execution and Wrangler's statement splitter.
Browser tests cover both badges and effective allowance text. Run the repository
lint, typecheck, tests, parity corpus, build and Playwright gates. Record merged,
migration, deployment and live-account evidence separately in ROADMAP.md.
