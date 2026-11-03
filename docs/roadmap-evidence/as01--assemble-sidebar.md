---
row: AS01
---

Assemble keeps everything in one left sidebar: parts, joints and motion, each
opening its controls under its row; the joint tool and the first run use the
same sidebar. Bodies not yet in the assembly are listed with Add, fixing a gap
where a body made after the first run could never join. Evidence:
`AssemblyPanel.test.tsx` and `test/e2e/assembly.spec.ts` (add-body regression).
