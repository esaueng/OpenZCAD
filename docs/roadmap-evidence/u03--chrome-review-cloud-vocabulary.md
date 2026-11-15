---
row: U03
---

Design review 13 November I8: one vocabulary for the signed-out and
cloud-unavailable states. When sign-in cannot be reached the start footer
says "Cloud unavailable" with Retry (not a Sign in that leads to an
unreachable sign-in), the top bar's account chip and Settings › Account say
"Cloud unavailable" too, and the Settings header no longer says "Beta sign-in
unavailable". Signed out, Settings › Saving's cloud group says "Applies after
sign-in" and preference synchronization says it starts after sign-in; the
File menu's Archive local sources is disabled with "Sign in to archive
imports" and raises no amber dot. A signed-out question tells the asker why
and that it is back in the prompt line. A server error on save reads "Not
synced" instead of "Offline", and the status bar says "Saved" where the top
bar does (`workspaceSaveStatePresentation.test.ts`,
`AssistantPanel.test.tsx`, `test/e2e/collaboration.spec.ts` "explains beta
auth…").
