import { beforeAll, describe, expect, it } from 'vitest';
import {
  addDatumPlane,
  addPrimitiveFeature,
  addSketchFeature,
  addSplitFeature,
  createProjectDocument,
  deleteFeature,
  extrudeSketch,
  listFeaturesInOrder,
  normalizeDocument,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { GEOMETRY_LINEAR_TOLERANCE, type Vec3 } from '@openzcad/geometry';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type DatumPlaneDefinition,
  type DatumPointSource,
  type DerivedState,
  type EdgeVertexPointSource,
  type FeatureId,
  type ProjectDocument,
  type SketchPlaneRef
} from '@openzcad/shared';

/**
 * R01 three-point and parallel-at-point datum planes (schema v25): the
 * document contract, the exact build's resolution of typed and vertex point
 * sources, and the refusals for collinear, coincident and missing sources.
 */

const xy = { type: 'canonical', plane: 'XY', offset: 0 } as const;
const yz = { type: 'canonical', plane: 'YZ', offset: 0 } as const;
const at = (x: number | string, y: number | string, z: number | string) =>
  ({ type: 'point', point: { x, y, z } }) as const;
const datum = (datumFeatureId: FeatureId) =>
  ({ type: 'datum', datumFeatureId }) as const;

function blank(): ProjectDocument {
  return createProjectDocument('Point planes', toUserId('user_point_planes'));
}

function withDatum(
  document: ProjectDocument,
  definition: DatumPlaneDefinition,
  name = 'Plane'
) {
  return addDatumPlane(document, { name, definition });
}

function box(document: ProjectDocument, depth: number | string = 20) {
  const next = addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 20, depth }
  });
  return { document: next, bodyId: next.bodyOrder.at(-1)! };
}

/** A 4 × 6 rectangle on `planeRef`, extruded 5 along the plane normal. */
function padOn(document: ProjectDocument, planeRef: SketchPlaneRef) {
  const sketched = addSketchFeature(document, {
    name: 'Pad sketch',
    planeRef,
    objects: [
      { objectKind: 'rectangle', width: 4, height: 6, centerX: 0, centerY: 0 }
    ]
  });
  return extrudeSketch(sketched.document, {
    name: 'Pad',
    sketchId: sketched.sketchId,
    distance: 5
  });
}

const quantum = (value: number) =>
  Math.round(value / GEOMETRY_LINEAR_TOLERANCE);

/**
 * The vertex source for `point` as one end of the body's edge running from
 * `point` to `other`, read from the derived topology the way the Plane card
 * reads a picked edge.
 */
function vertexOf(
  derived: DerivedState,
  bodyId: BodyId,
  point: Vec3,
  other: Vec3
): EdgeVertexPointSource {
  const key = (value: Vec3) =>
    [value.x, value.y, value.z].map(quantum).join(',');
  const edge = derived.bodyRepresentations[bodyId]?.topology?.edges.find(
    (candidate) => {
      const witness = candidate.reference?.witness;
      if (!witness || witness.closed) return false;
      const ends = witness.endpoints.map((end) => end.join(','));
      return ends.includes(key(point)) && ends.includes(key(other));
    }
  );
  expect(edge?.reference).toBeDefined();
  const [a, b] = [point, other].map((value) =>
    [value.x, value.y, value.z].map(quantum)
  ) as [number[], number[]];
  let order = 0;
  for (let index = 0; index < 3 && order === 0; index += 1)
    order = Math.sign(a[index]! - b[index]!);
  return {
    type: 'edge-vertex',
    bodyId,
    edgeReference: edge!.reference!,
    end: order < 0 ? 0 : 1
  };
}

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

