import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  assertDocumentContentSchema,
  createProjectDocument,
  holeBody,
  listFeaturesInOrder,
  patternBody,
  updateFeature,
  type PatternInput
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type DerivedState,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * M02 total-length linear patterns (schema v120): `spacingMode: 'total'`
 * reads the spacing as the distance from the original to the last copy, so
 * the copies share it out and a changed count keeps the row's length.
 */

const PLATE = { x: 100, y: 40, z: 10 };
const PLATE_VOLUME = PLATE.x * PLATE.y * PLATE.z;
const HOLE_R = 3;
const HOLE_VOLUME = Math.PI * HOLE_R ** 2 * PLATE.z;

const last = (document: ProjectDocument): BodyId => document.bodyOrder.at(-1)!;
const lastFeature = (document: ProjectDocument): FeatureId =>
  listFeaturesInOrder(document).at(-1)!.featureId;

function box(
  name: string,
  size: { x: number; y: number; z: number }
): ProjectDocument {
  return addPrimitiveFeature(
    createProjectDocument(name, toUserId('user_m02')),
    {
      name,
      primitiveKind: 'box',
      dimensions: { width: size.x, height: size.y, depth: size.z }
    }
  );
}

function topFace(derived: DerivedState, bodyId: BodyId) {
  const body = derived.bodyRepresentations[bodyId]!;
  return body.topology!.faces.find(
    (face) =>
      face.geometry?.surfaceType === 'plane' &&
      (face.geometry.normal?.z ?? 0) > 0.999 &&
      Math.abs(
        (face.geometry.centroid ?? face.geometry.center).z - body.bbox.max.z
      ) < 1e-6
  )!;
}

/** World (x, y) of every Ø6 bore's axis, sorted by x. */
function bores(derived: DerivedState, bodyId: BodyId): [number, number][] {
  return derived.bodyRepresentations[bodyId]!.topology!.faces.filter(
    (face) =>
      face.geometry?.surfaceType === 'cylinder' &&
      Math.abs(face.geometry.area - 2 * Math.PI * HOLE_R * PLATE.z) < 1e-6
  )
    .map((face) => {
      const at = face.geometry!.axisStart!;
      return [at.x, at.y] as [number, number];
    })
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function expectPoints(
  actual: readonly [number, number][],
  expected: readonly [number, number][]
): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach(([x, y], index) => {
    expect(x).toBeCloseTo(expected[index]![0], 6);
    expect(y).toBeCloseTo(expected[index]![1], 6);
  });
}

function row(
  document: ProjectDocument,
  extra: Partial<PatternInput> = {}
): ProjectDocument {
  return patternBody(document, {
    name: 'Row',
    targetBodyId: last(document),
    patternKind: 'linear',
    count: 4,
    axis: 'x',
    spacing: 60,
    spacingMode: 'total',
    ...extra
  }).document;
}

describe('M02 total-length patterns: document contract', () => {
  it('stores the mode at schema v120', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(120);
    const block = box('Block', { x: 10, y: 10, z: 10 });
    expect(listFeaturesInOrder(row(block)).at(-1)!.data).toMatchObject({
      patternKind: 'linear',
      spacing: 60,
      spacingMode: 'total'
    });
  });

  it.each([
    [
      'a total length on a circular pattern',
      { patternKind: 'circular' as const, angleDeg: 360 },
      /Only a linear pattern spaces its copies over a total length/
    ],
    [
      'an unknown mode',
      { spacingMode: 'even' as never },
      /"even" is not a pattern spacing mode/
    ]
  ])('refuses %s', (_label, patch, message) => {
    const block = box('Block', { x: 10, y: 10, z: 10 });
    expect(() => row(block, patch)).toThrow(message);
  });

  it('refuses a total length on a document that declares schema v119', () => {
    const block = box('Block', { x: 10, y: 10, z: 10 });
    const old = { ...block, schemaVersion: 119 } as unknown as ProjectDocument;
    expect(() => row(old)).toThrow(/require project schema v120/);
  });

  it('refuses a total length on another kind when a document loads (review)', () => {
    const patterned = row(box('Block', { x: 10, y: 10, z: 10 }));
    const loaded = structuredClone(patterned);
    const node = listFeaturesInOrder(loaded).at(-1) as unknown as {
      data: { patternKind: string; angleDeg?: number };
    };
    node.data.patternKind = 'circular';
    node.data.angleDeg = 360;
    expect(() => assertDocumentContentSchema(loaded)).toThrow(
      /Only a linear pattern spaces its copies over a total length/
    );
    expect(() => assertDocumentContentSchema(patterned)).not.toThrow();
  });

  it('clears the mode back to the spacing between copies', () => {
    const block = box('Block', { x: 10, y: 10, z: 10 });
    const patterned = row(block);
    const cleared = updateFeature(patterned, {
      featureId: lastFeature(patterned),
      data: { featureKind: 'pattern', spacing: 20 },
      clearData: ['spacingMode']
    });
    expect(listFeaturesInOrder(cleared).at(-1)!.data).not.toHaveProperty(
      'spacingMode'
    );
  });
});

describe('M02 total-length patterns: exact build', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  async function drilled(
    x: number,
    y: number
  ): Promise<{ document: ProjectDocument; holeId: FeatureId }> {
    const document = box('Plate', PLATE);
    const derived = await adapter.syncDocument(document);
    const face = topFace(derived, last(document));
    const body = derived.bodyRepresentations[last(document)]!;
    const next = holeBody(document, {
      name: 'Hole',
      targetBodyId: last(document),
      faceHash: face.hash,
      ...(face.reference ? { faceReference: face.reference } : {}),
      style: 'simple',
      diameter: 2 * HOLE_R,
      depthMode: 'through',
      position: {
        // The face's u runs along −y.
        u: (body.bbox.min.y + body.bbox.max.y) / 2 - y,
        v: x - (body.bbox.min.x + body.bbox.max.x) / 2
      },
      positionAnchor: 'centroid'
    }).document;
    return { document: next, holeId: lastFeature(next) };
  }

  it('shares a total out between whole-body copies', async () => {
    const block = box('Block', { x: 10, y: 10, z: 10 });
    const built = await adapter.syncDocument(block);
    const min = built.bodyRepresentations[last(block)]!.bbox.min;
    const patterned = row(block);
    const derived = await adapter.syncDocument(patterned);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[last(patterned)]!;
    // Four blocks 20 apart: the last starts 60 along.
    expect(body.volume).toBeCloseTo(4000, 6);
    expect(body.bbox.max.x - min.x).toBeCloseTo(70, 6);
  }, 120_000);

  it('keeps a hole row’s length when its count changes', async () => {
    const { document: holed, holeId } = await drilled(10, 20);
    const three = row(holed, {
      count: 3,
      sourceFeatureIds: [holeId]
    });
    const first = await adapter.syncDocument(three);
    expect(first.warnings).toEqual([]);
    expectPoints(bores(first, last(three)), [
      [10, 20],
      [40, 20],
      [70, 20]
    ]);
    const four = updateFeature(three, {
      featureId: lastFeature(three),
      data: { featureKind: 'pattern', count: 4 }
    });
    const second = await adapter.syncDocument(four);
    expect(second.warnings).toEqual([]);
    expect(second.bodyRepresentations[last(four)]!.volume).toBeCloseTo(
      PLATE_VOLUME - 4 * HOLE_VOLUME,
      6
    );
    expectPoints(bores(second, last(four)), [
      [10, 20],
      [30, 20],
      [50, 20],
      [70, 20]
    ]);
  }, 120_000);
});
