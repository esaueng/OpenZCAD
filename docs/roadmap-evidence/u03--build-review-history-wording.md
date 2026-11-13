---
row: U03
---

13 November design review, History wording (I26, I27 and a I34 toast):
Delete now states what it does to the features that build on the deleted
one in the same terms Suppress uses ("They stay in History, and any that
cannot rebuild without it shows an error"), where it used to say they "will
rebuild without it" while Suppress said they "cannot rebuild without it". A
refused reorder names the feature whose result the move would run before
(`"Hole" uses Box 1 as "Fillet" leaves it, so it must stay after "Fillet"`)
instead of claiming the body does not exist yet, and Resume full history
mentions hand-suppressed features only when there are some. Coverage:
`DeleteFeatureDialog.test.tsx`, `test/feature-reorder.test.ts`,
`historyResume.test.ts`.
