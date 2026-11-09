---
row: U01
---

Held face pulls close the opaque body with a section of the live display mesh
at the keep plane, rather than the inset old face. Moving bounding rounds no
longer leave an uncapped band around that face. Cap construction is cached by
geometry, position/index versions and placement; an empty or failed section
leaves the live body solid. The original face's neutral ghost remains at its
old position. `packages/viewport/src/gizmo/bodyGhost.test.ts` covers Front and
Top pulls of a 24 × 16 rounded box (r4.4, +14), whose cap measures 367.27 mm²
against the old face's 109.44 mm², plus prismatic caps, buffer-version reuse,
interleaved positions, geometry replacement, transformed bodies, failure
recovery and disposal. This is local geometry/regression evidence; browser
appearance and native desktop behavior were not reverified in this slice.
