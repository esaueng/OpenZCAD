import { describe, expect, it } from 'vitest';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { resizeThroughHole } from '../packages/kernel-adapter/src/exact-direct-edit-ops';
import { requireThroughHole } from '../packages/kernel-adapter/src/exact-measure';

// A 40 × 30 × 10 plate with a Ø15.6 through-hole whose mouths are rounded by
// R1.5, as in a recorded session where shrinking such a hole either refused
// ("does not fit this body") or left the old fillet standing at the old
// diameter as a groove around the new, narrower bore.
const PLATE = { x: 40, y: 30, z: 10 };
const BORE = 7.8;
const FILLET = 1.5;

/** Material a mouth fillet removes from the sharp corner of a radius-r bore. */
function filletVolume(r: number, size: number): number {
  // The corner square less the quarter disc the rolling ball sweeps,
  // revolved about the bore axis (Pappus).
  const square = size * size;
  const quarter = (Math.PI * size * size) / 4;
  const quarterCentroid = r + size - (4 * size) / (3 * Math.PI);
  return 2 * Math.PI * (square * (r + size / 2) - quarter * quarterCentroid);
}

function expectedVolume(r: number, mouths: number): number {
  return (
    PLATE.x * PLATE.y * PLATE.z -
    Math.PI * r * r * PLATE.z -
    mouths * filletVolume(r, FILLET)
  );
}

function filletedPlate(kernel: RemusKernel, mouths: 1 | 2) {
  const plate = kernel.makeBox(PLATE.x, PLATE.y, PLATE.z);
  const bore = kernel.copyAndTransformSolid(
    kernel.makeCylinder(BORE, PLATE.z),
    new Float64Array([1, 0, 0, 20, 0, 1, 0, 15, 0, 0, 1, 0, 0, 0, 0, 1])
  );
  let solid = kernel.cut(plate, bore);
  for (const z of mouths === 2 ? [PLATE.z, 0] : [PLATE.z]) {
    const rim = Array.from(kernel.getSolidEdges(solid)).filter(
      (edge) =>
        new Set(kernel.getEdgeVertexHandles(edge)).size === 1 &&
        Array.from(kernel.tessellateEdge(edge, 1e-3)).every(
          (value, index) => index % 3 !== 2 || Math.abs(value - z) < 1e-6
        )
    );
    expect(rim).toHaveLength(1);
    solid = kernel.fillet(solid, Uint32Array.from(rim), FILLET);
  }
  const boreFace = Array.from(kernel.getSolidFaces(solid)).find(
    (face) => kernel.getSurfaceType(face) === 'cylinder'
  );
  expect(boreFace).toBeDefined();
  expect(kernel.volume(solid, 1e-5)).toBeCloseTo(
    expectedVolume(BORE, mouths),
    2
  );
  return { solid, boreFace: boreFace! };
}

function resize(
  kernel: RemusKernel,
  solid: number,
  face: number,
  diameter: number
) {
  // Recorded the way the gesture records it, so the source checks run too.
  const source = requireThroughHole(kernel, solid, face);
  return resizeThroughHole(
    kernel,
    solid,
    face,
    {
      kind: 'resize-through-hole',
      faceHash: 0,
      sourceDiameter: source.diameter,
      sourceAxisStart: source.axisStart,
      sourceAxisEnd: source.axisEnd,
      diameter
    },
    {}
  );
}

function surfaceCounts(kernel: RemusKernel, solid: number) {
  const counts: Record<string, number> = {};
  for (const face of kernel.getSolidFaces(solid)) {
    const type = kernel.getSurfaceType(face);
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

describe('resizing a through-hole with filleted mouths', () => {
  it.each([
    ['narrows', 1, 9],
    ['widens', 1, 18],
    ['narrows', 2, 9],
    ['widens', 2, 18]
  ] as const)(
    'keeps the fillet radius when it %s a hole with %i filleted mouth(s)',
    (_verb, mouths, diameter) => {
      const kernel = new RemusKernel();
      const { solid, boreFace } = filletedPlate(kernel, mouths);

      const resized = resize(kernel, solid, boreFace, diameter);

      expect(resized.changed).toBe(true);
      // One bore and its fillets, and no step or groove at the old diameter:
      // the box's six planes are all that remain flat.
      expect(surfaceCounts(kernel, resized.solid)).toEqual({
        plane: 6,
        cylinder: 1,
        torus: mouths
      });
      expect(kernel.volume(resized.solid, 1e-5)).toBeCloseTo(
        expectedVolume(diameter / 2, mouths),
        2
      );
    }
  );

  it('names the fillet when the new rim cannot carry it', () => {
    const kernel = new RemusKernel();
    const { solid, boreFace } = filletedPlate(kernel, 1);
    // Ø28 leaves a 1 wall to each long side, narrower than the R1.5 fillet.
    expect(() => resize(kernel, solid, boreFace, 28)).toThrow(
      'R1.5 rim fillet does not fit a Ø28 hole'
    );
  });
});
