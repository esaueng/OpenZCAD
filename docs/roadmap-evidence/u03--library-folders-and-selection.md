---
row: U03
---
Library refinement slice: a card's column no longer grows to its longest
meta line, so a recovery copy's date stopped pushing its preview past the
card (`StartScreen.tsx`, `start-screen.css`). Parts can be picked with a
check, Shift for a range, ⌘/Ctrl-click or ⌘A, and archived, trashed, pinned,
restored, destroyed or filed together from one floating bar. Folders group
parts on this device (per account, in browser storage; not yet mirrored to
the account): hold one card over another to make one, drop a card on a
folder tile, a column folder link or the Parts crumb, pin folders like
parts, rename, ungroup, and choose the cover part. An opened sample offers
reset to the original and save-a-copy. The library and Settings move to the
column-first layout (no page top bar; logo at the column head, account and
Settings at its foot). Evidence: `libraryFolders.test.ts`,
`StartScreen.test.tsx` (folders, search through folders, folder pin, range
selection and bulk trash, new folder from a selection, Escape, sample reset)
and `start-tile-reorder.spec.ts` (hold-to-merge folder that survives a
reload; shift-range bulk trash).
