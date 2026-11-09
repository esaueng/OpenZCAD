---
row: L01
---
Derived rebuild caches still persist on the device without marking canonical
edits dirty or changing settled storage status. Cloud autosave deduplicates
canonical content pending, queued, in flight or acknowledged, while preserving
newer edits and version fences. Regression coverage:
`useLocalProjectAutosaveSchedule.test.tsx`, `localProjectAutosave.test.ts` and
`test/cloud-project-autosave.test.ts` cover preview/cancel, immediate canonical
writes, stable derived refreshes and serialized newer uploads. The intentional
Checking label for exact validation is unchanged. Production and cross-device
acceptance remain separate.
