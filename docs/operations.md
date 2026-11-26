# Operating OpenZCAD on Cloudflare

This page covers the official hosted deployment, the sign-in and invitation
security model, health checks and the Worker's API surface. For an
independent instance in your own Cloudflare account, follow
[Self-hosting OpenZCAD](SELF_HOSTING.md); for the beta and stable channels,
see [Release channels](release-channels.md).

The browser application works offline without cloud services. The Worker adds
accounts, cloud projects, artifact storage, collaboration, end-to-end
encryption key exchange, and optional server-side AI. Geometry and exports
never run in the Worker.

## Official deployment

The checked-in root `wrangler.jsonc` (beta, `beta.zcad.app`) and
`wrangler.stable.jsonc` (stable, `zcad.app`) are the canonical configurations
for the official deployments. Their D1 IDs, bucket names, Worker names, public
site keys, and domains are non-secret identifiers; they do not grant access.
Never copy them into a self-hosting configuration. Never deploy
`apps/web/wrangler.jsonc`: it is a development-only config and deliberately
binds a placeholder dev database ID so it cannot write to beta data.

Email sign-in uses Cloudflare Email Service and Turnstile. Before enabling a
real login on a channel:

- onboard the `beta.zcad.app` and `zcad.app` sending domains and keep each channel's `EMAIL` binding restricted to its own sender (`noreply@beta.zcad.app` for beta, `noreply@zcad.app` for stable) for sign-in and project invitations;
- create a managed Turnstile widget allowlisting `zcad.app`, `zcad.esau.app`, `dev.zcad.app` (Worker Previews), `localhost`, and `127.0.0.1`, then bind its site key as `TURNSTILE_SITE_KEY`;
- review the pending remote D1 migrations before deploying with `pnpm deploy:beta` (or `pnpm deploy:stable`); that guarded command applies them before publishing the Worker and then verifies the live commit and every required readiness gate;
- follow the [project cloud-sync release runbook](runbooks/project-cloud-sync-release.md) for the migration gate and authenticated two-device canary;
- set `AUTH_MODE=email-code`, `ENVIRONMENT=beta`, `AUTH_EMAIL_FROM` and `PROJECT_INVITATION_EMAIL_FROM` to that channel's sender, and the channel's canonical `PUBLIC_APP_ORIGIN` used for invitation links (the checked-in configs also set `PRODUCTION_GUARD`, which makes the worker refuse development auth outright);
- provide secrets, generated with `openssl rand -base64 32` where appropriate and set via `wrangler secret put`, never committed: `AUTH_OTP_PEPPER`, `TURNSTILE_SECRET_KEY`, `SETTINGS_ENCRYPTION_KEY` (must stay stable across deploys), and `AI_IDENTITY_PEPPER`. The deployment preflight lists these required secret names without reading their values; verify the remote Worker secret list before deploying;
- AI provider secrets are optional; see [AI assistant configuration](ai-assistant.md#configuration).

`pnpm deploy:beta` and `pnpm deploy:stable` are not validation commands: they
apply remote migrations and need credentials and explicit deployment
authorization.

## Sign-in security

Login codes are single-use and expire after ten minutes. Requests are rate limited per IP, per email and IP, and per email; a throttled request sends no email and answers with the requester's own pending challenge, and a new code never voids an earlier one (a successful sign-in voids them all). Profile or account deletion clears that email's requester limits as well as its pending codes, while preserving the shared IP limit and other emails' limits. After 20 wrong codes for an email in 24 hours, each of its codes allows one try instead of five. Failure counts conservatively remain active until 24 hours after each code expires (at most ten extra minutes), so guesses near expiry cannot age out early. Sessions use a `Secure`, `HttpOnly`, `SameSite=Lax` host cookie; only a SHA-256 hash of the opaque token is stored. Turnstile responses must carry the `email-code` action, and every non-development verification pins the response hostname to the request hostname. `AUTH_LEGACY_OWNER_EMAIL` maps historical `user_beta_dev` projects to their owner's verified email without rewriting documents.

The desktop app signs in through the browser: it starts a short-lived sign-in
attempt, the browser approves it, and the app exchanges it for refreshable
access tokens, so no password or session cookie passes through the native
shell.

## Invitations and collaboration flags

Project invitations are delivered from the channel's sender (`noreply@beta.zcad.app` or `noreply@zcad.app`) as seven-day,
single-use links. The opaque token is carried in the URL fragment, scrubbed
from the address bar on arrival, and kept only in tab-scoped session storage
while email-code sign-in completes. A failed email send revokes the invitation
before the API reports failure. The legacy response still includes the one-time
token for existing clients, but the web UI never displays or asks users to
paste it. Invitations to end-to-end encrypted projects are completed by the
members' browsers; the Worker relays sealed key material it cannot read.

The checked-in hosted configurations enable project sharing, owner-room sync,
and edit leases for every authenticated account. Project ownership and
membership still authorize room and document access, and editor writes require
a persisted lease for that browser. The local development configuration remains
closed by default. `PROJECT_COLLABORATION_CANARY_EMAILS` remains available only
as a scoped fallback if the global flags are closed again.

The hosted configurations also enable end-to-end encryption keys, encrypted
projects and migration of existing projects (`E2EE_KEYS_ENABLED`,
`E2EE_PROJECTS_ENABLED`, `E2EE_MIGRATION_ENABLED`); encryption is not yet the
default for new projects (`E2EE_DEFAULT_ON` stays `false`). The self-hosting
example ships every encryption flag closed. Read the
[end-to-end encryption section](SELF_HOSTING.md#end-to-end-encryption) before
changing any of them. Changing these flags or deploying them is a separate
rollout action, not part of a normal application build.

## Health and liveness checks

`GET /api/health` is public and returns JSON only; it is safe to poll without
credentials and never returns configuration secrets. A healthy running service
returns HTTP 200 with `status: "ok"`. For a cloud-enabled deployment, also
require `artifactUploadAccountingReady`, `documentStorageAccountingReady`, and
`projectObjectStorageReady` to be `true` before enabling project sync. The remaining readiness fields describe
separately deployed capabilities (such as measurement sync and account
erasure); a `false` value means that capability is not ready, not that the
basic service endpoint is down.

```bash
curl --fail --silent --show-error https://your-openzcad-domain.example/api/health
```

Treat a non-200 response, invalid JSON, `status` other than `ok`, or a required
readiness flag set to `false` as a failed rollout. Check the Worker bindings and
the applied D1 schema first; do not mask a readiness failure by changing the
reported status.

The repository's scheduled `Production health` workflow checks the hosted beta
with this same contract once per day and can also be run manually.

For uptime monitors that only need to know the Worker is alive, `GET /healthz`
returns HTTP 200 with JSON `status: "ok"` and a service name. `HEAD /healthz`
returns the same headers without a body; other methods return 405 with
`Allow: GET, HEAD`. Responses use `Cache-Control: no-store`. The endpoint
requires no credentials and performs no storage or upstream requests, so it
reports Worker liveness only, never dependency readiness or browser
geometry/solver health.

Cloudflare Access, WAF, and bot challenges run before the Worker. If a monitor
receives a login redirect or challenge, configure a narrowly scoped exception
for GET/HEAD on the exact `/healthz` path and the intended app hostname, then
verify the JSON response from the monitor's network. Repository changes alone
do not alter those dashboard policies.

## API surface

An overview of the Worker's main routes. The router in
[`apps/web/worker/index.ts`](../apps/web/worker/index.ts) is authoritative; the
end-to-end encryption routes under `/api/e2ee/` (device keys, contacts,
encrypted projects and revisions, invitations, share links and migration) are
not listed individually here.

```text
GET|HEAD /healthz                     (liveness only)
GET  /api/health                      (readiness)
GET  /api/auth/config                 POST /api/auth/email/start
GET  /api/session                     POST /api/auth/email/verify
GET  /api/auth/desktop/config         POST /api/auth/logout
POST /api/auth/desktop/start | approve | exchange | refresh | logout
GET|PATCH /api/settings               PUT|DELETE /api/settings/assistant-credential
POST /api/settings/assistant/test
GET  /api/assistant/status            POST /api/assistant/proposals    (SSE)
GET  /api/account/storage             GET  /api/account/deletion-preview
POST /api/account/delete-data
GET  /api/collaboration/config       (authenticated account capabilities)
GET|POST /api/projects                POST /api/projects/reorder | purge
GET|PATCH|DELETE /api/projects/:id    POST /api/projects/:id/duplicate
PUT  /api/projects/:id/document
GET|POST /api/projects/:id/revisions  GET  /api/projects/:id/revisions/:revisionId
GET|PUT|DELETE /api/projects/:id/measurements
GET  /api/projects/:id/collaboration  (WebSocket upgrade)
POST /api/projects/:id/collaboration  (oversize snapshot recovery)
POST /api/projects/:id/collaboration/ticket
GET  /api/projects/:id/sharing        POST /api/projects/:id/invitations
DELETE /api/projects/:id/invitations/:invitationId
PATCH|DELETE /api/projects/:id/members/:userId
GET|POST /api/projects/:id/share-links
DELETE /api/projects/:id/share-links/:shareLinkId
GET  /api/share                      GET  /api/share/assets/:assetId
GET  /api/share/sources/:artifactId
POST /api/project-invitations/accept
POST /api/uploads                     PUT  /api/uploads/:id/content
POST|DELETE /api/uploads/:id/multipart
PUT  /api/uploads/:id/parts/:n        POST /api/uploads/:id/multipart/complete
POST /api/artifacts/finalize          POST /api/imports/finalize
GET  /api/projects/:id/artifacts      GET  /api/artifacts/:id
GET  /api/artifacts/:id/download
/api/e2ee/…                           (end-to-end encryption; see above)
```

Cloud settings, personal credentials, projects, artifacts, and collaboration require an email-code session; the assistant also serves local-only users, and share-link reads under `/api/share` need no session at all; they carry the link's token in the `x-openzcad-share-token` header rather than the URL (the older `/api/share/:token…` paths are still served for macOS builds and open tabs from before the header). The native app exchanges its fixed-origin bearer request for a short-lived, one-use collaboration ticket before opening a WebSocket, so bearer credentials never enter browser code. Artifacts require an uploaded R2 object before finalization; large uploads go through the multipart routes.

When R2 or Durable Object bindings are absent, the affected routes return a
clean `FEATURE_DISABLED` 501 before touching persistence.
