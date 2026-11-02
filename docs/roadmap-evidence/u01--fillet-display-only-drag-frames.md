---
row: U01
---
Fillet/chamfer drag frames build blends display-only (kernel
`setDisplayOnlyBlends`, esaueng/remus#1477), with salted history digests
so a checked sync never restores a frame's blend: the six-edge Tiny Wombat
fillet drops from about 1.7 s to about 140 ms a frame; rest checks and
commits stay fully checked (`display-only-blend-preview.test.ts`, PR #1147).
