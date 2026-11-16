import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  draftVerdict,
  toUserId,
  type BodyId,
  type PrimitiveKind,
  type ProjectDocument,
  type SurfaceAnalysisBody,
  type SurfaceAnalysisRequest
} from '@openzcad/shared';

/**
 * M09 draft analysis on the real kernel, through the adapter's
 * `surfaceAnalysis` (the worker's path). Read-only and unsaved: no schema
 * change. Every value is the kernel's exact draft at a sample on the face's
 * own surface; a plane's range is exact, a curved face's is its samples'.
 */
const owner = toUserId('user_surface_analysis');

let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 120_000);
afterAll(() => adapter.dispose());

function documentWith(
  ...bodies: { kind: PrimitiveKind; dimensions: Record<string, number> }[]
): ProjectDocument {
  let document = createProjectDocument('Analysis', owner);
  for (const [index, body] of bodies.entries()) {
    document = addPrimitiveFeature(document, {
      name: `Body ${index + 1}`,
      primitiveKind: body.kind,
      dimensions: body.dimensions
    });
  }
  return document;
}

const draftUp = (minimumDegrees = 1): SurfaceAnalysisRequest => ({
  kind: 'draft',
  pull: { x: 0, y: 0, z: 1 },
  minimumDegrees
});

async function analyse(
  document: ProjectDocument,
  request: SurfaceAnalysisRequest,
  bodyIds = [...document.bodyOrder] as BodyId[]
) {
  await adapter.syncDocument(document);
  return adapter.surfaceAnalysis(document, bodyIds, request);
}

function sortedRanges(body: SurfaceAnalysisBody) {
  return body.faces
    .map((face) => [
      face.surface,
      Math.round(face.min * 1e6) / 1e6,
      Math.round(face.max * 1e6) / 1e6,
      face.exact
    ])
    .sort((a, b) => (a[1] as number) - (b[1] as number));
}

