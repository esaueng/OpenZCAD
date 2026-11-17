---
row: I04
---

STEP application-protocol slice: Settings → General → STEP protocol chooses
what File › STEP states, AP214 (the default and every earlier export) or AP242
edition 1 (`AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }`,
`ap242_managed_model_based_3d_engineering` 2014). Only the schema and the two
application-context statements change; every entity after the header is the
AP214 file's, so geometry, body names, colours and units are the same. The
preference syncs with account settings and falls back to AP214 for an unknown
value. An independent XCAF reader opens both protocols (millimetre and inch)
with the exact block and pin volumes, bounds and both body colours. Evidence:
`step-export-metadata.test.ts`, the STEP (AP242) row of
`test/exchange-round-trip.test.ts` and `docs/exchange-loss-contract.md`,
`test/app-settings.test.ts`, `SettingsPage.test.tsx` and
`exchange-units.spec.ts` (File › STEP after choosing AP242).
