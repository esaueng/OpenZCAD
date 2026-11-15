---
row: M09
state: Partial
---

First slice, display-only: with a section cut on, bodies whose display caps
overlap inside the cut are drawn over in red (`sectionOverlap.ts` in the
viewport: the same tessellation the caps fill, clipped triangle against
triangle in the cutting plane, touching excluded), and the section toolbox,
or the "Section view on" chip where the toolbox is put away (Assemble, View),
names the pairs and their approximate overlap area and labels them "Display
evidence from the meshes on screen, not an exact clash check." The overlay
follows assembly poses, is never picked or clipped, and is cleared with the
cut. Exact body clash with witnesses, shared with AS04: `exactBodyClash` in
`packages/kernel-adapter/src/exact-body-clash.ts` answers interference
(exact intersection, or exact difference where the intersection is declined;
volume, shared box, interior point), clearance (certified distance and
closest points where certified; contact at zero) or unknown with the typed
kernel refusal, never a guessed clear. AS04 runs it on posed assembly
components. Evidence: `packages/viewport/src/scene/sectionOverlap.test.ts`,
`SectionToolbox.test.tsx` (overlap note), `exact-body-clash.test.ts`, and
`test/e2e/assembly-interference.spec.ts` (the overlay and its label in a
real cut). Clearance thresholds, draft/curvature/zebra overlays, thickness
analysis and a clash command outside Assemble remain open.
