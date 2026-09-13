import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  listFeaturesInOrder,
  patternBody,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import type {
  BodyId,
  DerivedState,
  FaceTopology,
  ProjectDocument
} from '@openzcad/shared';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { faceWitnessOf } from '../packages/kernel-adapter/src/exact-witnesses';
import { topologyHashOfWitness } from '../packages/kernel-adapter/src/topology-lineage';

/**
 * A pattern used to copy its target with `copyAndTransformSolid` and hand the
 * copies on with NO lineage at all, so every instance face was hash-only: a
 * sketch pinned to the third boss in a row died the moment anything upstream
 * perturbed its fingerprint, and there was no way to say WHICH instance a
 * face belonged to.
 *
 * The feature now drives the kernel's own `linearPattern` / `circularPattern`
 * / `gridPattern`, and an instance face inherits its source face's name with
 * the instance ordinal in front of it. These pin the names, the entry points
 * actually being called, the arrangement the kernel refuses, and the reason
 * the whole thing exists: a reference on one instance surviving a count
 * change.
 */

let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);

afterAll(() => {
  adapter.dispose();
});

const user = toUserId('user_pattern_lineage');
const CUBE = 10;

function facesOf(derived: DerivedState, bodyId: BodyId): FaceTopology[] {
  const body = derived.bodyRepresentations[bodyId];
  expect(body, 'pattern body').toBeDefined();
  return body!.topology!.faces;
}

/** A 10 mm cube patterned along +x, far enough apart to stay disjoint. */
function row(
  count: number,
  spacing = 30
): { document: ProjectDocument; patternId: BodyId } {
  let document = addPrimitiveFeature(
    createProjectDocument('Pattern lineage', user),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: CUBE, height: CUBE, depth: CUBE }
    }
  );
  const targetBodyId = document.bodyOrder.at(-1)!;
  document = patternBody(document, {
    name: 'Row',
    patternKind: 'linear',
    targetBodyId,
    axis: 'x',
    count,
    spacing
  }).document;
  return { document, patternId: document.bodyOrder.at(-1)! };
}

/** The face whose plane normal and signed offset match, per instance. */
function planarFace(
  faces: readonly FaceTopology[],
  normal: { x: number; y: number; z: number },
  offset: number
): FaceTopology | undefined {
  return faces.find((face) => {
    const n = face.geometry?.normal;
    const c = face.geometry?.center;
    if (face.geometry?.surfaceType !== 'plane' || !n || !c) {
      return false;
    }
    return (
      Math.abs(n.x - normal.x) < 1e-6 &&
      Math.abs(n.y - normal.y) < 1e-6 &&
      Math.abs(n.z - normal.z) < 1e-6 &&
      Math.abs(c.x * normal.x + c.y * normal.y + c.z * normal.z - offset) < 1e-6
    );
  });
}

