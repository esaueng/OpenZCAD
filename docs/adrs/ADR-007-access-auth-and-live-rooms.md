# ADR-007: Cloudflare Access Identity and Per-Project Live Rooms

## Status

Superseded in part by [ADR-012](ADR-012-email-code-identity.md). The live-room
design remains current and has been extended with owner/editor/viewer roles,
sharing invitations, one persisted project edit lease, and explicit conflict
recovery. The Cloudflare Access identity decision does not remain current.

## Decision

The original decision used Cloudflare Access as the beta identity boundary.
That identity paragraph is historical and is superseded by ADR-012's single-use
email codes and opaque sessions. Local development still uses the explicit
`development` mode and isolated `user_beta_dev` identity;
`AUTH_LEGACY_OWNER_EMAIL` maps historical projects to a verified email without
rewriting stored documents.

Route each authenticated project WebSocket through one Durable Object. The room tracks presence and the latest canonical document, broadcasts only newer versions, and reports same-version divergent snapshots as conflicts. Every message is authorized against the current project role. Owner/editor writes require the one project-wide lease when enforcement is enabled; the lease is persisted before grant and bound to project, client, user, and expiry. Viewers never acquire a lease.

Clients preserve unresolved local divergence in IndexedDB and retain a small
reload sentinel instead of entering an autosend loop. Before choosing the room
version, submitting the local version, or saving it as a separate copy, the
client first writes a recovery project. Keeping the local version requires the
active client lease and exact expected room version.

## Consequences

- Existing HTTP route shapes and document schemas remain compatible.
- Public beta routes require the ADR-012 email-code configuration and must never
  expose development authentication.
- Invitation/member APIs, role-aware UI, edit leases, and conflict recovery are
  implemented. Checked-in beta and development flags remain off pending a
  viewer-first/editor-second rollout; implementation is not production
  enablement.
- Durable room event history beyond the bounded canonical snapshots remains a
  separate milestone.
- Large documents remain editable and saveable, but live broadcast pauses above the client snapshot limit.
