# Glimpse integration

OpenZCAD uses its own `GLIMPSE` service binding and fixed app entrypoint in [Glimpse](https://github.com/esaueng/glimpse). See the service's [setup](https://github.com/esaueng/glimpse/blob/main/docs/SETUP.md) and [privacy/consent review](https://github.com/esaueng/glimpse/blob/main/docs/PRIVACY.md).

## Collection and controls

Optional usage collection is browser-only. The packaged desktop app displays an explanation instead of a consent control and sends no optional usage requests. Turning off the browser's **Cloud features** switch also suppresses new sends and aborts in-flight requests without changing the saved consent choice.

Basic statistics count backend API requests, HTTP 5xx failures and response time buckets. They exclude health probes, static assets and the optional-analytics relay. No browser Basic ping is added. Since exports and solves run locally, those appear only under Optional analytics; backend API totals are not visitor counts.

Optional analytics default off. Consent is an explicit checkbox at **Settings → Privacy & data → Optional usage analytics**. The choice is per browser and app origin, never synced to an account or across apps. The new versioned `granted-v2` preference is not a visitor identifier. Older default-on analytics choices do not grant Glimpse consent. Withdrawal stops future sends immediately, aborts pending requests, and follows cross-tab storage changes. DNT/GPC suppress collection. Already received aggregates cannot be attributed or removed; no per-person history exists. If browser storage blocks withdrawal, the current page stops collection and explains how to clear the older saved grant.

The browser sends exactly `event` and a fixed `bucket`, omitting credentials and referrer. The Worker relay accepts only same-origin, bounded POST JSON, rejects extra keys, and forwards a freshly constructed metric over the app's service binding. Glimpse immediately increments daily aggregate counters; it has no raw event store. Neither payload contains model contents, geometry, filenames, project names, emails, URLs, error text/stacks, IP, user agent, accounts, sessions, device or visitor identifiers. Feature actions and workflow steps are independent counts, not individual sequences. Backend and optional levels stay separate. Optional totals represent **opted-in users only**.

`worker/glimpse.ts` is the relay/backend allowlist; `src/lib/analytics.ts` is the client. Fixed durations are `<100 ms`, `100 ms–1 s`, `1–10 s`, `10–60 s`, `≥60 s`; exact timings are never sent. A constant app-wide rate-limit key bounds optional ingress without fingerprinting/IP keys. This can drop valid events and cannot prevent a custom client from spoofing allowed counts. Metrics are best effort, not billing or business records.

## Configuration and rollout

Production enables `GLIMPSE_BASIC_ENABLED` and `GLIMPSE_USAGE_ENABLED` with the fixed `OpenZCADIngest` service binding. Enabling the deployment switches does not grant browser or account consent. Self-hosted and preview configurations must deliberately configure their own collector or remain disabled. The two switches are independent; the Optional switch additionally requires the browser's explicit opt-in. Missing/unavailable collectors do not affect app operations. Self-hosted/static configurations stay unconfigured unless deliberately connected to a separately protected service.

Deploy and configure the Glimpse Worker/D1/Access application first; then deploy this integration with its service binding. Confirm the intended audience, jurisdictions, lawful basis where relevant, notices and metadata retention before enabling Basic. Optional remains opt-in even if a jurisdiction offers an analytics exemption. Cookieless does not automatically mean consent-free. Edge/Access/existing app security logs still need separate review: the network necessarily processes IP and headers, although analytics stores neither. Dashboard authentication uses its own Access identity/cookies, not analytics identifiers.

Production collection activation is authorized. Browser choices and the separate account-statistics permission remain independent and opt-in. Roll back by setting both deployment switches to false and redeploying; users may withdraw independently through the same UI.

## Validation

Regression tests cover new-browser/legacy defaults, explicit opt-in, payload minimization, no cookies/referrer, immediate and cross-tab withdrawal, blocked storage, DNT/GPC, strict relay validation, streamed-body size enforcement, rate limits, kill switches and failure isolation. See the PR for the exact commands/results and any browser/CI limitations. Local tests and synthetic dashboard data do not prove production delivery, Access configuration or consent compliance for the eventual deployment.


## Expanded diagnostics (v2)

The updated notice requires a fresh browser choice; `granted-v1` is no longer a
valid grant. All expanded statistics require opt-in. Fixed diagnostic codes,
feature categories, size/part ranges and operation timing buckets are validated
by the mirrored `glimpseContract.ts` vocabulary in the client, relay and service.
Raw errors, stacks, names, content, geometry and identifiers are never forwarded.
Report counters live only in the current opted-in page, without time/order/IDs.
Withdrawal clears them and aborts sends. The user may explicitly download a
bounded JSON report, review it, then share it themselves. No automatic upload.
The Glimpse owner can inspect a strict report locally, using a file or pasted JSON.

Successful transactions contribute operation-kind observations for their
committed commands and one feature-use observation per commit. Part-count
observations wait for the committed rebuild, include hidden parts and exclude
consumed replay sources. Rapid edits can coalesce into the latest completed
part-count observation.

The complete [measurement definitions and limits](https://github.com/esaueng/glimpse/blob/codex/diagnostics-overhaul/docs/EXPANDED-ANALYTICS.md)
explain repeatable observations versus account/project stocks and the consent
review. Size observations are not unique projects, parts are not a per-part
inventory, and diagnostic signals are not distinct bugs. No unique anonymous
user count or cross-app identity exists. Transfer download observations measure successfully parsed JSON response bodies
as uncompressed UTF-8 bytes, including both project and revision loads.
Project/revision metadata listings are excluded. Pruned revision 404s retain
their normal null result and do not contribute cloud-failure observations.
Startup and library opens skip the account document request for a device-only
project when a successful account listing confirms there is no cloud copy.
Previously synced projects, listed account projects, cloud-only opens and
unreachable listings still use the normal load path and retain genuine failure
observations. This prevents expected local-only 404 probes from appearing as
cloud-load errors without suppressing missing account documents or outages.
Already published anonymous event totals remain historical observations.
Failed or malformed downloads do not contribute a size observation.
Delivery is best effort and can drop
counts; reports' page-local counts need not equal delivered service counts.

OpenZCAD separately offers an expiring **Cloud account statistics for 30 days**
choice under Settings → Privacy. It covers this account's retained owned projects
(including trash), revisions and numeric stored/logical byte metadata, across
its devices. Only this explicit grant enrolls the account; neither sign-in nor
browser analytics does. The account preference's existing user key and expiry
stay in OpenZCAD. Erasing accounts are excluded; deletion cascades the grant.
DNT/GPC suppresses browser analytics but does not revoke the separate account
permission: withdraw it with its own checkbox. The UI reads server state,
displays expiry and explains failed changes. A failed/offline request has an unconfirmed outcome: refresh to read the server
permission. Until withdrawal is confirmed, assume an existing grant may remain
active until its 30-day expiry.

The hourly existing cron and consent changes publish aggregate snapshots with
an app-wide monotonic generation. No account/project key leaves this app, and
Glimpse discards late/replayed generations. The dashboard shows the latest stock
inside the selected date range, never the sum of daily stocks. Stored bytes use
R2 objects/assets/artifacts and fallback D1 document bytes without double counting
R2 projections; logical document-size buckets exclude external assets. Shared
projects count under their consenting owner, not members. Backend never reads
model contents to derive analytics.

**Rollout dependency:** reviewed, separately authorized production migrations
Glimpse `0003_census.sql` and OpenZCAD `0028_glimpse_consent.sql`, then service
before app code. Both migrations must be present before enabling production collection; activation verifies the live migration ledgers. Browser and account permission checks remain required.

Local v2 verification: root 4,629 passed / 8 skipped; web 2,956 passed; parity
185 passed / 1 skipped. Typecheck, production build/bundle gate and Wrangler
dry-run passed. Lint: zero errors, 16 existing hook warnings. Settings browser
suite: 29 passed, plus three repeated cloud-off cold-reload probes. Focused
consent/API/census checks: 99 root and 62 web passed. The full unrelated browser
suite was not rerun. The master cloud switch is rechecked from persisted storage
on every send, including startup and other-tab changes; regression coverage
protects this boundary. Hosted checks and production verification are separate.

## Kernel refusal harvest (WS3)

When a candidate rebuild introduces a refusal the build on screen did not
already have, an opted-in browser sends one `kernel_refused` observation. Its
bucket is the whole payload, eight fields joined by `|` in a fixed order:

`operation|family|kernelOperation|category|code|warningKind|target|neighbours`

- `operation`: the refusing feature's kind, or `direct-edit.<operation kind>`.
- `family`, `kernelOperation`, `category`, `code`: `FeatureWarning.kernelRefusal`
  (`none` when the kernel gave no classification).
- `warningKind`: `build-failed` or `refusal`; advisories and suppressions are
  never reported.
- `target`, `neighbours`: the surface types (`plane`, `cylinder`, `cone`,
  `sphere`, `torus`, `bspline`, `other`) of the picked face and of the faces
  sharing an edge with it, or the faces an edge modifier's edges bound. Read
  from topology the build already published; `none` when it is not on hand.

Every field except `code` is a closed list; a value outside it is sent as
`other`. `code` is the kernel's stable identifier, which the pin does not
enumerate: it must be lower-case words joined by underscores (no digits),
at most 48 characters, and must not start with one of the app's id prefixes.
Anything else is `other`. The bucket is capped at 200 characters. The client,
the relay and the report parser share `parseKernelRefusedBucket`, which only
accepts a bucket in canonical form, so no geometry, dimension, name, hash, id,
file name or free text can pass. Repeated previews of one edit (same base
document state and cell) count once per page; the de-duplication key stays in
the page. The Glimpse service must mirror this vocabulary before it records
the event; until then the relay forwards it and the service drops it.

**Save reproduction** is separate and never automatic. Beside a refusal's
**View details** (operation card, selection chip and Parameters row; not Tweak
mode or share links), and only while the latest candidate rebuild is the one
that refused — a later rebuild that builds, a commit or a project switch
withdraws it — it downloads an `openzcad-direct-edit-fixture` (format 2, `feature-build` op): the
feature history up to and including the refused feature, the kernel pin and
the refusal record. Project, part, body, feature and sketch names become
neutral labels (also inside the refusal text), user ids and project ids are
replaced, and later features, the command log, revisions, assets, parameter
descriptions, drawings, folders, reference images, assemblies and branch
provenance are removed. Parameter names, sketch geometry (including sketch
text) and generated feature/body ids remain because the rebuild reads them.
Imported STEP/mesh documents are saved without the model. The file can be
dropped into `test/direct-edit-corpus/fixtures/` and replayed.