describe('pattern instance lineage', { timeout: 120_000 }, () => {
  it('names every face of every instance after its source face', async () => {
    const { document, patternId } = row(3);
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const faces = facesOf(derived, patternId);
    expect(faces).toHaveLength(18);
    // Nothing is left hash-only, and no two faces share a name.
    const names = faces.map((face) => face.reference?.lineageName);
    expect(names.filter((name) => name === undefined)).toEqual([]);
    expect(new Set(names).size).toBe(18);
    for (const face of faces) {
      expect(face.reference?.currentHash).toBe(face.hash);
    }
    // The instance is IN the name, so the second block's top face is
    // distinguishable from the first's rather than merely differently hashed.
    for (const instance of [0, 1, 2]) {
      const top = planarFace(
        faces.filter((face) =>
          face.reference?.lineageName.startsWith(
            `pattern.face.instance.${instance}.`
          )
        ),
        { x: 0, y: 0, z: 1 },
        CUBE
      );
      expect(top?.reference?.lineageName).toBe(
        `pattern.face.instance.${instance}.primitive.box.face.z-max`
      );
      expect(top?.geometry?.center.x).toBeCloseTo(CUBE / 2 + 30 * instance, 9);
    }
  });

  /**
   * The adoption itself. Without this the names above could just as well come
   * from the copy-and-transform path they replaced, and the kernel history
   * this feature exists to consume would never be read.
   */
  it('builds the row through the kernel pattern entry point', async () => {
    const journaled = vi.spyOn(RemusKernel.prototype, 'linearPatternJournaled');
    try {
      const { document } = row(3);
      await adapter.syncDocument(document);
      expect(journaled).toHaveBeenCalledTimes(1);
      const [solid, dx, dy, dz, spacing, count] = journaled.mock.calls[0]!;
      expect(typeof solid).toBe('number');
      expect([dx, dy, dz]).toEqual([1, 0, 0]);
      expect(spacing).toBe(30);
      expect(count).toBe(3);
    } finally {
      journaled.mockRestore();
    }
  });

  it('drives circular and grid patterns through the kernel too', async () => {
    const circular = vi.spyOn(RemusKernel.prototype, 'circularPattern');
    const grid = vi.spyOn(RemusKernel.prototype, 'gridPattern');
    try {
      let document = addPrimitiveFeature(createProjectDocument('Ring', user), {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: CUBE, height: CUBE, depth: CUBE }
      });
      const targetBodyId = document.bodyOrder.at(-1)!;
      document = patternBody(document, {
        name: 'Ring',
        patternKind: 'circular',
        targetBodyId,
        axis: 'z',
        count: 4,
        angleDeg: 360
      }).document;
      const ring = await adapter.syncDocument(document);
      expect(ring.warnings).toEqual([]);
      // Right-handed about +z, so instance 1 of four is a quarter turn CCW:
      // the block's +y face swings round to face -x.
      const ringFaces = facesOf(ring, document.bodyOrder.at(-1)!);
      expect(
        planarFace(
          ringFaces.filter((face) =>
            face.reference?.lineageName.startsWith('pattern.face.instance.1.')
          ),
          { x: -1, y: 0, z: 0 },
          CUBE
        )?.reference?.lineageName
      ).toBe('pattern.face.instance.1.primitive.box.face.y-max');
      expect(circular).toHaveBeenCalledWith(expect.any(Number), 0, 0, 1, 4);

      let gridDocument = addPrimitiveFeature(
        createProjectDocument('Grid', user),
        {
          name: 'Block',
          primitiveKind: 'box',
          dimensions: { width: CUBE, height: CUBE, depth: CUBE }
        }
      );
      const gridTarget = gridDocument.bodyOrder.at(-1)!;
      gridDocument = patternBody(gridDocument, {
        name: 'Field',
        patternKind: 'grid',
        targetBodyId: gridTarget,
        axis: 'x',
        axis2: 'y',
        count: 3,
        count2: 2,
        spacing: 30,
        spacing2: 40
      }).document;
      const field = await adapter.syncDocument(gridDocument);
      expect(field.warnings).toEqual([]);
      expect(grid).toHaveBeenCalledWith(
        expect.any(Number),
        1,
        0,
        0,
        0,
        1,
        0,
        30,
        40,
        3,
        2
      );
      // A grid instance is named by its column and row, so neither count can
      // renumber the other axis's instances.
      const gridFaces = facesOf(field, gridDocument.bodyOrder.at(-1)!);
      expect(gridFaces).toHaveLength(36);
      const cell = planarFace(
        gridFaces.filter((face) =>
          face.reference?.lineageName.startsWith('pattern.face.instance.2-1.')
        ),
        { x: 0, y: 0, z: 1 },
        CUBE
      );
      expect(cell?.reference?.lineageName).toBe(
        'pattern.face.instance.2-1.primitive.box.face.z-max'
      );
      expect(cell?.geometry?.center.x).toBeCloseTo(CUBE / 2 + 60, 9);
      expect(cell?.geometry?.center.y).toBeCloseTo(CUBE / 2 + 40, 9);
    } finally {
      circular.mockRestore();
      grid.mockRestore();
    }
  });

  /**
   * The whole point. A sketch pinned to the third instance has to still find
   * that instance when the count changes, which a hash-only face cannot do:
   * the count change rebuilds the pattern from scratch and every handle and
   * hash downstream of it is new.
   */
  it('keeps a sketch on the third instance through a count change', async () => {
    const { document, patternId } = row(4);
    const derived = await adapter.syncDocument(document);
    const faces = facesOf(derived, patternId);
    const top = planarFace(
      faces.filter((face) =>
        face.reference?.lineageName.startsWith('pattern.face.instance.2.')
      ),
      { x: 0, y: 0, z: 1 },
      CUBE
    )!;
    const geometry = top.geometry!;
    const { document: withSketch, sketchId } = addSketchFeature(
      { ...document, derived },
      {
        name: 'On the third block',
        planeRef: {
          type: 'face',
          bodyId: patternId,
          faceHash: top.hash,
          faceReference:
            top.reference?.kind === 'face' ? top.reference : undefined,
          sourceArea: geometry.area,
          sourceCenter: geometry.center,
          sourceNormal: geometry.normal!,
          frame: {
            origin: geometry.centroid ?? geometry.center,
            xAxis: { x: 1, y: 0, z: 0 },
            yAxis: { x: 0, y: 1, z: 0 },
            zAxis: geometry.normal!
          }
        },
        objects: [{ objectKind: 'circle', radius: 2, centerX: 0, centerY: 0 }]
      }
    );
    const { document: pinned, bodyId: pinId } = extrudeSketch(withSketch, {
      name: 'Pin',
      sketchId,
      distance: 3
    });
    const built = await adapter.syncDocument(pinned);
    expect(built.warnings).toEqual([]);
    expect(built.bodyRepresentations[pinId]).toBeDefined();
    const seated = built.bodyRepresentations[pinId]!.bbox;
    expect(seated.min.z).toBeCloseTo(CUBE, 6);

    // Six instances instead of four. Instance 2 has not moved — a linear
    // pattern grows at the end — so a reference that resolves by NAME finds
    // the same block, and the pin stays on top of it.
    const pattern = listFeaturesInOrder(pinned).find(
      (feature) => feature.name === 'Row'
    )!;
    const grown = updateFeature(pinned, {
      featureId: pattern.featureId,
      data: { count: 6 }
    });
    const rebuilt = await adapter.syncDocument(grown);
    expect(rebuilt.warnings).toEqual([]);
    expect(facesOf(rebuilt, patternId)).toHaveLength(36);
    const movedPin = rebuilt.bodyRepresentations[pinId];
    expect(movedPin).toBeDefined();
    expect(movedPin!.bbox.min.z).toBeCloseTo(CUBE, 6);
    // Still the third block, not the first: x is the instance's own.
    expect(movedPin!.bbox.min.x).toBeCloseTo(CUBE / 2 + 60 - 2, 6);
  });

  /**
   * The gated case. The kernel's pattern operations refuse an arrangement
   * whose instances interpenetrate — "exact instance fusing with face
   * evolution is not yet supported" — so an overlapping pattern keeps the
   * copy-and-fuse build that has always produced it. The fuse rewrites the
   * topology and reports no output relation, so those faces are hash-only and
   * SAY so rather than going quiet.
   */
  it('falls back to copy-and-fuse where instances overlap, hash-only', async () => {
    const journaled = vi.spyOn(RemusKernel.prototype, 'linearPatternJournaled');
    try {
      const { document, patternId } = row(2, CUBE / 2);
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      expect(journaled).not.toHaveBeenCalled();
      // One fused block, 1.5 cubes long.
      const body = derived.bodyRepresentations[patternId]!;
      expect(body.volume).toBeCloseTo(1.5 * CUBE ** 3, 6);
      expect(facesOf(derived, patternId)).toHaveLength(6);
      expect(
        facesOf(derived, patternId).filter((face) => face.reference)
      ).toEqual([]);
      expect(
        body.topology?.lineageDiagnostics?.some((diagnostic) =>
          diagnostic.message.includes('fused into one solid')
        )
      ).toBe(true);
    } finally {
      journaled.mockRestore();
    }
  });

  /**
   * A partial sweep has no kernel entry point — `circularPattern` always
   * closes the ring — so it keeps the copy-and-transform build. The instances
   * are still rigid copies under a known transform, so the lineage is derived
   * by the same check and the product loses no capability.
   */
  it('still patterns a partial sweep, named, without the kernel ring', async () => {
    const circular = vi.spyOn(RemusKernel.prototype, 'circularPattern');
    try {
      let document = addPrimitiveFeature(createProjectDocument('Fan', user), {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: CUBE, height: CUBE, depth: CUBE }
      });
      const targetBodyId = document.bodyOrder.at(-1)!;
      // Seated well off the axis so three copies 45 degrees apart stay clear
      // of one another; the partial sweep, not the overlap path, is the
      // subject here.
      document = transformBody(document, {
        name: 'Seat it off the axis',
        targetBodyId,
        translation: { x: 60, y: 0, z: 0 }
      }).document;
      document = patternBody(document, {
        name: 'Quarter fan',
        patternKind: 'circular',
        targetBodyId,
        axis: 'z',
        count: 3,
        angleDeg: 90
      }).document;
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      expect(circular).not.toHaveBeenCalled();
      const faces = facesOf(derived, document.bodyOrder.at(-1)!);
      expect(faces).toHaveLength(18);
      expect(faces.filter((face) => face.reference === undefined)).toHaveLength(
        0
      );
      expect(
        faces.some(
          (face) =>
            face.reference?.lineageName ===
            'pattern.face.instance.2.primitive.box.face.z-max'
        )
      ).toBe(true);
    } finally {
      circular.mockRestore();
    }
  });
});

