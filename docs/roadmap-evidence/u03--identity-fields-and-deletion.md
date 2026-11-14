---
row: U03
---

13 November design review I78 and I84 (in part): masked email fields (sign-in,
Share invite, the deletion confirmation) show what is typed while focused and
mask again on blur; the deletion field says when it doesn't match; the
deletion dialog links "Download your data first", and a server failure says
deletion may have stopped partway, that nothing on this device was deleted and
that trying again finishes it (`PersonalInfoToggle.test.tsx`,
`CloudDataDeletionDialog.test.tsx`).