describe('draft analysis', () => {
  it('reads a box exactly: top +90°, bottom −90°, walls 0°', async () => {
    const document = documentWith({
      kind: 'box',
      dimensions: { width: 10, height: 20, depth: 30 }
    });
    const report = await analyse(document, draftUp());
    expect(report.missing).toEqual([]);
    expect(report.unsupported).toEqual([]);
    const [body] = report.bodies;
    expect(body!.bodyId).toBe(document.bodyOrder[0]);
    expect(sortedRanges(body!)).toEqual([
      ['plane', -90, -90, true],
      ['plane', 0, 0, true],
      ['plane', 0, 0, true],
      ['plane', 0, 0, true],
      ['plane', 0, 0, true],
      ['plane', 90, 90, true]
    ]);
    const verdicts = body!.faces
      .map((face) => draftVerdict(face.min, face.max, 1))
      .sort();
    expect(verdicts).toEqual([
      'insufficient',
      'insufficient',
      'insufficient',
      'insufficient',
      'negative',
      'positive'
    ]);
    // One value and one exact outward normal per overlay vertex.
    const vertices = body!.positions.length / 3;
    expect(body!.values).toHaveLength(vertices);
    expect(body!.normals).toHaveLength(vertices * 3);
    expect(body!.indices.length % 3).toBe(0);
    expect(Math.max(...body!.indices)).toBeLessThan(vertices);
    // Each sample's value agrees with its normal: draft = asin(n · pull).
    for (let index = 0; index < vertices; index += 1) {
      const nz = body!.normals[index * 3 + 2]!;
      expect(body!.values[index]).toBeCloseTo(
        (Math.asin(nz) * 180) / Math.PI,
        3
      );
    }
  });

  it('follows the pull direction, which need not be unit length', async () => {
    const document = documentWith({
      kind: 'box',
      dimensions: { width: 10, height: 20, depth: 30 }
    });
    const report = await analyse(document, {
      kind: 'draft',
      pull: { x: 5, y: 0, z: 0 },
      minimumDegrees: 1
    });
    const body = report.bodies[0]!;
    expect(sortedRanges(body).map((range) => range[1])).toEqual([
      -90, 0, 0, 0, 0, 90
    ]);
    // The +X face is the one at +90° now.
    const top = body.faces.find((face) => face.min === 90)!;
    expect(top.samples).toBeGreaterThan(0);
    for (let index = 0; index < body.values.length; index += 1) {
      if (body.values[index] === 90)
        expect(body.normals[index * 3]).toBeCloseTo(1, 9);
    }
  });

  it('samples curved faces: a cylinder wall is 0°, a sphere crosses bands', async () => {
    const document = documentWith(
      { kind: 'cylinder', dimensions: { radius: 5, height: 20 } },
      { kind: 'sphere', dimensions: { radius: 5 } }
    );
    const report = await analyse(document, draftUp());
    expect(report.unsupported).toEqual([]);
    const [cylinder, sphere] = report.bodies;
    const wall = cylinder!.faces.find((face) => face.surface === 'cylinder')!;
    expect(wall.min).toBeCloseTo(0, 9);
    expect(wall.max).toBeCloseTo(0, 9);
    // A curved face's range is its samples', never claimed exact.
    expect(wall.exact).toBe(false);
    expect(
      cylinder!.faces
        .filter((face) => face.surface === 'plane')
        .map((face) => [face.min, face.exact])
        .sort()
    ).toEqual([
      [-90, true],
      [90, true]
    ]);
    // The sphere's two halves run from the equator (0°) to a pole (±90°):
    // each crosses from below the minimum into a drafted band.
    expect(sphere!.faces).toHaveLength(2);
    for (const face of sphere!.faces) {
      expect(face.exact).toBe(false);
      expect(Math.max(Math.abs(face.min), Math.abs(face.max))).toBeCloseTo(
        90,
        0
      );
      expect(draftVerdict(face.min, face.max, 1)).toBe('mixed');
    }
  });

  it('analyses a moved body where the build put it', async () => {
    let document = documentWith({
      kind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    document = transformBody(document, {
      name: 'Tilt',
      targetBodyId: document.bodyOrder[0] as BodyId,
      translation: { x: 50, y: 0, z: 0 },
      rotationDeg: { x: 30, y: 0, z: 0 }
    }).document;
    const report = await analyse(document, draftUp(), [
      document.bodyOrder.at(-1) as BodyId
    ]);
    const body = report.bodies[0]!;
    // Tilted 30° about X: the top and two walls now carry ±60° and ±30°.
    expect(
      sortedRanges(body).map((range) => Math.round(range[1] as number))
    ).toEqual([-60, -30, 0, 0, 30, 60]);
    let minX = Infinity;
    for (let index = 0; index < body.positions.length; index += 3)
      minX = Math.min(minX, body.positions[index]!);
    expect(minX).toBeGreaterThan(40);
  });

  it('lists a body with no exact geometry as missing, never analysed', async () => {
    const document = documentWith({
      kind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    const report = await analyse(document, draftUp(), [
      document.bodyOrder[0] as BodyId,
      'body_gone' as BodyId
    ]);
    expect(report.bodies.map((body) => body.bodyId)).toEqual([
      document.bodyOrder[0]
    ]);
    expect(report.missing).toEqual(['body_gone']);
  });

  it('refuses a zero pull direction rather than guess one', async () => {
    const document = documentWith({
      kind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    await expect(
      analyse(document, {
        kind: 'draft',
        pull: { x: 0, y: 0, z: 0 },
        minimumDegrees: 1
      })
    ).rejects.toThrow(/pull direction/);
  });
});

describe('draft bands', () => {
  it('reads a range against the minimum', () => {
    expect(draftVerdict(2, 5, 1)).toBe('positive');
    expect(draftVerdict(-5, -2, 1)).toBe('negative');
    expect(draftVerdict(-0.5, 0.5, 1)).toBe('insufficient');
    expect(draftVerdict(0.5, 5, 1)).toBe('mixed');
    expect(draftVerdict(-5, 5, 1)).toBe('mixed');
    // A vertical wall is insufficient even at a 0° minimum.
    expect(draftVerdict(1e-14, 1e-14, 0)).toBe('insufficient');
    expect(draftVerdict(0.01, 0.01, 0)).toBe('positive');
  });
});
