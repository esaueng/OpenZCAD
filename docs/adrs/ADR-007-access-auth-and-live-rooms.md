# ADR-007: Cloudflare Access Identity and Per-Project Live Rooms

## Status

Accepted.

## Decision

Use Cloudflare Access as the beta identity boundary. The Worker derives a stable user ID from Access's asserted email, scopes every project and artifact operation to that user, and exposes the current identity through `GET /api/session`. Local development uses an explicit `development` mode and the isolated `user_beta_dev` identity. `AUTH_LEGACY_OWNER_EMAIL` maps one Access identity to historical beta data without rewriting stored documents.

Route each authenticated project WebSocket through one Durable Object. The room tracks presence and the latest canonical document, broadcasts only newer versions, and reports same-version divergent snapshots as conflicts. Clients preserve their local document on conflict and continue to use IndexedDB plus D1 checkpoints as durable recovery.

## Consequences

- Existing HTTP route shapes and document schemas remain compatible.
- The beta route must be protected by a real Cloudflare Access policy; development auth must never be exposed publicly.
- Collaboration is owner-only for now. Invitations, roles, locks, and durable room event history are separate milestones.
- Large documents remain editable and saveable, but live broadcast pauses above the client snapshot limit.
