---
row: U03
---
Command action slice: Done uses the on-accent text token, with compact unboxed Esc/Enter hints in the shared command and Move bars and a wrapped phone layout that keeps actions inside the viewport; `test/e2e/command-action-contrast.spec.ts` checks rendered contrast, enabled/disabled behavior, commit/cancel and action reach in light/dark at 1440/390 px with reduced motion.
The command bar publishes its measured height, so status toasts and activity feedback stay above wrapped rows, including Hole’s extra Precise values action and viewport changes (PR #966; `command-action-contrast.spec.ts`).
