---
row: U05
---

The command search remembers recent commands on this device and filters/labels commands against the current body/face/edge selection before invoking them. Rotate about axis uses the picked body. Evidence: `apps/web/src/lib/commandContext.test.ts`, `apps/web/src/lib/commandSearch.test.ts`, and `apps/web/src/components/CommandBar.test.tsx`. This is command discovery and invocation; it does not change kernel geometry contracts.
