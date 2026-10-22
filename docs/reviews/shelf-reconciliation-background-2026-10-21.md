# L01: bounded background shelf reconciliation

Source candidate; this does not claim a deployed build or live cross-account verification.

A library refresh previously awaited every pending shelf PATCH. Serializing those writes fixes acknowledgement ordering, but a fast connection can still exceed the authenticated API's shared 120 writes/minute allowance. A queued background backlog can also delay new pin/reorder actions. The preceding correctness change is PR #813; this optimization is stacked on its exact commit.

The library now adopts account metadata locally using revision compare-and-set, protects every pending row (including rows absent from the account response), and returns without awaiting the remote backlog. Pending values are not acknowledged against a possibly stale listing while an older PATCH could still be in flight. They remain durable until a matching revision reaches the account. Retention rechecks current metadata atomically before deleting. Pending models listed by the current account are deferred while mirroring; signed-out or ineligible models expire normally after the existing 30-day window, retaining only the tiny pending organization tombstone so a later eligible account can receive the intent. Project documents and normal companion data are removed, and explicit permanent deletion still removes the tombstone too.

A lazy background cursor owns at most one queued network operation. It yields between rows and after small passes; fresh actions enter the existing queue without thousands of background jobs ahead of them. Ordinary reorders remain a single explicit batch. Waiting work rereads current pending metadata after admission and the network lock, retaining the preceding CAS/coalescing behavior.

Per-account admission uses a separate Web Lock and localStorage record shared by tabs. It grants at most one background operation at a time and records the actual request start, with at least 1 second between background starts (at most 60/minute). This avoids a burst when a request waited behind a slow operation. Pacing sleeps hold neither lock and sit outside the network queue. A 429 response pauses background work for 60 seconds across tabs; other account writes still share the server allowance. Missing coordinated storage/locks leaves intent pending rather than issuing an uncoordinated background burst; explicit actions remain available.

Each refresh captures an abortable generation and shared account marker. Logout/account replacement cancels work; storage events abort obsolete requests in other tabs. Checks after pacing waits, lock grants and metadata reads prevent old work using a new session. Acknowledgements recheck generation inside the IndexedDB transaction in addition to matching the revision. Offline and other failed requests stop until an online event or later refresh; they do not spin.

Validation is recorded in the PR: fake-time 1,000/10,000-row backlogs; cross-tab shared budget; 429 backoff; long queued-request pacing; fresh-action interleaving; latest revisions; cancellation before timers, after lock grants, before the API call and after response; unavailable storage; real IndexedDB acknowledgement/retention checks. Chromium tests open two actual tabs, hold the first PATCH while both libraries render, prove a fresh unpin goes next, verify shared pacing and cancel an in-flight request by signing out in the other tab. Existing shelf race regressions remain required.

## Discovery ownership and retention

A superseded signed-out discovery could previously purge expired model data
while a newer account discovery was deferring it. Local discovery ownership is
now separate from permission to send account writes. Purging checks that
ownership before enumeration, between rows and after awaited metadata reads
inside each delete transaction. Restored status and newer deletion dates still
win, pending organization tombstones remain, and explicit permanent deletion
keeps its existing behavior.

Real IndexedDB regressions cover supersession before purge, during metadata
reads and between rows; all three fail on the prior code. Additional controls
cover cross-tab account markers, restored/newer metadata and current signed-out
expiry without granting background network permission. Final source and hosted
qualification accompany the implementation PR.
