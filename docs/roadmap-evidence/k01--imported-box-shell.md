---
row: K01
---

Reversed-plane STEP shell (#1247): an independent AP214 producer's 20 x 16 x
12 box, three faces written `same_sense = .F.`, shells to the same valid 2 mm
top-open 1920 mm³ solid as the native box on Remus 2026.1.135 (fixed upstream
in the shell fold detector; no adapter workaround). SDK, adapter and STEP
round-trip regressions in `test/step-imported-box-shell.test.ts`; production
Shell command on imported and native boxes in
`test/e2e/imported-box-shell.spec.ts`.
