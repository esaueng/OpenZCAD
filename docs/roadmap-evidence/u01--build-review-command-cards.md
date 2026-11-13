---
row: U01
---

13 November design review, Build command cards (I30, I28, I32, the fillet
refusal in I10, and I34 polish): Enter on a command's bar while the preview
of the value just typed is still being checked is held and applies once it
is valid ("Applying…"), so "100 Tab 60 Tab 6 Enter Enter" makes the box; an
Enter with nothing waiting to preview is not held. Fillet and Chamfer no
longer send the user to an Options field that appears only after the first
edge, and Gear says where module and teeth are set. Thread and Gear teeth
say "Needs a cylindrical face" on a model whose live bodies have none. A
blend refused at a size another builds at drops the repeated feature name,
quotes both sizes in the document unit and offers the size that builds as
one press ("Use 6.25 mm"). The state pill stays empty until there is
something to preview, Position coordinates align with Size, a point's name
wraps instead of ending "Base cen…", Scale says "Body center", and History
names a fillet's radius "R" as its chip does. Coverage:
`InPlaceCommandBar.test.tsx`, `sizeRefusal.test.ts`, `tools.test.ts`,
`inPlace/tools.test.ts`, `featureSummary.test.ts`, and
`build-command-cards.spec.ts` in the browser.
