# Glimpse integration

OpenZCAD uses its own `GLIMPSE` service binding and fixed app entrypoint in [Glimpse](https://github.com/esaueng/glimpse). See the service's [setup](https://github.com/esaueng/glimpse/blob/main/docs/SETUP.md) and [privacy/consent review](https://github.com/esaueng/glimpse/blob/main/docs/PRIVACY.md).

## Collection and controls

Basic statistics count backend API requests, HTTP 5xx failures and response time buckets. They exclude health probes, static assets and the optional-analytics relay. No browser Basic ping is added. Since exports and solves run locally, those appear only under Optional analytics; backend API totals are not visitor counts.

Optional analytics default off. Consent is an explicit checkbox at **Settings → Privacy & data → Optional usage analytics**. The choice is per browser and app origin, never synced to an account or across apps. The new versioned `granted-v1` preference is not a visitor identifier. Older default-on analytics choices do not grant Glimpse consent. Withdrawal stops future sends immediately, aborts pending requests, and follows cross-tab storage changes. DNT/GPC suppress collection. Already received anonymous aggregates cannot be attributed or removed; no per-person history exists. If browser storage blocks withdrawal, the current page stops collection and explains how to clear the older saved grant.

The browser sends exactly `event` and a fixed `bucket`, omitting credentials and referrer. The Worker relay accepts only same-origin, bounded POST JSON, rejects extra keys, and forwards a freshly constructed metric over the app's service binding. Glimpse immediately increments daily aggregate counters; it has no raw event store. Neither payload contains model contents, geometry, filenames, project names, emails, URLs, error text/stacks, IP, user agent, accounts, sessions, device or visitor identifiers. Feature actions and workflow steps are independent counts, not individual sequences. Backend and optional levels stay separate. Optional totals represent **opted-in users only**.

`worker/glimpse.ts` is the relay/backend allowlist; `src/lib/analytics.ts` is the client. Fixed durations are `<100 ms`, `100 ms–1 s`, `1–10 s`, `10–60 s`, `≥60 s`; exact timings are never sent. A constant app-wide rate-limit key bounds optional ingress without fingerprinting/IP keys. This can drop valid events and cannot prevent a custom client from spoofing allowed counts. Metrics are best effort, not billing or business records.

## Configuration and rollout

The checked-in `GLIMPSE_BASIC_ENABLED` and `GLIMPSE_USAGE_ENABLED` flags both start as `false`. The service binding is deliberately absent until the collector is provisioned, so deploying the disabled integration does not require a separate Worker to exist. Once it is ready, add `"services": [{"binding":"GLIMPSE", "service":"glimpse", "entrypoint":"OpenZCADIngest"}]` to `wrangler.jsonc`. The two switches are independent; the Optional switch additionally requires the browser's explicit opt-in. Missing/unavailable collectors do not affect app operations. Self-hosted/static configurations stay unconfigured unless deliberately connected to a separately protected service.

Deploy and configure the Glimpse Worker/D1/Access application first; then deploy this integration with its service binding. Confirm the intended audience, jurisdictions, lawful basis where relevant, notices and metadata retention before enabling Basic. Optional remains opt-in even if a jurisdiction offers an analytics exemption. Cookieless does not automatically mean consent-free. Edge/Access/existing app security logs still need separate review: the network necessarily processes IP and headers, although analytics stores neither. Dashboard authentication uses its own Access identity/cookies, not analytics identifiers.

Production deployment and remote migrations require separate authorization. No production resources, consent decisions or settings were changed by this PR. Roll back by setting both deployment switches to false and redeploying; users may withdraw independently through the same UI.

## Validation

Regression tests cover new-browser/legacy defaults, explicit opt-in, payload minimization, no cookies/referrer, immediate and cross-tab withdrawal, blocked storage, DNT/GPC, strict relay validation, streamed-body size enforcement, rate limits, kill switches and failure isolation. See the PR for the exact commands/results and any browser/CI limitations. Local tests and synthetic dashboard data do not prove production delivery, Access configuration or consent compliance for the eventual deployment.
