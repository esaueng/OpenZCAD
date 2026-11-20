import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  chamferEdges,
  createProjectDocument,
  extrudeSketch,
  filletEdges,
  listFeaturesInOrder,
  patternBody
} from '@openzcad/document-core';
import { patternSourceProblem } from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type DerivedState,
  type FeatureData,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * M02: a feature pattern repeats fillets and chamfers. Each copy takes the
 * blend where it holds the edges the original rounded, found by the
 * original's stored edges moved with the copy. On a 100 × 40 × 10 plate
 * with a 10 × 10 × 5 boss, so every volume is a closed form.
 */

const PLATE = { x: 100, y: 40, z: 10 };
const PLATE_VOLUME = PLATE.x * PLATE.y * PLATE.z;
const BOSS = 10 * 10 * 5;

const last = (document: ProjectDocument): BodyId => document.bodyOrder.at(-1)!;
const lastFeature = (document: ProjectDocument): FeatureId =>
  listFeaturesInOrder(document).at(-1)!.featureId;

describe('M02 patterns of fillets and chamfers', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  /** The plate with a boss at x = 15, and the boss's feature id. */
  async function bossed(): Promise<{
    document: ProjectDocument;
    bossId: FeatureId;
    top: number;
  }> {
    const document = addPrimitiveFeature(
      createProjectDocument('Plate', toUserId('user_m02')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: PLATE.x, height: PLATE.y, depth: PLATE.z }
      }
    );
    const plateId = last(document);
    const box = (await adapter.syncDocument(document)).bodyRepresentations[
      plateId
    ]!.bbox;
    const sketched = addSketchFeature(document, {
      name: 'Boss sketch',
      planeRef: { type: 'canonical', plane: 'XY', offset: box.max.z },
      objects: [
        {
          objectKind: 'rectangle',
          width: 10,
          height: 10,
          centerX: box.min.x + 15,
          centerY: (box.min.y + box.max.y) / 2
        }
      ]
    });
    const extruded = extrudeSketch(sketched.document, {
      name: 'Boss',
      sketchId: sketched.sketchId,
      distance: 5,
      operation: 'add',
      targetBodyId: plateId
    }).document;
    return {
      document: extruded,
      bossId: lastFeature(extruded),
      top: box.max.z
    };
  }

  /** The boss's straight edges: its four uprights, or its four top edges. */
  function bossEdges(
    derived: DerivedState,
    bodyId: BodyId,
    top: number,
    which: 'uprights' | 'top'
  ) {
    return derived.bodyRepresentations[bodyId]!.topology!.edges.filter(
      (edge) => {
        const witness = edge.reference?.witness;
        if (!witness || witness.closed) return false;
        // Witness coordinates count in the 1e-6 quantum.
        const [a, b] = witness.endpoints.map((point) => point[2] * 1e-6) as [
          number,
          number
        ];
        return which === 'uprights'
          ? Math.abs(Math.min(a, b) - top) < 1e-5 &&
              Math.abs(Math.max(a, b) - (top + 5)) < 1e-5
          : Math.abs(a - (top + 5)) < 1e-5 && Math.abs(b - (top + 5)) < 1e-5;
      }
    );
  }

  it('rounds every boss copy’s uprights as the original’s', async () => {
    const { document, bossId, top } = await bossed();
    const derived = await adapter.syncDocument(document);
    const uprights = bossEdges(derived, last(document), top, 'uprights');
    expect(uprights).toHaveLength(4);
    const filleted = filletEdges(document, {
      name: 'Round',
      targetBodyId: last(document),
      size: 1,
      edgeHashes: uprights.map((edge) => edge.hash),
      edgeReferences: uprights.map((edge) => edge.reference!)
    }).document;
    const filletId = lastFeature(filleted);
    const row = patternBody(filleted, {
      name: 'Row',
      targetBodyId: last(filleted),
      patternKind: 'linear',
      count: 3,
      axis: 'x',
      spacing: 25,
      sourceFeatureIds: [bossId, filletId]
    }).document;
    const built = await adapter.syncDocument(row);
    expect(
      (built.featureWarnings ?? []).filter((w) => w.kind !== 'advisory')
    ).toEqual([]);
    // Each upright gives up (1 − π/4) · 1² along its 5 mm.
    const rounded = BOSS - 4 * (1 - Math.PI / 4) * 5;
    expect(built.bodyRepresentations[last(row)]!.volume).toBeCloseTo(
      PLATE_VOLUME + 3 * rounded,
      5
    );
  }, 180_000);

  it('bevels every boss copy’s top edges as the original’s', async () => {
    const { document, bossId, top } = await bossed();
    const derived = await adapter.syncDocument(document);
    const rim = bossEdges(derived, last(document), top, 'top');
    expect(rim).toHaveLength(4);
    const chamfered = chamferEdges(document, {
      name: 'Bevel',
      targetBodyId: last(document),
      size: 1,
      edgeHashes: rim.map((edge) => edge.hash),
      edgeReferences: rim.map((edge) => edge.reference!)
    }).document;
    const row = patternBody(chamfered, {
      name: 'Row',
      targetBodyId: last(chamfered),
      patternKind: 'linear',
      count: 3,
      axis: 'x',
      spacing: 25,
      sourceFeatureIds: [bossId, lastFeature(chamfered)]
    }).document;
    const built = await adapter.syncDocument(row);
    expect(
      (built.featureWarnings ?? []).filter((w) => w.kind !== 'advisory')
    ).toEqual([]);
    // The top millimetre becomes a frustum from 10 × 10 to 8 × 8:
    // (100 + 64 + 80) / 3 in place of 100.
    const bevelled = BOSS - (100 - 244 / 3);
    expect(built.bodyRepresentations[last(row)]!.volume).toBeCloseTo(
      PLATE_VOLUME + 3 * bevelled,
      5
    );
  }, 180_000);

  it('refuses a blend whose copies find no edge to round, by copy', async () => {
    const { document, top } = await bossed();
    const derived = await adapter.syncDocument(document);
    const uprights = bossEdges(derived, last(document), top, 'uprights');
    const filleted = filletEdges(document, {
      name: 'Round',
      targetBodyId: last(document),
      size: 1,
      edgeHashes: uprights.map((edge) => edge.hash),
      edgeReferences: uprights.map((edge) => edge.reference!)
    }).document;
    // The fillet alone: no boss copy stands where its copies look.
    const row = patternBody(filleted, {
      name: 'Row',
      targetBodyId: last(filleted),
      patternKind: 'linear',
      count: 2,
      axis: 'x',
      spacing: 25,
      sourceFeatureIds: [lastFeature(filleted)]
    }).document;
    const built = await adapter.syncDocument(row);
    expect(
      built.featureWarnings?.map((warning) => warning.message).join('\n')
    ).toMatch(/Copy 1 of Round finds no edge where Round's edge 1 would be/);
  }, 180_000);
  /** The plate alone, and its upright edge at the low x and y corner. */
  async function cornerRound(
    depth = PLATE.z,
    radius = 1
  ): Promise<ProjectDocument> {
    const document = addPrimitiveFeature(
      createProjectDocument('Plate', toUserId('user_m02')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: PLATE.x, height: PLATE.y, depth }
      }
    );
    const bodyId = last(document);
    const derived = await adapter.syncDocument(document);
    const body = derived.bodyRepresentations[bodyId]!;
    const corner = body.topology!.edges.filter((edge) => {
      const witness = edge.reference?.witness;
      if (!witness || witness.closed) return false;
      const [a, b] = witness.endpoints.map((point) =>
        point.map((value) => value * 1e-6)
      ) as [number[], number[]];
      return (
        Math.abs(a[0]! - body.bbox.min.x) < 1e-5 &&
        Math.abs(b[0]! - body.bbox.min.x) < 1e-5 &&
        Math.abs(a[1]! - body.bbox.min.y) < 1e-5 &&
        Math.abs(b[1]! - body.bbox.min.y) < 1e-5 &&
        Math.abs(a[2]! - b[2]!) > 1
      );
    });
    expect(corner).toHaveLength(1);
    return filletEdges(document, {
      name: 'Round',
      targetBodyId: bodyId,
      size: radius,
      edgeHashes: corner.map((edge) => edge.hash),
      edgeReferences: corner.map((edge) => edge.reference!)
    }).document;
  }

  const cornerRow = (document: ProjectDocument, spacing: number) =>
    patternBody(document, {
      name: 'Row',
      targetBodyId: last(document),
      patternKind: 'linear',
      count: 2,
      axis: 'x',
      spacing,
      sourceFeatureIds: [lastFeature(document)]
    }).document;

  it('rounds the far corner a whole plate along, and no edge a hair beside it', async () => {
    const filleted = await cornerRound();
    const row = cornerRow(filleted, PLATE.x);
    const exact = await adapter.syncDocument(row);
    expect(
      (exact.featureWarnings ?? []).filter((w) => w.kind !== 'advisory')
    ).toEqual([]);
    expect(exact.bodyRepresentations[last(row)]!.volume).toBeCloseTo(
      PLATE_VOLUME - 2 * (1 - Math.PI / 4) * PLATE.z,
      5
    );
    // 40 nm short of the far corner is not the far corner (review).
    const near = await adapter.syncDocument(
      cornerRow(filleted, PLATE.x + 0.00004)
    );
    expect(
      near.featureWarnings?.map((warning) => warning.message).join('\n')
    ).toMatch(/Copy 1 of Round finds no edge where Round's edge 1 would be/);
  }, 180_000);

  it('follows the rounded edge when an upstream edit moves it', async () => {
    // Built 10 deep, then made 12 deep: the stored pick still says 10 mm,
    // and the copy rounds the corner as it stands now (review).
    const row = cornerRow(await cornerRound(), PLATE.x);
    const deeper = structuredClone(row);
    for (const node of Object.values(deeper.nodes)) {
      const data = (
        node as {
          data?: { featureKind?: string; dimensions?: { depth: number } };
        }
      ).data;
      if (data?.featureKind === 'primitive' && data.dimensions) {
        data.dimensions.depth = 12;
      }
    }
    const built = await adapter.syncDocument(deeper);
    expect(
      (built.featureWarnings ?? []).filter((w) => w.kind !== 'advisory')
    ).toEqual([]);
    expect(built.bodyRepresentations[last(row)]!.volume).toBeCloseTo(
      PLATE.x * PLATE.y * 12 - 2 * (1 - Math.PI / 4) * 12,
      5
    );
  }, 180_000);

  it('refuses blends a reversed copy would land the wrong way round', () => {
    const chamfer = {
      featureKind: 'chamfer',
      targetBodyId: 'body_x',
      edgeHashes: [1],
      distance: 1
    };
    const fillet = {
      featureKind: 'fillet',
      targetBodyId: 'body_x',
      edgeHashes: [1],
      radius: 1
    };
    const problem = (data: object) =>
      patternSourceProblem(data as unknown as FeatureData, 'Edge');
    expect(problem(chamfer)).toBeNull();
    expect(problem(fillet)).toBeNull();
    // Two distances are judged once resolved, below.
    expect(problem({ ...chamfer, distance2: 3 })).toBeNull();
    expect(problem({ ...chamfer, angleDeg: 30 })).toMatch(/unevenly/);
    expect(problem({ ...fillet, endRadius: 2 })).toMatch(/along the edge/);
  });

  it('refuses to repeat a fillet that did not build (re-check)', async () => {
    // Wider than the plate's 40 mm side: the kernel refuses the original.
    const filleted = await cornerRound(PLATE.z, 45);
    const built = await adapter.syncDocument(cornerRow(filleted, PLATE.x));
    const messages = (built.featureWarnings ?? [])
      .map((warning) => warning.message)
      .join('\n');
    expect(messages).toMatch(/Round did not build, so a pattern cannot find/);
  }, 180_000);

  it('repeats a chamfer of two equal distances, not of two unequal ones (re-check)', async () => {
    const { document, bossId, top } = await bossed();
    const derived = await adapter.syncDocument(document);
    const rim = bossEdges(derived, last(document), top, 'top');
    const row = (distance2: number) => {
      const chamfered = chamferEdges(document, {
        name: 'Bevel',
        targetBodyId: last(document),
        size: 1,
        distance2,
        edgeHashes: rim.map((edge) => edge.hash),
        edgeReferences: rim.map((edge) => edge.reference!)
      }).document;
      return patternBody(chamfered, {
        name: 'Row',
        targetBodyId: last(chamfered),
        patternKind: 'linear',
        count: 3,
        axis: 'x',
        spacing: 25,
        sourceFeatureIds: [bossId, lastFeature(chamfered)]
      }).document;
    };
    const even = row(1);
    const evenBuilt = await adapter.syncDocument(even);
    expect(
      (evenBuilt.featureWarnings ?? []).filter((w) => w.kind !== 'advisory')
    ).toEqual([]);
    expect(evenBuilt.bodyRepresentations[last(even)]!.volume).toBeCloseTo(
      PLATE_VOLUME + 3 * (BOSS - (100 - 244 / 3)),
      5
    );
    const uneven = await adapter.syncDocument(row(2));
    expect(
      uneven.featureWarnings?.map((warning) => warning.message).join('\n')
    ).toMatch(/set back unevenly/);
  }, 180_000);
});
