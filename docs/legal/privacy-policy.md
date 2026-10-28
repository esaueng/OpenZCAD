# Privacy policy page

The published privacy policy is the static page
[`apps/web/public/privacy.html`](../../apps/web/public/privacy.html), served
at `https://zcad.app/privacy` (Cloudflare's asset HTML handling maps the path
to the file; the Worker is not involved). It needs no script and no sign-in.
The app links it from Settings → Privacy & data and from the email sign-in
form; the desktop app links the hosted page. ADR-024 makes this page a
prerequisite for any public end-to-end encryption claim
([Delivery phases](../adrs/ADR-024-end-to-end-encrypted-projects.md#delivery-phases),
row 0).

It replaces the review draft in
[`privacy-policy-draft.md`](privacy-policy-draft.md). The maintainer supplied
the legal particulars on 2026-10-26: operator Esau Engineering LLC, contact
help@zcad.app (email only, no postal address), and governing law the State of
Michigan, United States (one sentence in section 1, the only place to edit).

## Placeholders

None left. The effective date (October 28, 2026) is at the top of the page;
update it whenever the policy changes.
`apps/web/src/lib/privacyPolicyPlaceholders.test.ts` ("FILL IN BEFORE MERGE")
fails in `pnpm test:web` while any placeholder in square brackets and capitals
remains in the page, and passes once none do.

## Wording chosen without a maintainer decision

Where the draft left a question open, the page uses wording that is true
without a new commitment. Review these before merge:

- The lawful-bases sentence and the EU/UK representative or DPO line are
  removed: the maintainer confirmed the service is US-focused (2026-10-26).
  Restore them if the service targets EU or UK users.
- Cloudflare Web Analytics: the page says the security policy allows it and
  that Cloudflare can add it, not that it is on. The CSP in
  `apps/web/public/_headers` allows it; the app's own code never loads it.
  The maintainer was not sure whether it is enabled on the zone (2026-10-26):
  check the Cloudflare dashboard and say plainly either way.
- Signed-out assistant counters: "kept without a set expiry". The code has no
  deletion path for them.
- Analytics totals: "may be kept indefinitely". Glimpse's retention is set in
  that service, not here.
- Server logs: "for as long as Cloudflare's Workers Logs keep them for our
  account". The plan's window is not in the code.
- Backups: "up to 30 days", matching ADR-024 and the in-app copy for
  encrypting existing projects. R2 versioning and manual exports, if any, are
  not covered.
- Requests: "email help@zcad.app", with no response deadline.
- International transfers: data "may be processed in the United States and in
  other countries where Cloudflare and the AI provider operate".
- Children: "under 13", the US COPPA threshold.
- Changes: the current version is on the page with its effective date; no
  other notice is promised.
- Legal requests: "We disclose data when the law requires it", with no promise
  to notify users.

## Keeping it true

Every statement in the page was checked against the code when it was
written; `apps/web/src/lib/privacyPolicyPage.test.ts` ties the figures it
states (session and code lifetimes, Trash, revision, room and version-log
retention, share-link and invitation lifetimes, the assistant's history
length, the configured AI provider, Basic statistics) to the constants and
deployment configuration that set them. When a change alters what the
service collects or how it protects it, update the page in the same pull
request. Re-read the encrypted-project sections before turning on
`E2EE_KEYS_ENABLED` or `E2EE_PROJECTS_ENABLED` for everyone: the page
describes encryption as opt-in per account and possibly not yet available.
