---
row: L01
---
Sharing popover reworked (invite first, people with access, General access
summary over the links, state code behind the Encrypted chip, removal
confirmed in place) and plaintext share links gain owner-only names: migration
0046 adds a nullable `label` (1-60 code points), `PATCH
/api/projects/:id/share-links/:linkId` renames, revoke clears it, visitor
routes never return it (`share-link-labels.test.ts`,
`ProjectSharingDialog.test.tsx`). Encrypted link names are not included; they
need a document-format change.
