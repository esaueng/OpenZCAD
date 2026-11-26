---
row: U12
---

Slice 1, first step: one registry of every user-reachable action (`apps/web/src/lib/actions/registry.ts`) joins the keymap's commands, the command bar's fixed rows, the App's three right-click menus (checked menu by menu), the verb rail's verbs, Draw's tools and their letter keys, and the keys the sketch clipboard and motion timeline answer, under one id per action, with the actions that have no touch path today listed as `REGULAR_TOUCH_GAPS`. `registry.test.ts` reads each source and fails when one gains an action the registry lacks or an entry outlives its source; the selection actions are exhaustive by type. Draw's tool keys moved to `lib/drawing/toolKeys.ts`. No behaviour change: dispatch moves onto the registry in later steps (PR #2165).
