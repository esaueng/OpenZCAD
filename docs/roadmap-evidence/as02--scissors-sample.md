---
row: AS02
---

The shared sample catalogue includes the supplied
`Scissors-Revolute-Pivot-Assembly.openzcad` as an editable Scissors project.
The bundled template retains its sketches, features, body colours, three
components, grounding and revolute joint: −30° initially, limited to −55°–0°.
It needs no account or remote source assets and loads only when opened.
Each device seeds its own project with the current user's ownership; reopening
uses that edited copy, and the existing reset action restores the template.

The supplied backup has no stored design revisions. The sample promises no
A/B/C walkthrough and stores a checkpoint of the complete assembly instead.
Exported owner/project identity, undo snapshots and derived meshes are omitted
from the template; geometry is rebuilt through the ordinary exact-kernel path.

Acceptance: rebuild three exact solids without warnings; preserve editable
features and the joint's values, limits and grounding; isolate separate seeds;
open the catalogue entry, change the angle and retain it after reload.
`test/scissors-demo.test.ts` checks the exact rebuild, component grounding,
joint state, stored checkpoint and independent seeds. It runs in the CI unit
smoke selection. `StartScreen.test.tsx` checks the signed-out catalogue entry;
the existing demo parity harness also checks all three solids for watertight
meshes, replayed volumes and recorded exact face counts.

Local production-preview Chromium checks at 1440 × 1000 and 390 × 844 confirm
the catalogue opens while signed out. In Assemble, changing −30° to −45° turns
the moving blade, and reload retains −45°, three parts and zero warnings.
The browser console reports no errors or warnings. Source comparison confirms
the geometry nodes, commands and assembly match the supplied backup.
This is local verification; merge and production availability remain separate.
No schema, dependency or deployment changes are required.