/**
 * The witness the adoption is held to: the kernel's own pattern has to put the
 * copies exactly where the copy-and-transform path put them. Compared on raw
 * handles rather than through the adapter so nothing downstream can absorb a
 * difference.
 */
describe('kernel pattern against copy-and-transform', () => {
  const boxOf = (kernel: RemusKernel, solid: number) =>
    Array.from<number>(kernel.boundingBox(solid));

  /**
   * The ADR-011 fingerprints of a solid's faces. Equality here is the bar that
   * actually matters for documents written before this change: a stored
   * hash-only reference to a pattern face resolves by fingerprint, so an
   * instance the kernel places a floating-point hair away from where
   * `copyAndTransformSolid` placed it would silently sever it.
   */
  const fingerprintsOf = (kernel: RemusKernel, solid: number) =>
    Array.from<number>(kernel.getSolidFaces(solid)).map((face) =>
      topologyHashOfWitness('face', faceWitnessOf(kernel, face))
    );

  /** Row-major, matching the adapter's own transform matrices. */
  const rowMajor = (rows: readonly (readonly number[])[]) =>
    new Float64Array([...rows[0]!, ...rows[1]!, ...rows[2]!, 0, 0, 0, 1]);

  it('agrees on every instance of a linear row', () => {
    const kernel = new RemusKernel();
    try {
      const source = kernel.makeBox(10, 10, 10);
      const patterned = Array.from<number>(
        kernel.getCompoundSolids(kernel.linearPattern(source, 1, 0, 0, 30, 4))
      );
      const copied = Array.from({ length: 4 }, (_unused, index) =>
        kernel.copyAndTransformSolid(
          source,
          rowMajor([
            [1, 0, 0, 30 * index],
            [0, 1, 0, 0],
            [0, 0, 1, 0]
          ])
        )
      );
      expect(patterned).toHaveLength(4);
      for (const [index, instance] of patterned.entries()) {
        expect(kernel.volume(instance, 0.01)).toBeCloseTo(
          kernel.volume(copied[index]!, 0.01),
          9
        );
        expect(boxOf(kernel, instance)).toEqual(boxOf(kernel, copied[index]!));
        expect(fingerprintsOf(kernel, instance)).toEqual(
          fingerprintsOf(kernel, copied[index]!)
        );
        expect(kernel.validateSolid(instance)).toBe(0);
      }
    } finally {
      kernel.free();
    }
  });

  it('agrees on every instance of a full-turn ring', () => {
    const kernel = new RemusKernel();
    try {
      // Seated off the axis so the rotation is observable.
      const source = kernel.copyAndTransformSolid(
        kernel.makeBox(4, 4, 4),
        rowMajor([
          [1, 0, 0, 20],
          [0, 1, 0, 0],
          [0, 0, 1, 0]
        ])
      );
      const patterned = Array.from<number>(
        kernel.getCompoundSolids(kernel.circularPattern(source, 0, 0, 1, 4))
      );
      expect(patterned).toHaveLength(4);
      for (const [index, instance] of patterned.entries()) {
        const angle = (index * Math.PI) / 2;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const expected = kernel.copyAndTransformSolid(
          source,
          rowMajor([
            [cos, -sin, 0, 0],
            [sin, cos, 0, 0],
            [0, 0, 1, 0]
          ])
        );
        const box = boxOf(kernel, instance);
        const reference = boxOf(kernel, expected);
        for (const [axis, value] of box.entries()) {
          expect(value).toBeCloseTo(reference[axis]!, 9);
        }
        // Not merely close: the kernel's own rotation and the Euler matrix
        // this feature used to build quantize to the SAME fingerprints, on
        // every instance of the ring including the ones off the axes.
        expect(fingerprintsOf(kernel, instance)).toEqual(
          fingerprintsOf(kernel, expected)
        );
        expect(kernel.volume(instance, 0.01)).toBeCloseTo(4 ** 3, 9);
        expect(kernel.validateSolid(instance)).toBe(0);
      }
    } finally {
      kernel.free();
    }
  });
});
