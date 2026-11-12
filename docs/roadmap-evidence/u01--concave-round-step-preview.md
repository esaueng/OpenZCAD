---
row: U01
---
Instant push/pull preview for a planar face rounded into a taller wall: a
proven blend that rises past the face (a box top filleted into a cylinder) now
moves with it while the wall stretches, instead of declining the mesh preview
and leaving the drag to exact rebuilds alone. Curved walls ruled along the drag
are bounded by where their moving outline would cross their fixed one, so a
sliver beside the seam no longer stops the preview at 0.0004 mm. On the
filleted-union fixture the preview's volume change matches the exact offset
within 0.1 mm³ for −6 to +3.5 mm; it reaches the cylinder rim (+4 mm) and the
corner bands' floor (−21 mm). Rising planes and unrecognized surfaces still
decline (`step-preview-profile.test.ts`). A local Chromium (ANGLE/Vulkan) drag
on the 25-feature filleted union showed the proxy following every sampled
pointer step to +8 mm, where it previously stayed on exact frames only.
