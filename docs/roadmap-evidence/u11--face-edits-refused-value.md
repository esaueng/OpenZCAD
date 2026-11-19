---
row: U11
---

One command contract, stage 2 (Fillet, Chamfer, face Offset). Already in
place: the in-place Fillet and Chamfer edit one draft from the edge arrow,
its chip's keypad and Options, a History edit reopens the stored edges and
values, and the face Offset keypad says whether it takes the Offset or the
Total (the size before the edit and the move it makes). Two gaps are
closed. A kernel refusal in the in-place Fillet or Chamfer bar took the last
built preview down and did not say what to change. It now names the input
or inputs changed since the last request that built (`R: …`, `Shape: …`,
`Edges: …`), and that preview stays on screen until a value builds.
A face offset refused while its keypad takes a Total described the limit,
the remedy and Keep as an offset ("past 19 · Try a smaller offset", "Keep
−18.99 mm"). These now read as Totals ("Total can’t go below 5 mm here",
"Try a larger Total", "Keep Total 5.01 mm"). Coverage:
`useInPlaceCommand.test.tsx`, `offsetChip.test.ts` and the Chromium smoke
case `test/e2e/in-place-fillet-refused-radius.spec.ts`.
