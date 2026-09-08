# ADR-019: Durable collaboration authorization and edit leases

## Status

Accepted. Extends [ADR-007](ADR-007-access-auth-and-live-rooms.md) and the
email-code identity decision in [ADR-012](ADR-012-email-code-identity.md).

## Decision

D1 is the durable source of truth for project ownership and editor/viewer
membership. The owner role is derived from the project record and cannot be
reassigned through the member API. Invitations carry 256-bit random bearer
tokens, D1 stores only their hashes, and acceptance consumes an unexpired,
unrevoked token once in the same conditional batch that grants membership.

Every REST route resolves the caller's current role before acting. Project,
member, and invitation administration is owner-only. Project reads and copies
require read access; a copy is a new project owned by the caller. Canonical
document, revision, upload, and artifact mutations require owner or editor
access. Deleting a project also removes its member, invitation, and invitation
rate-limit state.

The Worker authenticates the ADR-012 opaque session and is the only caller of
the per-project Durable Object binding. It replaces, rather than forwards,
caller-controlled identity and role headers. The room requires that trusted
role on both WebSocket upgrades and HTTP snapshot fallback. A non-owner's D1
membership is rechecked before every document write and before edit-lease
acquisition or renewal, so revocation takes effect without waiting for a new
connection.

The room persists the latest canonical document, bounded prior snapshots, and
the active edit leases through Durable Object storage. D1 membership is not
copied into room storage: two durable authorization sources could disagree
after role change or revocation. Live presence is connection state and is not
durable membership. The existing SQLite-backed Durable Object class and
migration already cover this storage, so this decision needs no new Durable
Object migration.

One editing account may hold multiple per-browser leases for the project.
Each lease has its own token bound to project, user, client, and a server-time
expiry. Its TTL is 30 seconds and the client renews every 10 seconds. Releasing
or expiring one browser does not revoke another browser on that account.
Other accounts wait until all active leases expire or are released. Revoking
an editor invalidates all of that account’s leases. Each write still requires
its own matching lease on both WebSocket and HTTP fallback paths.

The stored lease retains its original fields, with an optional
`additionalLeases` array for the other browsers. Existing single-lease records
load without a migration. Document writes remain serialized in the room and
use the acknowledged common base to merge independent edits; incompatible
edits go through explicit conflict recovery. A client with a submission in
flight queues subsequent edits rather than claiming a newer base prematurely.

Cloudflare Access is not the product identity boundary. ADR-012 superseded that
part of ADR-007, so accepting an unverified `Cf-Access-Jwt-Assertion` would add
no protection and is not implemented. If Access is introduced later, its JWT
must be cryptographically validated for the configured application and issuer;
header presence alone is not authentication.

## Consequences

- Role revocation and viewer restrictions are enforced at REST, WebSocket, and
  HTTP-fallback boundaries, not only in the UI.
- The browser still blocks mutating tools centrally and presents viewers as
  read-only, but server enforcement remains authoritative.
- Abruptly disconnected editors may delay takeover for at most 30 seconds.
- Invitation plaintext is shown only at creation and cannot be recovered from
  D1.
- Collaboration and lease flags remain disabled in checked-in configuration;
  this implementation does not enable or deploy them.
