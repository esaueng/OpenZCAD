---
row: L07
---
Real shallow Git-history fixtures complement the fleet setup deadline regression:
cold and partly warm checkouts retain a distinct candidate HEAD, prepare both
immutable snapshots through the existing single main-history transfer, and work
offline once prepared. Missing comparison data and fetched off-main active or
comparison pins fail closed. Comparison provenance uses the same immutable pin
definition as the queue-policy oracle. Worktree edits cannot replace pinned bytes,
including a policy larger than 128 KiB. Active workflows, pins, routing assertions
and existing test/setup/job deadlines are unchanged.
