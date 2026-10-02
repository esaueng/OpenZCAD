import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  getLatestBodyId
} from '@openzcad/document-core';
import { parseStl } from '@openzcad/io-stl';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import { tightenBoundsToMesh } from '../packages/kernel-adapter/src/exact-bounds';

/**
 * Production QA CAD-02: an Intersect whose geometry is 4.14 × 6.18 × 12 mm
 * showed 30 × 30 × 12 mm in the Inspector and the selection chip — the whole
 * cylinder it was cut from. Both read the body's published box; the pinned
 * kernel boxes a partial cylinder face as a full circle.
 *
 * These compare the published box against the geometry itself, read back
 * independently from the exported STL — not against another consumer of the
 * same cached box.
 */

let kernel: ExactKernelAdapter;

beforeAll(async () => {
  kernel = await createExactKernelAdapter();
});

afterAll(() => {
  kernel.dispose();
});

/** QA's case: a Ø30 × 12 cylinder at the origin ∩ a 20 mm cube at (10, 5, −4). */
function intersection() {
  const manager = new CommandManager(
    createProjectDocument('Intersect', toUserId('user_intersect'))
  );
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Cylinder Body',
      primitiveKind: 'cylinder',
      dimensions: { radius: 15, height: 12 }
    })
  );
  const cylinder = getLatestBodyId(manager.document)!;
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Box Body',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 20 }
    })
  );
  const box = getLatestBodyId(manager.document)!;
  manager.execute(
    commandFactories.transformBody({
      name: 'Move box',
      targetBodyId: box,
      translation: { x: 10, y: 5, z: -4 }
    })
  );
  manager.execute(
    commandFactories.booleanBodies({
      name: 'Intersect',
      operation: 'intersect',
      targetBodyIds: [cylinder, box]
    })
  );
  return {
    document: manager.document,
    bodyId: getLatestBodyId(manager.document)!
  };
}

/** The exact result, from the geometry: x = 15·cos(asin(5/15))… worked out. */
const EXACT = {
  min: { x: 10, y: 5, z: 0 },
  // The cube's +X/+Y corner (30, 25) is outside the r = 15 circle, so the
  // far sides are where the circle crosses y = 5 and x = 10.
  max: {
    x: Math.sqrt(15 ** 2 - 5 ** 2),
    y: Math.sqrt(15 ** 2 - 10 ** 2),
    z: 12
  }
};

describe('intersection bounds (CAD-02)', { timeout: 30_000 }, () => {
  it('publishes the intersection’s own box, the one its export shows', async () => {
    const { document, bodyId } = intersection();
    const derived = await kernel.syncDocument(document);
    const body = derived.bodyRepresentations[bodyId]!;
    expect(derived.warnings).toEqual([]);
    // The recorded volume stays what QA found correct.
    expect(body.volume).toBeCloseTo(181.578, 2);

    const stl = await kernel.exportStl(document, [bodyId], 0.01);
    const { vertices } = parseStl(
      new TextEncoder().encode(stl).buffer,
      'intersect.stl'
    );
    const exported = {
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity }
    };
    for (let index = 0; index < vertices.length; index += 3) {
      (['x', 'y', 'z'] as const).forEach((axis, offset) => {
        const value = vertices[index + offset]!;
        exported.min[axis] = Math.min(exported.min[axis], value);
        exported.max[axis] = Math.max(exported.max[axis], value);
      });
    }

    // Against the exact geometry: within the display tessellation's chord
    // error (2e-4 of the 30 mm extent the kernel reported, 0.006 mm), which
    // is far below the 0.01 mm the Inspector rounds to.
    for (const corner of ['min', 'max'] as const) {
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(
          Math.abs(body.bbox[corner][axis] - EXACT[corner][axis])
        ).toBeLessThan(0.006);
        // And against the exported file, which is tessellated independently.
        expect(
          Math.abs(body.bbox[corner][axis] - exported[corner][axis])
        ).toBeLessThan(0.006);
      }
    }
    const size = (axis: 'x' | 'y' | 'z') =>
      body.bbox.max[axis] - body.bbox.min[axis];
    expect(size('x')).toBeCloseTo(4.1421, 2);
    expect(size('y')).toBeCloseTo(6.1803, 2);
    expect(size('z')).toBeCloseTo(12, 6);
  });

  it('leaves a whole cylinder’s exact box alone', async () => {
    const manager = new CommandManager(
      createProjectDocument('Whole', toUserId('user_intersect'))
    );
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 15, height: 12 }
      })
    );
    const bodyId = getLatestBodyId(manager.document)!;
    const body = (await kernel.syncDocument(manager.document))
      .bodyRepresentations[bodyId]!;
    // The mesh's widest chord falls short of the circle; the kernel's ±15 is
    // the truth and must survive.
    expect(body.bbox.min).toEqual({ x: -15, y: -15, z: 0 });
    expect(body.bbox.max).toEqual({ x: 15, y: 15, z: 12 });
  });
});

describe('tightenBoundsToMesh', () => {
  const square = [0, 0, 0, 4, 0, 0, 4, 6, 0, 0, 6, 12];

  it('pulls in a side the mesh proves loose', () => {
    expect(
      tightenBoundsToMesh([-15, -15, 0, 15, 15, 12], square, 0.01)
    ).toEqual([0, 0, 0, 4, 6, 12]);
  });

  it('keeps a side within the chord deflection of the mesh', () => {
    // A circle's true extreme sits up to one deflection past its chords.
    expect(
      tightenBoundsToMesh([-0.005, 0, 0, 4.005, 6, 12], square, 0.01)
    ).toEqual([-0.005, 0, 0, 4.005, 6, 12]);
  });

  it('never grows the kernel’s box', () => {
    expect(tightenBoundsToMesh([1, 1, 1, 2, 2, 2], square, 0.01)).toEqual([
      1, 1, 1, 2, 2, 2
    ]);
  });

  it('leaves the box alone with no mesh to judge it by', () => {
    expect(tightenBoundsToMesh([-15, -15, 0, 15, 15, 12], [], 0.01)).toEqual([
      -15, -15, 0, 15, 15, 12
    ]);
  });
});
