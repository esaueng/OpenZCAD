---
row: U06
---
Objects rows expose Isolate body and an active Exit isolation action in Build,
with the same command in the selected viewport body's context menu and command
search. Isolation uses the existing viewport/export visibility policy and
restores the prior hidden set on exit. An already-alone body starts isolation
without revealing previously hidden bodies; parameter-off bodies ask users to
turn on their visibility parameter first. Consumed source bodies have no
isolation action. Coverage: `bodyIsolation.test.ts`, `ObjectsPanel.test.tsx`,
and `objects-isolation.spec.ts` verify controls, visibility restoration and
actual isolated STEP/mesh exports.
