---
row: M07
---

QA 2026-11-14 finding #9, owner decision: the face-offset chip and its typed
field start on Offset, the signed distance the face moves (+ out, − in), on
every face, so a typed 5 on a 24 mm body's top face moves it +5 instead of
−19. Total, the size the face sets, stays one switch away on the chip's tag
wherever a span is known, keeps its baseline and meaning line, and stays
with the face it was chosen on, through that face's own commit; any other
face, even one facing the same way, starts on Offset again. Stored feature
values are unchanged (`offsetChip.test.ts`, `opposingPlaneSpan.test.tsx`,
`prompt.test.ts`, `face-offset-total.spec.ts`, `shoulder-cap-offset.spec.ts`).
