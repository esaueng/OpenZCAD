---
row: L11
---
Share-link visitors now have a dedicated loading and failure page instead of
falling through to Parts. Incomplete links are recognized as share destinations
without sending a capability request or restoring an unrelated local project.
Unavailable links explain possible expiry, revocation or model removal; other
failures retain encrypted verification and owner-confirmation guidance. Retry
keeps the link, Back to parts explicitly leaves it, and a failed replacement
offers a return to the previous model. Browser regressions cover plaintext and
encrypted unavailable links, malformed fragments, reload, network retry,
cancellation, replacement races, encrypted-invitation navigation and retained
local projects. Existing encrypted
owner/visitor verification and publication contracts remain in force.