describe('three-point and parallel planes in the document (v25)', () => {
  it('is additive and round-trips without rewriting', () => {
    const planed = withDatum(blank(), {
      kind: 'three-point',
      points: [at(0, 0, 0), at('5 + 5', 0, 0), at(0, 10, 0)]
    });
    const parallel = withDatum(planed.document, {
      kind: 'parallel-point',
      source: datum(planed.featureId),
      point: at(0, 0, 7),
      reverseNormal: true
    });
    const saved = JSON.parse(
      JSON.stringify(parallel.document)
    ) as ProjectDocument;
    expect(saved.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(normalizeDocument(saved)).toEqual(parallel.document);

    // A v22 document opens with its datums exactly as written.
    type Version = typeof PROJECT_DOCUMENT_SCHEMA_VERSION;
    const offset = withDatum(blank(), {
      kind: 'offset',
      source: xy,
      offset: 10
    }).document;
    const legacy = { ...offset, schemaVersion: 22 as Version };
    const opened = normalizeDocument(structuredClone(legacy));
    expect({ ...opened, schemaVersion: 22 }).toEqual(legacy);
  });

  it('refuses repeated points, missing bodies and malformed points', () => {
    expect(() =>
      withDatum(blank(), {
        kind: 'three-point',
        points: [at(0, 0, 0), at(0, 0, 0), at(0, 10, 0)]
      })
    ).toThrow(/three different points/);
    expect(() =>
      withDatum(blank(), {
        kind: 'three-point',
        points: [at(0, 0, 0), at(Number.NaN, 0, 0), at(0, 10, 0)]
      })
    ).toThrow(/finite/);
    expect(() =>
      withDatum(blank(), {
        kind: 'parallel-point',
        source: datum('feat_missing' as FeatureId),
        point: at(0, 0, 1)
      })
    ).toThrow(/No datum plane/);
    const vertex: DatumPointSource = {
      type: 'edge-vertex',
      bodyId: 'body_missing' as BodyId,
      edgeReference: {
        kind: 'edge',
        producingFeatureId: 'feat_missing' as FeatureId,
        lineageName: 'edge:0',
        currentHash: 1,
        witnessVersion: 1,
        witness: {
          curveType: 'LINE',
          length: 1,
          closed: false,
          endpoints: [
            [0, 0, 0],
            [1, 0, 0]
          ],
          midpoint: [0, 0, 0]
        }
      },
      end: 0
    };
    expect(() =>
      withDatum(blank(), {
        kind: 'parallel-point',
        source: xy,
        point: vertex
      })
    ).toThrow(/does not exist/);
    expect(() =>
      withDatum(blank(), {
        kind: 'parallel-point',
        source: xy,
        point: { ...vertex, end: 2 as 0 }
      })
    ).toThrow(/open edge/);
  });
});

describe('three-point and parallel planes in the exact build', () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  async function bbox(document: ProjectDocument, bodyId: BodyId) {
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    return derived.bodyRepresentations[bodyId]!.bbox;
  }

  it('puts three points at z = 0 on the plane z = 0', async () => {
    const planed = withDatum(blank(), {
      kind: 'three-point',
      points: [at(0, 0, 0), at(10, 0, 0), at(0, 10, 0)]
    });
    const derived = await adapter.syncDocument(planed.document);
    expect(derived.warnings).toEqual([]);
    const frame = derived.datumFrames?.[planed.featureId];
    expect(frame?.origin).toEqual(v(0, 0, 0));
    expect(frame?.normal).toEqual(v(0, 0, 1));
    const padded = padOn(planed.document, datum(planed.featureId));
    const box = await bbox(padded.document, padded.bodyId);
    expect(box.min.z).toBeCloseTo(0, 9);
    expect(box.max.z).toBeCloseTo(5, 9);
  });

  it('builds an oblique plane through expression points', async () => {
    // The plane x + z = 10: (10,0,0) → (10,10,0) → (0,0,10) gives the
    // right-handed normal (1, 0, 1)/√2.
    const planed = withDatum(blank(), {
      kind: 'three-point',
      points: [at(10, 0, 0), at(10, '2 * 5', 0), at(0, 0, '20 / 2')]
    });
    const derived = await adapter.syncDocument(planed.document);
    expect(derived.warnings).toEqual([]);
    const frame = derived.datumFrames![planed.featureId]!;
    expect(frame.normal.x).toBeCloseTo(Math.SQRT1_2, 12);
    expect(frame.normal.z).toBeCloseTo(Math.SQRT1_2, 12);
    expect(frame.normal.y).toBeCloseTo(0, 12);
    for (const point of [v(10, 0, 0), v(10, 10, 0), v(0, 0, 10), v(5, 3, 5)]) {
      const height =
        (point.x - frame.origin.x) * frame.normal.x +
        (point.y - frame.origin.y) * frame.normal.y +
        (point.z - frame.origin.z) * frame.normal.z;
      expect(height).toBeCloseTo(0, 9);
    }
  });

  it('refuses collinear points by name and publishes no frame', async () => {
    const planed = withDatum(blank(), {
      kind: 'three-point',
      points: [at(0, 0, 0), at(5, 5, 5), at(10, 10, 10)]
    });
    const derived = await adapter.syncDocument(planed.document);
    expect(derived.warnings.join('\n')).toMatch(/collinear/);
    expect(derived.datumFrames?.[planed.featureId]).toBeUndefined();
  });

  it('refuses coincident points that only meet once evaluated', async () => {
    const planed = withDatum(blank(), {
      kind: 'three-point',
      points: [at(0, 0, 0), at('3 - 3', 0, 0), at(0, 10, 0)]
    });
    const derived = await adapter.syncDocument(planed.document);
    expect(derived.warnings.join('\n')).toMatch(/coincide/);
    expect(derived.datumFrames?.[planed.featureId]).toBeUndefined();
  });

  it('places a plane parallel to XY through z = 7', async () => {
    const planed = withDatum(blank(), {
      kind: 'parallel-point',
      source: xy,
      point: at(30, -4, 7)
    });
    const padded = padOn(planed.document, datum(planed.featureId));
    const box = await bbox(padded.document, padded.bodyId);
    expect(box.min.z).toBeCloseTo(7, 9);
    expect(box.max.z).toBeCloseTo(12, 9);
  });

  it('splits a block on a plane parallel to YZ through x = 5', async () => {
    const block = box(blank());
    const planed = withDatum(block.document, {
      kind: 'parallel-point',
      source: yz,
      point: at(5, 3, 3)
    });
    const split = addSplitFeature(planed.document, {
      name: 'Split',
      targetBodyId: block.bodyId,
      plane: datum(planed.featureId)
    });
    const derived = await adapter.syncDocument(split.document);
    expect(derived.warnings).toEqual([]);
    const volumes = [split.bodyId, split.secondBodyId]
      .map((bodyId) => derived.bodyRepresentations[bodyId]!.volume)
      .sort((a, b) => a - b);
    expect(volumes[0]).toBeCloseTo(5 * 20 * 20, 6);
    expect(volumes[1]).toBeCloseTo(15 * 20 * 20, 6);
  });

  it('runs three-point and parallel planes through vertices of a block, following its edits', async () => {
    const block = box(blank());
    const derived = await adapter.syncDocument(block.document);
    const top = [
      vertexOf(derived, block.bodyId, v(0, 0, 20), v(20, 0, 20)),
      vertexOf(derived, block.bodyId, v(20, 0, 20), v(0, 0, 20)),
      vertexOf(derived, block.bodyId, v(0, 20, 20), v(20, 20, 20))
    ] as const;
    const planed = withDatum(block.document, {
      kind: 'three-point',
      points: [...top]
    });
    const parallel = withDatum(
      planed.document,
      {
        kind: 'parallel-point',
        source: yz,
        point: vertexOf(derived, block.bodyId, v(20, 20, 0), v(20, 20, 20))
      },
      'Side'
    );
    const padded = padOn(parallel.document, datum(planed.featureId));
    const built = await adapter.syncDocument(padded.document);
    expect(built.warnings).toEqual([]);
    expect(built.datumFrames![planed.featureId]!.origin).toEqual(v(0, 0, 20));
    expect(built.datumFrames![planed.featureId]!.normal).toEqual(v(0, 0, 1));
    expect(built.datumFrames![parallel.featureId]!.origin.x).toBe(20);
    const pad = built.bodyRepresentations[padded.bodyId]!.bbox;
    expect(pad.min.z).toBeCloseTo(20, 9);
    expect(pad.max.z).toBeCloseTo(25, 9);

    // Deepen the block: the plane follows its top vertices to z = 30.
    const primitive = listFeaturesInOrder(padded.document)[0]!;
    const deeper = updateFeature(padded.document, {
      featureId: primitive.featureId,
      data: {
        featureKind: 'primitive',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 30 }
      }
    });
    const rebuilt = await adapter.syncDocument(deeper);
    expect(rebuilt.warnings).toEqual([]);
    expect(rebuilt.datumFrames![planed.featureId]!.origin.z).toBeCloseTo(30, 9);
    const moved = rebuilt.bodyRepresentations[padded.bodyId]!.bbox;
    expect(moved.min.z).toBeCloseTo(30, 9);
    expect(moved.max.z).toBeCloseTo(35, 9);
  });

  it('refuses by name when a vertex source no longer exists', async () => {
    const block = box(blank());
    const derived = await adapter.syncDocument(block.document);
    const planed = withDatum(
      block.document,
      {
        kind: 'parallel-point',
        source: xy,
        point: vertexOf(derived, block.bodyId, v(0, 0, 20), v(20, 0, 20))
      },
      'Lid plane'
    );
    const primitive = listFeaturesInOrder(planed.document)[0]!;
    const orphaned = deleteFeature(planed.document, {
      featureId: primitive.featureId
    });
    const broken = await adapter.syncDocument(orphaned);
    expect(broken.warnings.join('\n')).toMatch(
      /Datum plane "Lid plane" cannot use a vertex of body .* unavailable/
    );
    expect(broken.datumFrames?.[planed.featureId]).toBeUndefined();
  });

  it('refuses by name when a later edit removes the vertex edge', async () => {
    const block = box(blank());
    const derived = await adapter.syncDocument(block.document);
    const vertex = vertexOf(derived, block.bodyId, v(0, 0, 20), v(20, 0, 20));
    const planed = withDatum(
      block.document,
      {
        kind: 'parallel-point',
        source: xy,
        // The same edge under a lineage name the block never produced.
        point: {
          ...vertex,
          edgeReference: { ...vertex.edgeReference, lineageName: 'edge:gone' }
        }
      },
      'Lid plane'
    );
    const broken = await adapter.syncDocument(planed.document);
    expect(broken.warnings.join('\n')).toMatch(
      /Datum plane "Lid plane" cannot use a vertex of source feature "Block"/
    );
  });
});
