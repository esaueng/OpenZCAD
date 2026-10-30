---
row: M05
---
Imported torus blends are editable and removable: Remus reports a torus's
centre and radii but not its axis, so every imported torus round lacked the
carrier that Edit/Remove Fillet need; the adapter now reads the axis off the
surface. New body-wide `remove-blends` direct edit ("Remove All Fillets" on an
imported round's rail) removes every analytic round in one replayable step,
each found again by its exact carrier and refused whole if one is missing
(`test/imported-torus-blend-edit.test.ts`, closed-form volumes, upright and
tilted).
