import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  holeBody,
  listFeaturesInOrder,
  patternBody,
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
 * M02 mirror patterns (schema v113): the whole body, or the repeated holes,
 * bosses and cuts, copied once as their reflection in a plane. Every
 * expectation is a closed form on a 100 × 40 × 10 plate or 10 mm blocks.
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

/** Mirrors in the plane x = `x`. */
function mirrored(
  document: ProjectDocument,
  x: number,
  extra: Partial<PatternInput> = {}
): ProjectDocument {
  return patternBody(document, {
    name: 'Mirrored',
    targetBodyId: last(document),
    patternKind: 'mirror',
    count: 2,
    axis: 'x',
    mirrorPlane: {
      origin: { x, y: 0, z: 0 },
      normal: { x: 1, y: 0, z: 0 }
    },
    ...extra
  }).document;
}

describe('M02 mirror patterns: document contract', () => {
  it('stores the plane at schema v113', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(113);
    const block = box('Block', { x: 10, y: 10, z: 10 });
    expect(listFeaturesInOrder(mirrored(block, 20)).at(-1)!.data).toMatchObject(
      {
        patternKind: 'mirror',
        mirrorPlane: { origin: { x: 20 }, normal: { x: 1 } }
      }
    );
  });

  it.each([
    [
      'no plane on a mirror pattern',
      { mirrorPlane: undefined },
      /needs the plane it mirrors in/
    ],
    [
      'a plane on a linear pattern',
      { patternKind: 'linear' as const },
      /Only a mirror pattern names a mirror plane/
    ],
    [
      'a plane without a normal',
      { mirrorPlane: { origin: { x: 0, y: 0, z: 0 } } as never },
      /a datum plane or an origin and normal/
    ]
  ])('refuses %s', (_label, patch, message) => {
    const block = box('Block', { x: 10, y: 10, z: 10 });
    expect(() => mirrored(block, 20, patch)).toThrow(message);
  });

  it('refuses a mirror pattern on a document that declares schema v112', () => {
    const block = box('Block', { x: 10, y: 10, z: 10 });
    const old = { ...block, schemaVersion: 112 } as unknown as ProjectDocument;
    expect(() => mirrored(old, 20)).toThrow(/require project schema v113/);
  });
});

describe('M02 mirror patterns: exact build', () => {
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

  it('mirrors a hole across the plate, its copy named apart', async () => {
    const { document: holed, holeId } = await drilled(20, 10);
    const patterned = mirrored(holed, 50, {
      sourceFeatureIds: [holeId]
    });
    const derived = await adapter.syncDocument(patterned);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[last(patterned)]!.volume).toBeCloseTo(
      PLATE_VOLUME - 2 * HOLE_VOLUME,
      6
    );
    expectPoints(bores(derived, last(patterned)), [
      [20, 10],
      [80, 10]
    ]);
    const names = derived.bodyRepresentations[
      last(patterned)
    ]!.topology!.faces.flatMap((face) => face.reference?.lineageName ?? [])
      .filter((name) => name.includes('hole.face.bore'))
      .sort();
    expect(names).toEqual(
      [
        'hole.face.bore',
        `pattern.face.instance.1.source.${holeId}.hole.face.bore`
      ].sort()
    );
  }, 120_000);

  it('mirrors a whole body apart, and fuses a reflection that overlaps it', async () => {
    const block = box('Block', { x: 10, y: 10, z: 10 });
    const built = await adapter.syncDocument(block);
    const min = built.bodyRepresentations[last(block)]!.bbox.min;
    const apart = mirrored(block, min.x + 20);
    const overlapping = mirrored(block, min.x + 8);
    const [clear, joined] = [
      await adapter.syncDocument(apart),
      await adapter.syncDocument(overlapping)
    ];
    expect(clear.warnings).toEqual([]);
    const reflected = clear.bodyRepresentations[last(apart)]!;
    expect(reflected.volume).toBeCloseTo(2000, 6);
    // The copy lies from x = 30 to 40, a positive, closed solid.
    expect(reflected.bbox.max.x - min.x).toBeCloseTo(40, 6);
    expect(joined.warnings).toEqual([]);
    // 1000 + 1000 − the 4 × 10 × 10 they share.
    expect(joined.bodyRepresentations[last(overlapping)]!.volume).toBeCloseTo(
      1600,
      6
    );
  }, 120_000);

  it('refuses a mirror pattern whose one copy is skipped', async () => {
    const block = box('Block', { x: 10, y: 10, z: 10 });
    const skipped = mirrored(block, 20, { skippedInstances: ['1'] });
    const derived = await adapter.syncDocument(skipped);
    expect(
      derived.featureWarnings?.map((warning) => warning.message).join('\n')
    ).toMatch(/keep at least one copy besides the original/);
  }, 120_000);
});
