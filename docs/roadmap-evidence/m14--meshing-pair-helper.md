---
row: M14
---

Meshing-pair helper (no schema change): Place gears in Assemble's Joints section (shown once two parts are gears) opens its placement card, which takes the gear that stays put and the one that meshes with it, shows the working centre distance, working pressure angle, calculated turns per base turn (rack: calculated travel per turn) and backlash, and Place saves an ordinary rigid joint that holds the meshed pose (a floating base is fixed first, as Set up motion does). Covers external spur and helical pairs (equal module, pressure angle and helix angle, opposite hands), herringbone pairs (opposite stored hands facing the same way, the same stored hand when one is turned end for end, since it then meets its mate with its other half; a ring pair the reverse), a pinion inside an internal gear (same hand) and a spur pinion on a rack. Placements are read the way the kernel builds them from the same values: the axis as a direction and the stored x direction with its part along the axis removed, never a substituted world direction. A gear whose x direction's remainder off the axis is under 1e-6 of its length, where rounding alone decides the tooth phase, is refused as `gear-mesh:invalid-placement` (re-pick its reference direction), even where the kernel would build it. The centre distance is the working one with profile shift (ISO 21771 `inv α_wt = inv α_t + 2 tan α_n Σx / Σz`, internal pairs by `x₂ − x₁` over `z₂ − z₁`; a pinion stands `r + x·m` off the rack's pitch line); backlash is the gears' own tooth thinning, so the centres stay at the zero-backlash distance and the play is split either side of each tooth. The tooth phase follows the kernel's tooth placement (tooth 0 on the x direction turned by phase, helical teeth turning `h·tan β / r` by height, rack teeth at `(k + ½)·p`) with mid-face planes level. Refused by code (`gear-mesh:*`): bevel and worm pairs (intersecting or crossed axes, not placed yet), two racks, two internal gears, a rack with an internal or helical gear, mismatched module, pressure angle or helix angle, same-hand external or opposite-hand internal helical pairs, herringbone with single helix, a ring with no more teeth than its pinion, shifts that leave no working pressure angle, tips that would reach past the mate's root circle at the working distance (`gear-mesh:tip-clearance`, from the addendum, dedendum and shift, its overlap shown in the document's length unit; the kernel does not shorten tips; involute/trochoid interference below the base circle is not checked), teeth cut into a cylinder, a gear moved after it was made, and parts that are not gears. Gear-ratio coupling between joints and partial-span teeth remain. Evidence: `test/gear-mesh.test.ts` (in the CI unit smoke selection; exact centre distances and working pressure angles for standard, shifted, helical, internal and rack pairs; phase interleaving at arbitrary phases, hands and orientations; herringbone and single-helix hand rules with the axis turned end for end; tip-clearance refusals for external, internal and rack pairs; every refusal code; document resolution in inch units and the moved-gear refusal; the saved joint landing the wheel at the helper's frame (also with a non-unit stored axis) and holding it fixed against attempted independent rotation; tip and root circles equal to the kernel's reported diameters; placement frames following the kernel's projection, an x direction stored 1e-5 off the axis phased against the kernel's own teeth, and an ill-conditioned tilted placement the kernel builds refused on the reader, pair and joint paths; a rack pair on the kernel), `test/gear-mesh-kernel.test.ts` (full suite: on the exact kernel, grids of points across the pitch point showing spur, helical, internal and end-for-end single-helix and herringbone pairs (both halves sampled) built where the helper puts them never overlap, while a turn past the play, half a pitch or the wrong hand does), `apps/web/src/components/assembly/GearMeshCard.test.tsx` (smoke selection; refusals shown with the document unit) and `test/e2e/gear-mesh.spec.ts` (Place gears opens the card at 60 mm with 0.2 mm play, Place fixes the pinion and adds Gear placement, one undo removes it).

Approved placement-only slice (PR #1373): the pair is rigid, with no motion
values or limits. The card explicitly says linked rotation is unavailable;
ratio/travel readouts are calculated values. Place gears lives in Joints,
and selecting exactly two gear parts offers Place selected gears with that
pair preselected (first selected as base unless one is fixed). Ctrl/Command
click adds or removes parts in the list or viewport without starting a drag;
all selected parts remain highlighted, and only the active part opens its
details. Selection is transient, with no schema change. Gear-ratio coupling
remains deferred. Regression coverage includes rigid solver overrides,
selected/non-gear/third-part/deselection cases, viewport modifiers, and both
Joints-entry and selected-pair browser journeys.

Queue integration with U11: the combined entry bundle reproduced the required
Cloudflare build failure at 1,050,503 bytes against the unchanged 1,048,576-byte
budget. The assembly sidebar is now its own chunk. It starts loading when the
pointer or keyboard focus reaches the Assemble switch, or on entry; until it
arrives a sidebar-shaped Assembly panel says it is loading (the workspace's
one-time reveal does not cover a load after the project opened), and a chunk
that cannot load reports through the stale-chunk notice. An E2E regression
holds the chunk after Build is visible, sees the load start on hover, the
loading panel on entering Assemble, and the sidebar once it arrives
(`gear-mesh.spec.ts`; `TopBar.test.tsx`, `AssemblyPanelPending.test.tsx`). With the loading
panel and preload, the production build's entry is 1,015,791 bytes (32,785
bytes below the same limit). The gear browser
regression verifies no sidebar request in Build, one when opening Assemble,
and no second request after returning through Build. Gear placement, selection,
BOM and motion behavior are preserved; the exact geometry and joint code are
unchanged by this load-boundary fix.
