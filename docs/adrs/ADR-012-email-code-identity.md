# ADR-012: Email-code identity and role-scoped cloud data

## Status

Accepted. Supersedes the Cloudflare Access identity portion of
[ADR-007](ADR-007-access-auth-and-live-rooms.md). Project sharing later extended
the original owner-only authorization model with explicit owner/editor/viewer
roles while retaining this identity mechanism.

## Decision

Use passwordless email codes as the optional beta identity boundary. Login
challenges are Turnstile-protected, single-use, attempt-limited, and expire
after ten minutes. Successful verification creates an opaque host-only session;
D1 stores only the token hash and the verified email associated with the stable
user ID.

Settings and personal credentials remain scoped to the authenticated user.
Project documents, revisions, artifacts, and live collaboration require a
current project role: owners and editors may write, viewers may read, and
sharing/member/invitation mutations remain owner-only. Edit writes additionally
require the active project lease when enforcement is enabled. Local development
uses the explicit `development` mode and isolated `user_beta_dev` identity; the
Worker refuses that mode in guarded or non-development environments.

Deployment-funded AI is a separate authorization decision: an authenticated
email must have Premium membership or appear in `AI_DEPLOYMENT_ALLOWED_EMAILS`.
That allowlist is optional; without either grant, the deployment funds no AI.
Public assistant identities use HMAC values keyed by the Worker-only
`AI_IDENTITY_PEPPER`. The later account-tier policy limits AI usage per account
without an IP or deployment-wide quota.

## Temporary beta QA exception

With a capability issued for no more than seven days, the owner-authorized
QA account may request email codes without Turnstile on `https://beta.zcad.app` only, from a browser
provisioned with a separate secret capability. Email-code verification,
wrong-code limits, requester/email/IP send limits and session authorization
remain mandatory. Other accounts and hosts keep Turnstile. The capability is
disabled by default and fails closed on invalid issuance, lifetime or expiry.
Each renewal rotates the Worker secret and reprovisions the browser; no code
deployment or PR is required.
See [the temporary QA runbook](../qa/temporary-turnstile-capability.md) for
provisioning and immediate revocation. This exception does not grant project,
encryption-key, account-tier or AI access.

## Consequences

- Cloudflare Access is not required for beta sign-in.
- Email delivery, Turnstile, D1, and stable Worker secrets are deployment
  prerequisites.
- Open signup does not grant access to the deployment's AI provider key.
- The raw connecting IP is not persisted or sent to the AI provider.
