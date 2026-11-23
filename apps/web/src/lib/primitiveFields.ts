import type { PrimitiveKind } from '@openzcad/shared';

/**
 * Starting sizes for a new primitive.
 *
 * The box is the part; everything round is a feature you add to it, and the
 * defaults have to be able to say that. A round primitive is therefore sized
 * to fit inside the box's smallest footprint dimension (18) with clearance on
 * both sides, which is also the condition its booleans need: measured against
 * this box, a cylinder unions exactly up to radius 8 and facets from 9, where
 * its diameter reaches the box's depth and goes tangent to both faces. The
 * old radius 14 was a diameter of 28 against a depth of 18, so the first union
 * a new user attempted could not succeed at ANY position — the two shapes were
 * simply the wrong sizes for each other.
 *
 * Heights run past the box's 24 so a new solid protrudes rather than hiding
 * inside it: a boolean between two bodies you cannot both see is not a first
 * thing to meet.
 */
export const PRIMITIVE_FIELDS: Record<
  PrimitiveKind,
  { key: string; label: string; initial: string }[]
> = {
  // Labelled by what the dimension IS, not by the document key that carries
  // it. The keys are OCCT's makeBox(dx, dy, dz), so `depth` lands on Z — and Z
  // is up here, which made "Depth (Z)" the upright size and "Height (Y)" a
  // horizontal one, while the cylinder next door called its vertical extent
  // Height. Keys are untouched; only the human contract changes.
  box: [
    { key: 'width', label: 'Width (X)', initial: '30' },
    { key: 'height', label: 'Depth (Y)', initial: '18' },
    { key: 'depth', label: 'Height (Z)', initial: '24' }
  ],
  cylinder: [
    { key: 'radius', label: 'Radius', initial: '6' },
    { key: 'height', label: 'Height', initial: '28' }
  ],
  sphere: [{ key: 'radius', label: 'Radius', initial: '6' }],
  cone: [
    { key: 'bottomRadius', label: 'Bottom radius', initial: '6' },
    { key: 'topRadius', label: 'Top radius', initial: '2' },
    { key: 'height', label: 'Height', initial: '28' }
  ],
  torus: [
    { key: 'majorRadius', label: 'Ring radius', initial: '6' },
    { key: 'minorRadius', label: 'Tube radius', initial: '2' }
  ]
};
