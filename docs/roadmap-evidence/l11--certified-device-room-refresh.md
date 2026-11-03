---
row: L11
---
An own-device MLS leaf absent from a captured account view requests a fresh
device-list check. The current directory remains unchanged and still
refuses the unknown certification. A verified changed account view retires
captured clients and reconnects the room on newly verified state; an
unchanged or refused list does not cause a reconnect loop. Concurrent
rechecks share one read. Existing pin, certificate, revocation and epoch
checks remain authoritative.

Regression coverage checks refusal and unchanged MLS epoch with a stale
directory even when its observer throws, recovery with a complete verified
directory, signed account-view advancement, concurrent refresh, and
unchanged or refused authority. The real two-browser encrypted-room journey
passes six consecutive runs and joins the browser CI selection. It checks
the automatic enrollment handoff, rendered two- and three-body results,
and a subsequent steady room edit without a duplicate account write. This is
engineering regression evidence; it does not change production activation
or outside-review status.
