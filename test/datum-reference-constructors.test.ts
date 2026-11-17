import { beforeAll, describe, expect, it } from 'vitest';
import {
  addDatumAxis,
  addDatumPlane,
  addPrimitiveFeature,
  addSketchFeature,
  addSplitFeature,
  attachDerivedState,
  createProjectDocument,
  deleteFeature,
  findFeature,
  listFeaturesInOrder,
  transformBody,
  extrudeSketch,
  findSketch,
  normalizeDocument,
  resolveParamValue,
  updateFeature
} from '@openzcad/document-core';
import { computeSketchProfileAnalysis } from '@openzcad/geometry';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type DatumAxisEdgeSource,
  type DatumAxisFaceSource,
  type DatumPlaneDefinition,
  type DerivedState,
  type FaceGeometry,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import { CommandManager } from '@openzcad/command-system';
import { datumPlaneEdgeRepairEdit } from '../apps/web/src/lib/datumPlanes';
import { datumPlaneEdgeFailed } from '../apps/web/src/lib/datumPlaneDisplay';

/**
 * R01 reference constructors (schema v108): a datum plane square to an edge
 * (at a fraction along a line or an arc, or through a point), a plane
 * through a straight edge at an angle to a reference plane, and an axis
 * square to a face at a point — the document contract, the exact build with
 * its named refusals, edits, and a Split consuming the new plane.
 */

type V3 = { x: number; y: number; z: number };
const at = (x: number, y: number, z: number) =>
  ({ type: 'point', point: { x, y, z } }) as const;
const xy = { type: 'canonical', plane: 'XY', offset: 0 } as const;
const datum = (datumFeatureId: FeatureId) =>
  ({ type: 'datum', datumFeatureId }) as const;

const sub = (a: V3, b: V3): V3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z
});
const add = (a: V3, b: V3): V3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z
});
const scale = (a: V3, k: number): V3 => ({
  x: a.x * k,
  y: a.y * k,
  z: a.z * k
});
const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x
});
const unit = (a: V3): V3 => scale(a, 1 / Math.hypot(a.x, a.y, a.z));

function blank(): ProjectDocument {
  return createProjectDocument('Reference datums', toUserId('user_datum_refs'));
}

function box(document: ProjectDocument) {
  const next = addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 20, depth: 20 }
  });
  return { document: next, bodyId: next.bodyOrder.at(-1)! };
}

function plane(
  document: ProjectDocument,
  definition: DatumPlaneDefinition,
  name = 'Plane'
) {
  return addDatumPlane(document, { name, definition });
}

/** An open edge of `bodyId` whose ends (end 0 first) `match` accepts. */
function edgeOf(
  derived: DerivedState,
  bodyId: BodyId,
  match: (ends: [V3, V3], curveType: string) => boolean
): { source: DatumAxisEdgeSource; ends: [V3, V3] } {
  for (const edge of derived.bodyRepresentations[bodyId]?.topology?.edges ??
    []) {
    const witness = edge.reference?.witness;
    if (!witness || witness.closed) continue;
    const [a, b] = witness.endpoints.map(([x, y, z]) => ({
      x: x * 1e-6,
      y: y * 1e-6,
      z: z * 1e-6
    }));
    if (match([a!, b!], witness.curveType.toLowerCase()))
      return {
        source: { type: 'edge', bodyId, edgeReference: edge.reference! },
        ends: [a!, b!]
      };
  }
  throw new Error('No such edge.');
}

