# ADR-012: Email-code identity and owner-scoped cloud data

## Status

Accepted. Supersedes the Cloudflare Access identity portion of
[ADR-007](ADR-007-access-auth-and-live-rooms.md).

## Decision

Use passwordless email codes as the optional beta identity boundary. Login
challenges are Turnstile-protected, single-use, attempt-limited, and expire
after ten minutes. Successful verification creates an opaque host-only session;
D1 stores only the token hash and the verified email associated with the stable
user ID.

Every project, revision, artifact, setting, credential, and live collaboration
operation remains owner-scoped. Local development uses the explicit
`development` mode and isolated `user_beta_dev` identity; the Worker refuses
that mode in guarded or non-development environments.

Deployment-funded AI is a separate authorization decision: an authenticated
email must appear in `AI_DEPLOYMENT_ALLOWED_EMAILS`. Public assistant identity
and IP quota buckets use domain-separated HMAC values keyed by the Worker-only
`AI_IDENTITY_PEPPER`.

## Consequences

- Cloudflare Access is not required for beta sign-in.
- Email delivery, Turnstile, D1, and stable Worker secrets are deployment
  prerequisites.
- Open signup does not grant access to the deployment's AI provider key.
- The raw connecting IP is not persisted or sent to the AI provider.
