---
row: L07
---
Real shallow Git-history fixtures complement the fleet setup deadline regression:
cold and partly warm checkouts retain a distinct candidate HEAD, prepare both
immutable snapshots through a single bounded main-history transfer, and work
offline once prepared. Missing comparison data and fetched off-main active or
comparison pins fail closed. Comparison provenance uses the same immutable pin
definition as the queue-policy oracle. Worktree edits cannot replace pinned bytes,
including a policy larger than 128 KiB. Active workflows, pins, routing assertions
and existing test/setup/job deadlines are unchanged.
The direct preflight entrypoint also prepares both absent snapshots and their main
ancestry in one transfer before Vitest setup, with a real cold-checkout regression.

The main-history cutoff precedes both reviewed fixture pins and is an acquisition
hint only. Neither a cached snapshot nor the cutoff authorizes a pin: complete
immutable reads and actual main-ancestry checks still determine provenance.
Cold setup excludes an unrelated older asset, without filtering or truncating
workflow blobs. A synthetic candidate HEAD may stay shallow after main is ready;
prepared setup remains offline in that case. These cases cover the cold standalone
preflight and the unchanged ten-second setup hook without downloading all earlier
repository history. UTC `Z` timestamps remain compatible with Python 3.9.
