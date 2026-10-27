---
row: M08
---

Compact section toolbox with Top/Front/Side plane choices, precise bounded
position entry, Center and Flip controls, and on-demand provenance details.
Closing controls or toggling the cut restores its complete settings within
the project. Active cuts persist with the local project view and regenerate
exact curves after reopening (PR #963). Evidence: `SectionToolbox.test.tsx`,
`ViewerToolbar.test.tsx`, `useRememberedSection.test.tsx`,
`useProjectView.test.tsx`, `sectionCaps.test.ts`, `viewport.spec.ts` and
`exact-section.spec.ts`, including narrow-window bounds and exact DXF gates.
