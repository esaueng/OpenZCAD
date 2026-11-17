import { beforeAll, describe, expect, it } from 'vitest';
import {
  addDatumAxis,
  addDatumCsys,
  addDatumPlane,
  addDatumPoint,
  addPrimitiveFeature,
  createProjectDocument,
  deleteFeature,
  normalizeDocument,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type DatumCsysDefinition,
  type DatumPointDefinition,
  type DatumPointSource,
  type DerivedState,
  type EdgeTopologyReferenceV5,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * R01 (schema v97): datum points and named coordinate systems — the document
 * contract, the exact build's constructors with their named refusals, and
 * every consumer: points feeding planes, axes, systems and later points;
 * systems feeding planes (their principal planes), axes (their X/Y/Z) and
 * Moves (aligned from one system onto another).
 */

const at = (x: number | string, y: number | string, z: number | string) =>
  ({ type: 'point', point: { x, y, z } }) as const;
const pointRef = (datumFeatureId: FeatureId) =>
  ({ type: 'datum-point', datumFeatureId }) as const;
const csysRef = (datumFeatureId: FeatureId) =>
  ({ type: 'datum-csys', datumFeatureId }) as const;
const xy = { type: 'canonical', plane: 'XY', offset: 0 } as const;

function blank(): ProjectDocument {
  return createProjectDocument('Datum points', toUserId('user_datum_points'));
}

function point(
  document: ProjectDocument,
  definition: DatumPointDefinition,
  name = 'Point'
) {
  return addDatumPoint(document, { name, definition });
}

function csys(
  document: ProjectDocument,
  definition: DatumCsysDefinition,
  name = 'System'
) {
  return addDatumCsys(document, { name, definition });
}

const offsetFrom = (
  from: DatumPointSource,
  x: number | string,
  y: number | string,
  z: number | string
): DatumPointDefinition => ({ kind: 'offset', from, offset: { x, y, z } });

function box(document: ProjectDocument, size = 20) {
  const next = addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: size, height: size, depth: size }
  });
  return { document: next, bodyId: next.bodyOrder.at(-1)! };
}

function edgeReference(
  derived: DerivedState,
  bodyId: BodyId,
  match: (ends: number[][], curveType: string) => boolean
): EdgeTopologyReferenceV5 {
  const edge = derived.bodyRepresentations[bodyId]?.topology?.edges.find(
    (candidate) => {
      const witness = candidate.reference?.witness;
      if (witness === undefined) return false;
      const ends = witness.closed
        ? []
        : witness.endpoints.map((end) => end.map((q) => q * 1e-6));
      return match(ends, witness.curveType.toLowerCase());
    }
  );
  expect(edge?.reference).toBeDefined();
  return edge!.reference!;
}

function expectVector(
  actual: { x: number; y: number; z: number } | undefined,
  expected: [number, number, number],
  digits = 9
) {
  expect(actual).toBeDefined();
  expect(actual!.x).toBeCloseTo(expected[0], digits);
  expect(actual!.y).toBeCloseTo(expected[1], digits);
  expect(actual!.z).toBeCloseTo(expected[2], digits);
}

