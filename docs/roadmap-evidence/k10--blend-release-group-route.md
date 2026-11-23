---
row: K10
---

Follow-up to the CAD part QA P1 ladders on Remus 2026.1.159. Part B's
edge-round switch to one corner is the kernel group route's own limit: the
direct resize keeps all twelve rounds uniform through radius 5.88 and
re-blends only the picked corner from 5.89, the first radius at which an
independent twelve-edge Fillet history refuses. A drag release did not
follow that route. It committed the prepared journaled edit, which is the
single-band `resizeBlendJournaled`, so at every radius probed from 1.6 to
5.88 mm one corner changed while the preview and a reopened document resized
all twelve rounds (3.75 mm: 17,085.07 mm³ released against 16,288.37 mm³
replayed, on native and imported-STEP B). A blend release now rebuilds the
group route that its frames and cold replay use.
`test/prepared-resize-release.test.ts` drags B to 3.75, 5.88, 5.89 and 5.9 mm.
The last frame's closed display mesh must enclose the release's and the cold
rebuild's mesh volume within WS1's two-resolution estimate at drag quality;
unfixed, it missed by 813.7 mm³ against a 69.4 mm³ tolerance. Each release
also matches the closed form or the independent Fillet history, its band
count and a cold rebuild.
