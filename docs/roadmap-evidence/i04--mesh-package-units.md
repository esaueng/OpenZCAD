---
row: I04
---

Mesh packages state every file's unit: the export dialog keeps Units live whenever any packaged format uses it and names each format's unit (glTF in metres, 3MF declared, STL/OBJ/PLY not recorded), the ZIP carries a `units.txt` manifest, and a check whose measured deviation exceeds the chosen limit says so before export (`apps/web/src/components/ExportDialog.test.tsx`, `apps/web/src/lib/meshExportPackage.test.ts`, `test/e2e/exchange-units.spec.ts`; #2095, #2369, #2080).
