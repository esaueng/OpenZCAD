import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  getLatestBodyId,
  getLatestSketchId
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { inspectTriangleMeshClosure } from '../packages/kernel-adapter/src/boolean-result-validation';
import {
  toUserId,
  type BodyRepresentation,
  type ParamValue,
  type ProjectDocument,
  type SketchObjectData
} from '@openzcad/shared';

/**
 * Two-sided extrude: `backDistance` extends the solid behind the sketch
 * plane, opposite the `distance` direction, so a rectangle of area `A`
 * extruded `d` forward and `b` back is a box of volume `A * (d + b)` — the
 * oracle is computed here, never read back out of the kernel. The property
 * that separates two-sided from a merely longer one-sided extrude is
 * placement: the solid must straddle the sketch plane with exactly `b` on
 * the back side, which the mesh extent along the plane normal pins below.
 *
 * Every case also checks topology, because a correct volume over a broken
 * shell is a failure mode this project has met repeatedly: one closed
 * shell, zero boundary edges, zero non-manifold edges, and `V - E + F = 2`.
 */

const PROFILE_WIDTH = 3;
const PROFILE_HEIGHT = 2;

function rectangleProfile(): SketchObjectData {
  return {
    objectKind: 'rectangle',
    width: PROFILE_WIDTH,
    height: PROFILE_HEIGHT,
    centerX: PROFILE_WIDTH / 2,
    centerY: PROFILE_HEIGHT / 2
  };
}

function boxVolume(depth: number): number {
  return PROFILE_WIDTH * PROFILE_HEIGHT * depth;
}

/** `V - E + F` over the welded display mesh, as in the partial-revolve pin. */
function eulerCharacteristic(mesh: {
  vertices: ArrayLike<number>;
  indices: ArrayLike<number>;
}): number {
  const bounds = [
    Infinity,
    Infinity,
    Infinity,
    -Infinity,
    -Infinity,
    -Infinity
  ];
  let magnitude = 0;
  for (let index = 0; index + 2 < mesh.vertices.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = mesh.vertices[index + axis]!;
      bounds[axis] = Math.min(bounds[axis]!, value);
      bounds[axis + 3] = Math.max(bounds[axis + 3]!, value);
      magnitude = Math.max(magnitude, Math.abs(value));
    }
  }
  const extent = Math.max(
    bounds[3]! - bounds[0]!,
    bounds[4]! - bounds[1]!,
    bounds[5]! - bounds[2]!,
    0
  );
  const quantum = Math.max(1e-9, extent * 1e-6, magnitude * 2 ** -22);
  const key = (index: number): string =>
    [0, 1, 2]
      .map((axis) => Math.round(mesh.vertices[index * 3 + axis]! / quantum))
      .join(',');

  const vertices = new Set<string>();
  const edges = new Set<string>();
  let faces = 0;
  for (let index = 0; index + 2 < mesh.indices.length; index += 3) {
    const corners = [
      key(mesh.indices[index]!),
      key(mesh.indices[index + 1]!),
      key(mesh.indices[index + 2]!)
    ];
    if (new Set(corners).size !== 3) {
      continue;
    }
    faces += 1;
    corners.forEach((corner) => vertices.add(corner));
    for (const [start, end] of [
      [corners[0]!, corners[1]!],
      [corners[1]!, corners[2]!],
      [corners[2]!, corners[0]!]
    ] as const) {
      edges.add(start < end ? `${start}|${end}` : `${end}|${start}`);
    }
  }
  return vertices.size - edges.size + faces;
}

function documentWithExtrude(input: {
  distance: ParamValue;
  symmetric?: boolean;
  backDistance?: ParamValue;
}): ProjectDocument {
  const sketched = addSketchFeature(
    createProjectDocument('TwoSided', toUserId('user_test')),
    { name: 'Profile', plane: 'XY', offset: 0, object: rectangleProfile() }
  ).document;
  return extrudeSketch(sketched, {
    name: 'Extrude',
    sketchId: getLatestSketchId(sketched)!,
    ...input
  }).document;
}

let kernel: ExactKernelAdapter;

beforeAll(async () => {
  kernel = await createExactKernelAdapter();
}, 120_000);

afterAll(() => {
  kernel.dispose();
});

async function buildExtrude(input: {
  distance: ParamValue;
  symmetric?: boolean;
  backDistance?: ParamValue;
}): Promise<{
  document: ProjectDocument;
  warnings: string[];
  body: BodyRepresentation | undefined;
}> {
  const document = documentWithExtrude(input);
  const derived = await kernel.syncDocument(document);
  return {
    document,
    warnings: derived.warnings,
    body: derived.bodyRepresentations[getLatestBodyId(document)!]
  };
}

