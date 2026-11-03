---
row: M07
---

Rotational imported bodies retain their complete analytic profile when a bore,
outer wall or neck changes diameter. The paired Remus update adds a bounded
exact construction for coaxial plane/cylinder/cone/torus bodies with one shell,
at most 64 faces, complete circular rims and tangent torus bands. The bands
keep their minor radii while following the changed wall along fixed planar or
conical supports. Axial bore-floor travel can cross a radially separate outer
shoulder, and a planar bottom against a cone re-limits its circular boundary.
New intersections, collapsed or reversed spans, and changes requiring a different
adjacency graph still refuse. This does not qualify arbitrary freeform direct
editing or every diameter of a bounded part.

ZCAD now consumes the cylindrical edit's verified construction history instead
of dropping the persistent face references after a successful diameter change.
The existing exact validation and analytic-radius checks remain in place;
disposable previews defer reference publication. Section controls also take part
in the numeric HUD's obstacle avoidance, keeping values visible and pressable.
Keyboard focus uses the viewport color in both themes. A conical end reaching
its apex and diameter changes that collapse or overlap the profile receive
specific refusal text, with the kernel detail retained.

`rotational-direct-edits.test.ts` covers repeated bore, outer-wall and neck
changes, both cap edits, exact volume, face identity, undo/redo and fresh replay.
The public STEP fixture has anonymous test metadata and uses geometry already
covered by Remus's walking-stick-foot regression. No private project is shipped.
`rotational-direct-edits.spec.ts` exercises actual drags, cancellation, typed
entry, saved reload and downloaded STEP validity with 13 faces, 22 edges and
12 vertices. `panel-float.spec.ts` pans a face handle toward an open Section
panel and verifies the numeric value remains unobstructed and clickable.

Kernel adoption also retains the curved-support fillet repair already used by
the application. `retained-fillet-package.test.ts` imports an anonymous STEP
from Remus's public synthetic crowned-box regression, rounds the opposite rim,
and checks its unchanged rational crown and non-unit parameter interval, source
B-Rep records, closed-form removed volume and exact STEP round trip. The
published rotational-edit-only snapshot fails this case, while the combined
source preserves both delivered capabilities.
