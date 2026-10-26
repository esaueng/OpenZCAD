---
row: I04
---
Visible-body export slice (ZC-199, PR #947): STEP and all mesh formats export
current visible result bodies only. Local Hide/Isolate and parameter-off bodies
are excluded, hidden selections cannot override visibility, and the mesh dialog
has no include-hidden override. Visible selected bodies retain per-body export.
All-hidden models direct users to show a body before exporting, including when
on/off parameters hide every result. Scope labels count parameter-off bodies as
hidden omissions. Evidence:
`lib/exportScope.test.ts`, `TopBar.test.tsx`, `ExportDialog.test.tsx`, and
`visible-body-export.spec.ts` cover scope, empty exports, actual
STEP/3MF/STL/OBJ/GLB/PLY round-trips, consumed source exclusion,
hide/show/isolate and reload. Initial local full web suite: 4,405 passed; CAD
parity: 220 passed, one skipped. Review follow-up: 81 focused web tests and the
complete browser export regression passed. Production acceptance is recorded
after deployment.
