---
row: U03
---

Re-check of the 13 November design review I77 and I73: a viewer's sharing
chip now says "Read-only" in words on the wide bar, where every room state
had been its glyph alone, and the share-link session chip keeps a link glyph
on a phone instead of drawing as an empty box. Also repairs two full-suite
specs whose `**/api/share/*` mocks stopped matching once the share token left
the URL (`collaboration.spec.ts`, `share-page.spec.ts`, `TopBar.test.tsx`).