function faceOf(
  derived: DerivedState,
  bodyId: BodyId,
  match: (geometry: FaceGeometry) => boolean
): DatumAxisFaceSource {
  const face = derived.bodyRepresentations[bodyId]?.topology?.faces.find(
    (candidate) =>
      candidate.reference !== undefined &&
      candidate.geometry !== undefined &&
      match(candidate.geometry)
  );
  expect(face?.reference).toBeDefined();
  return { type: 'face', bodyId, faceReference: face!.reference! };
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

function expectVector(actual: V3 | undefined, expected: V3, digits = 9) {
  expect(actual).toBeDefined();
  expect(actual!.x).toBeCloseTo(expected.x, digits);
  expect(actual!.y).toBeCloseTo(expected.y, digits);
  expect(actual!.z).toBeCloseTo(expected.z, digits);
}

describe('reference constructors in the document (v108)', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  it('round-trips in the current schema and is refused below v108', async () => {
    const block = box(blank());
    const derived = await adapter.syncDocument(block.document);
    const edge = edgeOf(derived, block.bodyId, (_, type) => type === 'line');
    const square = plane(block.document, {
      kind: 'normal-to-edge',
      edge: edge.source,
      at: { fraction: '1 / 4' }
    });
    expect(square.document.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    const saved = JSON.parse(
      JSON.stringify(square.document)
    ) as ProjectDocument;
    expect(normalizeDocument(saved)).toEqual(square.document);
    type Version = typeof PROJECT_DOCUMENT_SCHEMA_VERSION;
    const older = { ...square.document, schemaVersion: 107 as Version };
    expect(() => normalizeDocument(structuredClone(older))).toThrow(
      /require project schema v108/
    );
    expect(() =>
      plane(block.document, {
        kind: 'normal-to-edge',
        edge: edge.source,
        at: { fraction: 1.5 }
      })
    ).toThrow(/fraction from 0 to 1/);
    expect(() =>
      addDatumAxis(block.document, {
        name: 'Nowhere',
        definition: {
          kind: 'face-normal',
          source: {
            ...faceOf(derived, block.bodyId, () => true),
            bodyId: 'body_gone' as BodyId
          },
          point: at(0, 0, 0)
        }
      })
    ).toThrow(/does not exist/);
  });

  it('stands a plane square to a straight edge at a fraction, through a point, and splits by it', async () => {
    const block = box(blank());
    const derived = await adapter.syncDocument(block.document);
    // The vertical edge at x = 20, y = 0.
    const edge = edgeOf(
      derived,
      block.bodyId,
      (ends, type) =>
        type === 'line' &&
        ends.every((end) => near(end.x, 20) && near(end.y, 0))
    );
    const [e0, e1] = edge.ends;
    const along = unit(sub(e1, e0));
    const quarter = plane(
      block.document,
      { kind: 'normal-to-edge', edge: edge.source, at: { fraction: 0.25 } },
      'Quarter'
    );
    const through = plane(
      quarter.document,
      {
        kind: 'normal-to-edge',
        edge: edge.source,
        at: { point: at(5, 5, 7) }
      },
      'Through'
    );
    const split = addSplitFeature(through.document, {
      name: 'Cut',
      targetBodyId: block.bodyId,
      plane: datum(quarter.featureId)
    });
    const result = await adapter.syncDocument(split.document);
    expect(result.warnings).toEqual([]);
    const q = result.datumFrames?.[quarter.featureId];
    expectVector(q?.origin, add(e0, scale(sub(e1, e0), 0.25)));
    expectVector(q?.normal, along);
    const t = result.datumFrames?.[through.featureId];
    expectVector(t?.origin, { x: 5, y: 5, z: 7 });
    expectVector(t?.normal, along);
    // The split at a quarter of the 20 mm edge: 5 and 15 deep.
    const volumes = [split.bodyId, split.secondBodyId]
      .map((id) => result.bodyRepresentations[id]?.volume ?? NaN)
      .sort((a, b) => a - b);
    expect(volumes[0]).toBeCloseTo(20 * 20 * 5, 6);
    expect(volumes[1]).toBeCloseTo(20 * 20 * 15, 6);

    // An edit moves the plane, and the split follows.
    const moved = updateFeature(split.document, {
      featureId: quarter.featureId,
      data: {
        featureKind: 'datum-plane',
        definition: {
          kind: 'normal-to-edge',
          edge: edge.source,
          at: { fraction: 0.5 }
        }
      }
    });
    const after = await adapter.syncDocument(moved);
    expect(after.warnings).toEqual([]);
    expectVector(
      after.datumFrames?.[quarter.featureId]?.origin,
      add(e0, scale(sub(e1, e0), 0.5))
    );
    expect(after.bodyRepresentations[split.bodyId]?.volume).toBeCloseTo(
      20 * 20 * 10,
      6
    );
  });

  it('stands a plane square to an arc, its u toward the centre, and refuses a point on a curved edge', async () => {
    // A quarter disc, radius 10, extruded 5: its rims are open quarter arcs.
    const sketched = addSketchFeature(blank(), {
      name: 'Profile',
      planeRef: xy,
      objects: [
        {
          objectKind: 'arc',
          centerX: 0,
          centerY: 0,
          radius: 10,
          startAngleDeg: 0,
          endAngleDeg: 90
        },
        { objectKind: 'line', x1: 0, y1: 10, x2: 0, y2: 0 },
        { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }
      ]
    });
    const sketch = findSketch(sketched.document, sketched.sketchId)!;
    const [region] = computeSketchProfileAnalysis(
      sketch.objectIds.map((objectId) => {
        const node = sketched.document.nodes[objectId];
        if (node?.kind !== 'sketch-object')
          throw new Error('Expected an object.');
        return { id: node.id, data: node.data };
      }),
      (value) => resolveParamValue(value, {}, 'profile dimension')
    ).profiles;
    const turned = extrudeSketch(sketched.document, {
      name: 'Quarter turn',
      sketchId: sketched.sketchId,
      distance: 5,
      profile: {
        profileId: region!.profileId,
        regionFingerprint: region!.regionFingerprint,
        samplePoint: region!.samplePoint,
        sourceArea: region!.area,
        sourceEntityIds: region!.sourceEntityIds
      }
    }).document;
    const bodyId = turned.bodyOrder.at(-1)!;
    const derived = await adapter.syncDocument(turned);
    expect(derived.warnings).toEqual([]);
    const arc = edgeOf(
      derived,
      bodyId,
      (ends, type) =>
        type === 'circle' &&
        ends.every((end) => near(Math.hypot(end.x, end.y), 10))
    );
    const [e0, e1] = arc.ends;
    const centre = { x: 0, y: 0, z: e0.z };
    const middle = add(
      centre,
      scale(unit(sub(add(e0, e1), scale(centre, 2))), 10)
    );
    const square = plane(turned, {
      kind: 'normal-to-edge',
      edge: arc.source,
      at: { fraction: 0.5 }
    });
    const pointed = plane(
      square.document,
      { kind: 'normal-to-edge', edge: arc.source, at: { point: at(0, 0, 0) } },
      'Pointed'
    );
    const result = await adapter.syncDocument(pointed.document);
    const frame = result.datumFrames?.[square.featureId];
    expectVector(frame?.origin, middle);
    // The tangent there: square to the radius, level, toward end 1.
    expect(dot(frame!.normal, sub(middle, centre))).toBeCloseTo(0, 9);
    expect(frame!.normal.z).toBeCloseTo(0, 9);
    expect(dot(frame!.normal, sub(e1, e0))).toBeGreaterThan(0);
    expectVector(frame?.u, unit(sub(centre, middle)));
    expect(result.datumFrames?.[pointed.featureId]).toBeUndefined();
    expect(result.warnings.join('\n')).toMatch(
      /Datum plane "Pointed" cannot stand square to an edge of source feature "Quarter turn": the edge is a circle; a plane through a point square to an edge needs a straight edge/
    );
  });

  it('turns a plane about a straight edge from a reference plane, and refuses an edge not parallel to it', async () => {
    const block = box(blank());
    const derived = await adapter.syncDocument(block.document);
    // A top edge along X (z = 20, y = 0).
    const edge = edgeOf(
      derived,
      block.bodyId,
      (ends, type) =>
        type === 'line' &&
        ends.every((end) => near(end.z, 20) && near(end.y, 0))
    );
    const vertical = edgeOf(
      derived,
      block.bodyId,
      (ends, type) =>
        type === 'line' &&
        ends.every((end) => near(end.x, 20) && near(end.y, 0))
    );
    const [e0, e1] = edge.ends;
    const u = unit(sub(e1, e0));
    const z = { x: 0, y: 0, z: 1 };
    const flat = plane(
      block.document,
      {
        kind: 'edge-angle',
        edge: edge.source,
        reference: xy,
        angleDeg: 0
      },
      'Flat'
    );
    const tilted = plane(
      flat.document,
      {
        kind: 'edge-angle',
        edge: edge.source,
        reference: xy,
        angleDeg: '30 + 15'
      },
      'Tilted'
    );
    const skew = plane(
      tilted.document,
      {
        kind: 'edge-angle',
        edge: vertical.source,
        reference: xy,
        angleDeg: 10
      },
      'Skew'
    );
    const result = await adapter.syncDocument(skew.document);
    const f = result.datumFrames?.[flat.featureId];
    expectVector(f?.origin, e0);
    expectVector(f?.normal, z);
    expectVector(f?.u, u);
    const t = result.datumFrames?.[tilted.featureId];
    const radians = Math.PI / 4;
    expectVector(
      t?.normal,
      add(scale(z, Math.cos(radians)), scale(cross(u, z), Math.sin(radians)))
    );
    expect(dot(t!.normal, u)).toBeCloseTo(0, 12);
    expect(result.datumFrames?.[skew.featureId]).toBeUndefined();
    expect(result.warnings.join('\n')).toMatch(
      /Datum plane "Skew" cannot turn about an edge of source feature "Block": A plane through an edge at an angle needs an edge parallel to the reference plane/
    );
  });

  it('stands an axis square to a flat and a curved face and at a corner, and refuses a foot off the face', async () => {
    const block = box(blank());
    const post = addPrimitiveFeature(block.document, {
      name: 'Post',
      primitiveKind: 'cylinder',
      dimensions: { radius: 5, height: 20 }
    });
    const postId = post.bodyOrder.at(-1)!;
    const derived = await adapter.syncDocument(post);
    const top = faceOf(
      derived,
      block.bodyId,
      (g) => g.surfaceType.toLowerCase() === 'plane' && near(g.center.z, 20)
    );
    const side = faceOf(
      derived,
      postId,
      (g) => g.surfaceType.toLowerCase() === 'cylinder'
    );
    const up = addDatumAxis(post, {
      name: 'Up',
      definition: { kind: 'face-normal', source: top, point: at(5, 7, 30) }
    });
    const out = addDatumAxis(up.document, {
      name: 'Out',
      definition: { kind: 'face-normal', source: side, point: at(10, 0, 10) }
    });
    // A foot on the face's own corner is on the face.
    const corner = addDatumAxis(out.document, {
      name: 'Corner',
      definition: { kind: 'face-normal', source: top, point: at(20, 20, 30) }
    });
    const off = addDatumAxis(corner.document, {
      name: 'Off',
      definition: { kind: 'face-normal', source: top, point: at(50, 50, 30) }
    });
    const result = await adapter.syncDocument(off.document);
    expectVector(result.datumAxes?.[up.featureId]?.origin, {
      x: 5,
      y: 7,
      z: 20
    });
    expectVector(result.datumAxes?.[up.featureId]?.direction, {
      x: 0,
      y: 0,
      z: 1
    });
    expectVector(result.datumAxes?.[out.featureId]?.origin, {
      x: 5,
      y: 0,
      z: 10
    });
    expectVector(result.datumAxes?.[out.featureId]?.direction, {
      x: 1,
      y: 0,
      z: 0
    });
    expectVector(result.datumAxes?.[corner.featureId]?.origin, {
      x: 20,
      y: 20,
      z: 20
    });
    expect(result.datumAxes?.[off.featureId]).toBeUndefined();
    expect(result.warnings.join('\n')).toMatch(
      /Datum axis "Off" cannot stand square to a face of source feature "Block": the point drops onto the face's surface beyond the face itself/
    );
  });
  it('re-attaches a plane on a lost edge to the edge picked now', async () => {
    let document = box(blank()).document;
    document = addPrimitiveFeature(document, {
      name: 'Second',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 20 }
    });
    const first = document.bodyOrder[0]!;
    const second = document.bodyOrder[1]!;
    document = transformBody(document, {
      name: 'Beside',
      targetBodyId: second,
      translation: { x: 50, y: 0, z: 0 }
    }).document;
    const derived = await adapter.syncDocument(document);
    const upright = (bodyId: BodyId, x: number) =>
      edgeOf(
        derived,
        bodyId,
        (ends, type) =>
          type === 'line' &&
          ends.every((end) => near(end.x, x) && near(end.y, 0))
      );
    const planed = plane(document, {
      kind: 'normal-to-edge',
      edge: upright(first, 20).source,
      at: { fraction: 0.25 }
    });
    // Deleting the first block leaves the plane with no edge.
    const block = listFeaturesInOrder(planed.document).find(
      (feature) => feature.name === 'Block'
    )!;
    const brokenDoc = deleteFeature(planed.document, {
      featureId: block.featureId
    });
    const broken = attachDerivedState(
      brokenDoc,
      await adapter.syncDocument(brokenDoc)
    );
    expect(broken.derived.datumFrames?.[planed.featureId]).toBeUndefined();
    // The build's own failure is what offers the edge re-pick.
    expect(
      datumPlaneEdgeFailed(
        findFeature(broken, planed.featureId)!,
        broken.derived.warnings.map((message) => ({
          featureId: planed.featureId,
          featureName: 'Plane',
          message,
          kind: 'build-failed' as const
        }))
      )
    ).toBe(true);
    const target = broken.derived.bodyRepresentations[
      second
    ]!.topology!.edges.find((edge) => {
      const witness = edge.reference?.witness;
      return (
        witness !== undefined &&
        !witness.closed &&
        witness.curveType.toLowerCase() === 'line' &&
        witness.endpoints.every(
          ([x, y]) => near(x * 1e-6, 70) && near(y * 1e-6, 0)
        )
      );
    })!;
    const edit = datumPlaneEdgeRepairEdit(broken, planed.featureId, {
      bodyId: second,
      kind: 'edge',
      topologyId: target.topologyId,
      hash: target.hash
    });
    expect(edit.label).toBe('Re-pick edge for Plane');
    const manager = new CommandManager(broken);
    manager.execute(edit.command);
    const repaired = await adapter.syncDocument(manager.document);
    expect(() => edit.validateDerived(repaired)).not.toThrow();
    const origin = repaired.datumFrames?.[planed.featureId]?.origin;
    expect(origin?.x).toBeCloseTo(70, 6);
    expect(origin?.y).toBeCloseTo(0, 6);
    expect([5, 15].some((z) => Math.abs(origin!.z - z) < 1e-6)).toBe(true);
  });
});