function expectSoundSolid(body: BodyRepresentation): void {
  const closure = inspectTriangleMeshClosure(
    body.mesh.vertices,
    body.mesh.indices
  );
  expect(closure.boundaryEdges).toBe(0);
  expect(closure.nonManifoldEdges).toBe(0);
  expect(closure.inconsistentWindingEdges).toBe(0);
  expect(eulerCharacteristic(body.mesh)).toBe(2);
}

/**
 * The mesh's extent along the sketch-plane normal. The XY sketch at offset 0
 * makes that the world z axis, so the span pins where the solid sits
 * relative to the plane — the property `backDistance` exists to control.
 */
function normalSpan(mesh: { vertices: ArrayLike<number> }): {
  min: number;
  max: number;
} {
  let min = Infinity;
  let max = -Infinity;
  for (let index = 2; index < mesh.vertices.length; index += 3) {
    min = Math.min(min, mesh.vertices[index]!);
    max = Math.max(max, mesh.vertices[index]!);
  }
  return { min, max };
}

describe('two-sided extrude geometry', () => {
  it.each([
    [5, 2],
    [5, 5],
    [0.5, 7]
  ])(
    'extrudes %s forward and %s back to the closed-form box over one sound shell',
    async (distance, back) => {
      const { warnings, body } = await buildExtrude({
        distance,
        backDistance: back
      });
      expect(warnings).toEqual([]);
      expect(body).toBeDefined();
      expect(Math.abs(body!.volume - boxVolume(distance + back))).toBeLessThan(
        1e-9
      );
      const span = normalSpan(body!.mesh);
      // The distinguishing property: exactly `back` behind the plane and
      // `distance` in front, not a longer one-sided prism.
      expect(span.min).toBeCloseTo(-back, 9);
      expect(span.max).toBeCloseTo(distance, 9);
      expectSoundSolid(body!);
    },
    120_000
  );

  it('extends a negative distance opposite its own direction', async () => {
    const { warnings, body } = await buildExtrude({
      distance: -4,
      backDistance: 1.5
    });
    expect(warnings).toEqual([]);
    expect(Math.abs(body!.volume - boxVolume(5.5))).toBeLessThan(1e-9);
    // distance extrudes below the plane, so "back" is now above it.
    const span = normalSpan(body!.mesh);
    expect(span.min).toBeCloseTo(-4, 9);
    expect(span.max).toBeCloseTo(1.5, 9);
    expectSoundSolid(body!);
  }, 120_000);

  it('treats an absent back distance as the legacy one-sided extrude, byte-for-byte', async () => {
    const [absent, zero] = await Promise.all([
      buildExtrude({ distance: 6 }),
      buildExtrude({ distance: 6, backDistance: 0 })
    ]);
    // The stored feature keeps no backDistance at all when it was never
    // given, so a document written before this field existed cannot change
    // shape by being reopened; an explicit 0 (what the edit panel writes,
    // since updateFeature cannot delete a key) builds the same solid.
    const feature = Object.values(absent.document.nodes).find(
      (node) => node.kind === 'feature' && node.featureKind === 'extrude'
    );
    expect(
      feature?.kind === 'feature' && feature.data.featureKind === 'extrude'
        ? feature.data.backDistance
        : 'missing'
    ).toBeUndefined();
    expect(absent.body!.volume).toBe(zero.body!.volume);
    expect(absent.body!.faceCount).toBe(zero.body!.faceCount);
    expect(absent.body!.volume).toBeCloseTo(boxVolume(6), 12);
    const span = normalSpan(zero.body!.mesh);
    expect(span.min).toBeCloseTo(0, 9);
    expect(span.max).toBeCloseTo(6, 9);
  }, 120_000);

  it('matches symmetric when the split is equal', async () => {
    const [symmetric, twoSided] = await Promise.all([
      buildExtrude({ distance: 8, symmetric: true }),
      buildExtrude({ distance: 4, backDistance: 4 })
    ]);
    expect(Math.abs(symmetric.body!.volume - twoSided.body!.volume)).toBeLessThan(
      1e-9
    );
    const symSpan = normalSpan(symmetric.body!.mesh);
    const twoSpan = normalSpan(twoSided.body!.mesh);
    expect(symSpan.min).toBeCloseTo(twoSpan.min, 9);
    expect(symSpan.max).toBeCloseTo(twoSpan.max, 9);
  }, 120_000);

  it('rejects combining symmetric with a back distance at creation', () => {
    expect(() =>
      documentWithExtrude({ distance: 5, symmetric: true, backDistance: 2 })
    ).toThrow(/symmetric/);
  });
});
