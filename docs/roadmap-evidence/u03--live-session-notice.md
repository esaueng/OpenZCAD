---
row: U03
---

13 November design review I10 (edit lease) and I77: while the seat waits for
its edit lease one guidance-row notice says "Connecting to the live
session…", offers Retry after 8 s, and tool rows keep their descriptions;
"Someone else is editing this project right now" replaces the lease-holder
jargon; refusals ("Cannot …") take the warning tone; the save chip readout,
the sharing chip's room refusal and a viewer's "Read-only" label open in the
app's tooltip on hover, focus or long-press instead of a `title`
(`LiveSessionNotice.test.tsx`, `tools.test.ts`, `TopBar.test.tsx`,
`collaboration-save-refusal.spec.ts`, `save-state-history.spec.ts`).
