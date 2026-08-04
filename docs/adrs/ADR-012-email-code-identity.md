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
email must appear in `AI_DEPLOYMENT_ALLOWED_EMAILS`. That secret is optional
and fails closed — a deployment that never sets it funds no AI at all, which
is why it is not among the secrets a deploy requires. Public assistant identity
and IP quota buckets use domain-separated HMAC values keyed by the Worker-only
`AI_IDENTITY_PEPPER`.

## Consequences

- Cloudflare Access is not required for beta sign-in.
- Email delivery, Turnstile, D1, and stable Worker secrets are deployment
  prerequisites.
- Open signup does not grant access to the deployment's AI provider key.
- The raw connecting IP is not persisted or sent to the AI provider.