describe('datum points and coordinate systems in the document (v97)', () => {
  it('stores them in the current schema and round-trips without rewriting', () => {
    const initial = blank();
    expect(initial.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    const p = point(initial, offsetFrom(at(0, 0, 0), '1 + 1', 2, 3));
    const s = csys(p.document, {
      kind: 'placement',
      origin: pointRef(p.featureId),
      rotationDeg: { x: 0, y: 0, z: 90 }
    });
    const saved = JSON.parse(JSON.stringify(s.document)) as ProjectDocument;
    expect(normalizeDocument(saved)).toEqual(s.document);
  });

  it('refuses them in a document of an older schema', () => {
    const p = point(blank(), offsetFrom(at(0, 0, 0), 1, 2, 3));
    type Version = typeof PROJECT_DOCUMENT_SCHEMA_VERSION;
    const older = { ...p.document, schemaVersion: 91 as Version };
    expect(() => normalizeDocument(structuredClone(older))).toThrow(
      /Datum points and coordinate systems require project schema v97/
    );
  });

  it('reads only existing, earlier points and systems, and nothing else', () => {
    expect(() =>
      point(blank(), offsetFrom(pointRef('feat_gone' as FeatureId), 0, 0, 0))
    ).toThrow(/No datum point/);
    const p = point(blank(), offsetFrom(at(0, 0, 0), 1, 0, 0));
    expect(() =>
      point(p.document, {
        kind: 'offset',
        from: { ...pointRef(p.featureId), extra: 1 } as never,
        offset: { x: 0, y: 0, z: 0 }
      })
    ).toThrow(/carries only the datum id/);
    expect(() =>
      csys(p.document, {
        kind: 'three-point',
        points: [pointRef(p.featureId), pointRef(p.featureId), at(0, 1, 0)]
      })
    ).toThrow(/three different points/);
    expect(() =>
      addDatumAxis(p.document, {
        name: 'Axis',
        definition: {
          kind: 'csys-axis',
          csys: csysRef('feat_gone' as FeatureId),
          axis: 'X'
        }
      })
    ).toThrow(/No coordinate system/);
    const s = csys(p.document, {
      kind: 'placement',
      origin: at(0, 0, 0),
      rotationDeg: { x: 0, y: 0, z: 0 }
    });
    const block = box(s.document);
    expect(() =>
      transformBody(block.document, {
        name: 'Align',
        targetBodyId: block.bodyId,
        translation: { x: 0, y: 0, z: 0 },
        csysAlign: { from: csysRef(s.featureId), to: csysRef(s.featureId) }
      })
    ).toThrow(/two different coordinate systems/);
    // An earlier point may not read a later one, whichever path edits it.
    const later = point(block.document, offsetFrom(at(0, 0, 0), 0, 5, 0));
    expect(() =>
      updateFeature(later.document, {
        featureId: p.featureId,
        data: {
          featureKind: 'datum-point',
          definition: offsetFrom(pointRef(later.featureId), 0, 0, 1)
        }
      })
    ).toThrow(/comes later in history/);
  });

  it('refuses deleting a point or system something is built on, naming it', () => {
    const p = point(blank(), offsetFrom(at(0, 0, 0), 1, 0, 0), 'Base');
    const plane = addDatumPlane(p.document, {
      name: 'Through base',
      definition: {
        kind: 'parallel-point',
        source: xy,
        point: pointRef(p.featureId)
      }
    });
    expect(() =>
      deleteFeature(plane.document, { featureId: p.featureId })
    ).toThrow(/Cannot delete datum point "Base": Through base is built on it/);
    const s = csys(
      plane.document,
      {
        kind: 'placement',
        origin: at(0, 0, 0),
        rotationDeg: { x: 0, y: 0, z: 0 }
      },
      'Frame'
    );
    const block = box(s.document);
    const moved = transformBody(block.document, {
      name: 'Align',
      targetBodyId: block.bodyId,
      translation: { x: 0, y: 0, z: 0 },
      csysAlign: { to: csysRef(s.featureId) }
    });
    expect(() =>
      deleteFeature(moved.document, { featureId: s.featureId })
    ).toThrow(/Cannot delete coordinate system "Frame": Align uses it/);
  });

  it('refuses deleting a datum plane a system or a point is built on', () => {
    const shelf = addDatumPlane(blank(), {
      name: 'Shelf',
      definition: { kind: 'offset', source: xy, offset: 5 }
    });
    const onShelf = { type: 'datum', datumFeatureId: shelf.featureId } as const;
    const system = csys(
      shelf.document,
      { kind: 'plane', source: onShelf },
      'On shelf'
    );
    expect(() =>
      deleteFeature(system.document, { featureId: shelf.featureId })
    ).toThrow(/Cannot delete datum plane "Shelf": On shelf uses it/);
    const up = addDatumAxis(shelf.document, {
      name: 'Up',
      definition: { kind: 'two-point', points: [at(0, 0, 0), at(0, 0, 1)] }
    });
    const pierce = point(
      up.document,
      {
        kind: 'axis-plane',
        axis: { type: 'datum-axis', datumFeatureId: up.featureId },
        plane: onShelf
      },
      'Pierce'
    );
    expect(() =>
      deleteFeature(pierce.document, { featureId: shelf.featureId })
    ).toThrow(/Cannot delete datum plane "Shelf": Pierce uses it/);
  });

  it('refuses typed-only point and system commands in an older command log', () => {
    const p = point(blank(), offsetFrom(at(0, 0, 0), 1, 2, 3), 'Typed');
    const older = structuredClone({
      ...p.document,
      nodes: blank().nodes,
      featureOrder: [],
      schemaVersion: 96 as typeof PROJECT_DOCUMENT_SCHEMA_VERSION,
      commandLog: [
        {
          id: 'cmd_typed',
          kind: 'feature.datum-point',
          label: 'Add point',
          payload: {
            name: 'Typed',
            definition: offsetFrom(at(0, 0, 0), 1, 2, 3)
          }
        },
        {
          id: 'cmd_placed',
          kind: 'feature.datum-csys',
          label: 'Add system',
          payload: {
            name: 'Placed',
            definition: {
              kind: 'placement',
              origin: at(0, 0, 0),
              rotationDeg: { x: 0, y: 0, z: 90 }
            }
          }
        }
      ]
    }) as unknown as ProjectDocument;
    expect(() => normalizeDocument(older)).toThrow(
      /Datum points and coordinate systems require project schema v97/
    );
  });
});

describe(
  'datum points and coordinate systems in the exact build',
  { timeout: 120_000 },
  () => {
    let adapter: ExactKernelAdapter;
    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
    });
    const built = (document: ProjectDocument) => adapter.syncDocument(document);

    it('places typed and offset points, and planes, axes and systems built on them', async () => {
      const a = point(blank(), offsetFrom(at(0, 0, 0), '1 + 1', 2, 3), 'A');
      const b = point(
        a.document,
        offsetFrom(pointRef(a.featureId), 0, 0, 5),
        'B'
      );
      const c = point(
        b.document,
        offsetFrom(pointRef(a.featureId), 4, 0, 0),
        'C'
      );
      const plane = addDatumPlane(c.document, {
        name: 'ABC',
        definition: {
          kind: 'three-point',
          points: [
            pointRef(a.featureId),
            pointRef(c.featureId),
            pointRef(b.featureId)
          ]
        }
      });
      const axis = addDatumAxis(plane.document, {
        name: 'AB',
        definition: {
          kind: 'two-point',
          points: [pointRef(a.featureId), pointRef(b.featureId)]
        }
      });
      const system = csys(axis.document, {
        kind: 'three-point',
        points: [
          pointRef(a.featureId),
          pointRef(c.featureId),
          pointRef(b.featureId)
        ]
      });
      const derived = await built(system.document);
      expect(derived.warnings).toEqual([]);
      expectVector(derived.datumPoints?.[a.featureId], [2, 2, 3]);
      expectVector(derived.datumPoints?.[b.featureId], [2, 2, 8]);
      expectVector(derived.datumPoints?.[c.featureId], [6, 2, 3]);
      // u toward C (+X), the normal by the right-hand rule toward B: −Y.
      expectVector(derived.datumFrames?.[plane.featureId]?.normal, [0, -1, 0]);
      expectVector(derived.datumAxes?.[axis.featureId]?.direction, [0, 0, 1]);
      const frame = derived.datumCsys?.[system.featureId];
      expectVector(frame?.origin, [2, 2, 3]);
      expectVector(frame?.x, [1, 0, 0]);
      expectVector(frame?.y, [0, 0, 1]);
      expectVector(frame?.z, [0, -1, 0]);

      // Moving A moves everything built on it.
      const edited = updateFeature(system.document, {
        featureId: a.featureId,
        data: {
          featureKind: 'datum-point',
          definition: offsetFrom(at(0, 0, 0), 2, 2, 10)
        }
      });
      const after = await built(edited);
      expectVector(after.datumPoints?.[b.featureId], [2, 2, 15]);
      expectVector(after.datumCsys?.[system.featureId]?.origin, [2, 2, 10]);
    });

    it('takes the midpoint of a straight edge and the centre of a circle, by lineage', async () => {
      const block = box(blank());
      const post = addPrimitiveFeature(block.document, {
        name: 'Post',
        primitiveKind: 'cylinder',
        dimensions: { radius: 5, height: 20 }
      });
      const postId = post.bodyOrder.at(-1)!;
      const derived = await built(post);
      const straight = edgeReference(
        derived,
        block.bodyId,
        (ends, type) =>
          type === 'line' &&
          ends.every(
            ([x, y]) => Math.abs(x! - 20) < 1e-9 && Math.abs(y!) < 1e-9
          )
      );
      const rim = edgeReference(
        derived,
        postId,
        (_, type) => type === 'circle'
      );
      const mid = point(
        post,
        {
          kind: 'edge-midpoint',
          source: {
            type: 'edge',
            bodyId: block.bodyId,
            edgeReference: straight
          }
        },
        'Mid'
      );
      const centre = point(
        mid.document,
        {
          kind: 'arc-center',
          source: { type: 'edge', bodyId: postId, edgeReference: rim }
        },
        'Centre'
      );
      const wrong = point(
        centre.document,
        {
          kind: 'arc-center',
          source: {
            type: 'edge',
            bodyId: block.bodyId,
            edgeReference: straight
          }
        },
        'Wrong'
      );
      const result = await built(wrong.document);
      expectVector(result.datumPoints?.[mid.featureId], [20, 0, 10]);
      const c = result.datumPoints?.[centre.featureId];
      expect(c).toBeDefined();
      // The rim's centre is on the post's axis.
      expect(Math.hypot(c!.x, c!.y)).toBeLessThan(1e-9);
      expect([0, 20].some((z) => Math.abs(c!.z - z) < 1e-9)).toBe(true);
      expect(result.datumPoints?.[wrong.featureId]).toBeUndefined();
      expect(result.warnings.join('\n')).toMatch(
        /Datum point "Wrong" cannot take the centre of an edge of source feature "Block": the edge is a line, not a circular arc or circle/
      );
    });

    it('pierces a plane with an axis, and refuses a parallel one', async () => {
      const axis = addDatumAxis(blank(), {
        name: 'Up',
        definition: { kind: 'two-point', points: [at(3, 4, 0), at(3, 4, 1)] }
      });
      const level = addDatumPlane(axis.document, {
        name: 'Level',
        definition: { kind: 'offset', source: xy, offset: 5 }
      });
      const pierce = point(
        level.document,
        {
          kind: 'axis-plane',
          axis: { type: 'datum-axis', datumFeatureId: axis.featureId },
          plane: { type: 'datum', datumFeatureId: level.featureId }
        },
        'Pierce'
      );
      const flat = addDatumAxis(pierce.document, {
        name: 'Flat',
        definition: { kind: 'two-point', points: [at(0, 0, 0), at(1, 0, 0)] }
      });
      const parallel = point(
        flat.document,
        {
          kind: 'axis-plane',
          axis: { type: 'datum-axis', datumFeatureId: flat.featureId },
          plane: xy
        },
        'Parallel'
      );
      const derived = await built(parallel.document);
      expectVector(derived.datumPoints?.[pierce.featureId], [3, 4, 5]);
      expect(derived.datumPoints?.[parallel.featureId]).toBeUndefined();
      expect(derived.warnings.join('\n')).toMatch(/runs parallel to it/);
    });

    it('places a system, and builds planes, axes and aligned Moves on it', async () => {
      // At (10, 0, 0), turned 90° about Z: X → +Y, Y → −X.
      const system = csys(
        blank(),
        {
          kind: 'placement',
          origin: at(10, 0, 0),
          rotationDeg: { x: 0, y: 0, z: 90 }
        },
        'Frame'
      );
      const lifted = addDatumPlane(system.document, {
        name: 'Lifted',
        definition: {
          kind: 'offset',
          source: {
            type: 'datum-csys',
            datumFeatureId: system.featureId,
            plane: 'YZ'
          },
          offset: 4
        }
      });
      const axisX = addDatumAxis(lifted.document, {
        name: 'Frame X',
        definition: {
          kind: 'csys-axis',
          csys: csysRef(system.featureId),
          axis: 'X'
        }
      });
      const onPlane = csys(
        axisX.document,
        {
          kind: 'plane',
          source: { type: 'datum', datumFeatureId: lifted.featureId },
          origin: at(0, 0, 7)
        },
        'On plane'
      );
      const block = box(onPlane.document, 2);
      const aligned = transformBody(block.document, {
        name: 'Align',
        targetBodyId: block.bodyId,
        translation: { x: 0, y: 0, z: 0 },
        csysAlign: { to: csysRef(system.featureId) }
      });
      const derived = await built(aligned.document);
      expect(derived.warnings).toEqual([]);
      const frame = derived.datumCsys?.[system.featureId];
      expectVector(frame?.origin, [10, 0, 0]);
      expectVector(frame?.x, [0, 1, 0]);
      expectVector(frame?.y, [-1, 0, 0]);
      expectVector(frame?.z, [0, 0, 1]);
      // YZ's normal is the system's X (+Y world); 4 along it.
      const planeFrame = derived.datumFrames?.[lifted.featureId];
      expectVector(planeFrame?.origin, [10, 4, 0]);
      expectVector(planeFrame?.normal, [0, 1, 0]);
      const axisLine = derived.datumAxes?.[axisX.featureId];
      expectVector(axisLine?.origin, [10, 0, 0]);
      expectVector(axisLine?.direction, [0, 1, 0]);
      // The plane's own frame, origin moved to (0, 0, 7)'s foot on it.
      expectVector(derived.datumCsys?.[onPlane.featureId]?.origin, [0, 4, 7]);
      // The block 0..2 in world lands 0..2 in the system: x 8..10, y 0..2.
      const body = derived.bodyRepresentations[block.bodyId]!;
      expectVector(body.bbox.min, [8, 0, 0], 6);
      expectVector(body.bbox.max, [10, 2, 2], 6);
      expect(body.volume).toBeCloseTo(8, 6);
    });

    it('refuses a consumer of a system or point that failed, by name', async () => {
      const bad = csys(
        blank(),
        {
          kind: 'three-point',
          points: [at(0, 0, 0), at(1, 0, 0), at(2, 0, 0)]
        },
        'Collinear'
      );
      const axis = addDatumAxis(bad.document, {
        name: 'Its X',
        definition: {
          kind: 'csys-axis',
          csys: csysRef(bad.featureId),
          axis: 'X'
        }
      });
      const derived = await built(axis.document);
      expect(derived.datumCsys?.[bad.featureId]).toBeUndefined();
      expect(derived.datumAxes?.[axis.featureId]).toBeUndefined();
      const text = derived.warnings.join('\n');
      expect(text).toMatch(/collinear/);
      expect(text).toMatch(
        /Datum axis "Its X" cannot use coordinate system "Collinear" because it is unavailable/
      );
    });
  }
);
