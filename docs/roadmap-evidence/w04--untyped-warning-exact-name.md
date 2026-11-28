---
row: W04
---

A warning without a typed record (a committed document keeps only the
strings) is attributed to a feature on History and Resume only when its
`Feature "<name>":` lead names that feature and no other: "Fillet 1" is not
blamed for "Fillet 10", a name two features share after a rename blames
neither, and a name that prefixes another feature's lead does not take its
warning. An ambiguous warning stays on the document-level Diagnostics list;
typed records still attribute by feature id (`featureValidation.test.ts`,
`FeatureHistoryPanel.test.tsx`, `historyResume.test.ts`).
