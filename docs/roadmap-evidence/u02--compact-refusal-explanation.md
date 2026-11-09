---
row: U02
---

The compact refusal in the guidance row opens its Why? explanation instead of
clipping it: the row no longer hides overflow while it carries a notice.
`WorkspaceReadout.test.tsx` covers repeated Why? / Escape use and pointer
isolation; `viewerResponsiveContracts.test.ts` pins the overflow rule. The
`@ci-smoke` journey in `direct-edit-ownership.spec.ts` checks the explanation
is clickable at desktop and compact widths, that Escape closes it before it
clears the selection, and that the top bar keeps its Edit not applied link to
the activity log after deselection.
