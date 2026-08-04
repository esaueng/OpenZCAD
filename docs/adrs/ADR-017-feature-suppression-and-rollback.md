# ADR-017: Replay-compatible feature suppression and rollback

## Status

Accepted.

## Decision

Store suppression on each feature through the existing `BaseNode.metadata`
map and the replayable `node.metadata.set` command. The boolean `suppressed`
key represents an individual pause. The boolean `rollbackSuppressed` key
represents the current timeline rollback suffix. A feature is skipped when
either key is true.

The two keys remain separate so moving the rollback marker can resume its old
suffix without erasing an intentional individual pause. Moving the marker
writes every changed `rollbackSuppressed` key through one `runTransaction`
gesture. Resuming an individual row clears both keys on that row, which gives
the explicit per-feature control precedence over the current marker.

The browser exact rebuild reports every skipped feature through the normal
feature warning channel and emits no body or sketch basis for it. Downstream
unsuppressed features therefore fail visibly if they depend on a skipped
feature. OpenZCAD now has one production BrepKit build loop; the historical
legacy mesh loop named in the expansion brief no longer exists.

The compact AI digest includes each feature's effective `suppressed` state.
No schema-version bump is required because metadata and its command/replay
shape already exist.

## Consequences

- Replay, persistence, undo/redo, collaboration snapshots, and old command
  readers retain the suppression keys without learning a new command kind.
- Clients predating this ADR preserve the canonical metadata but ignore its
  build meaning, so they can temporarily project suppressed geometry. They do
  not silently delete the suppression state. Mixed-version collaboration must
  therefore require an ADR-017-capable client before relying on the projection.
- Rollback is a reversible document edit, not viewport-only visibility. It is
  one undoable transaction and one collaboration broadcast even when many
  feature metadata commands change.
- A manually suppressed source with unsuppressed dependants produces explicit
  dependant warnings. A normal rollback suppresses the whole later suffix and
  avoids those dependency failures.
