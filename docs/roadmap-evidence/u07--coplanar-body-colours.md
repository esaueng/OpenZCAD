---
row: U07
---
Coincident opaque planar faces use persistent body identity to choose stable
display depth priorities, restricted to the competing planes. The extra bias
changes clip-space depth only: model coordinates, bounds, topology, raycasts
and shadow geometry stay unchanged. Unrelated faces retain their normal depth
and translucent/X-ray passes disable the bias. Plane/footprint indexing and
coalesced mesh-only plane spans avoid a triangle-pair scan for dense references.
`coplanarBodies.test.ts` covers partial/exact overlap, insertion order, contact,
curved-face refusal, transparency, retained geometry, a real thin gap, and two
20,000-triangle planar references. `coplanar-bodies.spec.ts` samples the shared
face while rocking the camera, then checks hide/show, reload and a 0.02 mm gap;
its tagged overlap case runs in smoke CI. The pixel regression fails against
unchanged main and passes on the fix with the production renderer. Connected
Chrome repeats the camera rocking without colour interference. Production
verification remains separate from local and pull-request checks.
