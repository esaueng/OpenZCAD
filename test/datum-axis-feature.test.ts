import { beforeAll, describe, expect, it } from 'vitest';
import {
  addDatumAxis,
  addDatumPlane,
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  deleteFeature,
  listFeaturesInOrder,
  normalizeDocument,
  patternBody,
  revolveSketch,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import { commandFactories } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { CURRENT_CANONICAL_BASIS_REVISION } from '@openzcad/geometry';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type DatumAxisDefinition,
  type DatumAxisRef,
  type DerivedState,
  type EdgeTopologyReferenceV5,
  type FaceTopologyReferenceV5,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * R01 datum axes (schema v28): the document contract, the exact build's four
 * constructors with their named refusals, and the three consumers that turn
 * about an axis — revolve, circular pattern and Move.
 */

const xy = { type: 'canonical', plane: 'XY', offset: 0 } as const;
const xz = {
  type: 'canonical',
  plane: 'XZ',
  offset: 0,
  basisRevision: CURRENT_CANONICAL_BASIS_REVISION
} as const;
const yz = { type: 'canonical', plane: 'YZ', offset: 0 } as const;
const at = (x: number | string, y: number | string, z: number | string) =>
  ({ type: 'point', point: { x, y, z } }) as const;
const axisRef = (datumFeatureId: FeatureId): DatumAxisRef => ({
  type: 'datum-axis',
  datumFeatureId
});

function blank(): ProjectDocument {
  return createProjectDocument('Datum axes', toUserId('user_datum_axes'));
}

function withAxis(
  document: ProjectDocument,
  definition: DatumAxisDefinition,
  name = 'Axis'
) {
  return addDatumAxis(document, { name, definition });
}

/** A corner-origin box, 0..w × 0..h × 0..d. */
function box(
  document: ProjectDocument,
  width = 2,
  height = 2,
  depth: number | string = 2
) {
  const next = addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width, height, depth }
  });
  return { document: next, bodyId: next.bodyOrder.at(-1)! };
}

/** A rectangle x 10..14, z 0..6 on XZ, ready to revolve. */
function profile(document: ProjectDocument) {
  return addSketchFeature(document, {
    name: 'Profile',
    planeRef: xz,
    objects: [
      { objectKind: 'rectangle', width: 4, height: 6, centerX: 12, centerY: 3 }
    ]
  });
}

function edgeReference(
  derived: DerivedState,
  bodyId: BodyId,
  match: (ends: number[][]) => boolean
): EdgeTopologyReferenceV5 {
  const edge = derived.bodyRepresentations[bodyId]?.topology?.edges.find(
    (candidate) => {
      const witness = candidate.reference?.witness;
      return (
        witness !== undefined &&
        !witness.closed &&
        match(witness.endpoints.map((end) => end.map((q) => q * 1e-6)))
      );
    }
  );
  expect(edge?.reference).toBeDefined();
  return edge!.reference!;
}

function faceReference(
  derived: DerivedState,
  bodyId: BodyId,
  surfaceType: string
): FaceTopologyReferenceV5 {
  const face = derived.bodyRepresentations[bodyId]?.topology?.faces.find(
    (candidate) =>
      candidate.reference?.witness.surfaceType.toLowerCase() === surfaceType
  );
  expect(face?.reference).toBeDefined();
  return face!.reference!;
}

describe('datum axes in the document (v28)', () => {
  it('is schema 28, additive, and round-trips without rewriting', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBe(32);
    const axis = withAxis(blank(), {
      kind: 'two-point',
      points: [at(0, 0, 0), at(0, 0, '5 + 5')]
    });
    const crossing = withAxis(
      axis.document,
      { kind: 'plane-intersection', sources: [xz, yz], reverseDirection: true },
      'Crossing'
    );
    const saved = JSON.parse(
      JSON.stringify(crossing.document)
    ) as ProjectDocument;
    expect(saved.schemaVersion).toBe(32);
    expect(normalizeDocument(saved)).toEqual(crossing.document);

    // A v26 document opens exactly as written: no axis field is invented.
    type Version = typeof PROJECT_DOCUMENT_SCHEMA_VERSION;
    const sketched = profile(blank());
    const revolved = revolveSketch(sketched.document, {
      name: 'Revolve',
      sketchId: sketched.sketchId,
      axis: 'vertical'
    }).document;
    const legacy = { ...revolved, schemaVersion: 26 as Version };
    const opened = normalizeDocument(structuredClone(legacy));
    expect({ ...opened, schemaVersion: 26 }).toEqual(legacy);
    const feature = listFeaturesInOrder(opened).at(-1)!;
    expect('axisRef' in feature.data).toBe(false);
  });

  it('refuses repeated points, a repeated plane and missing sources', () => {
    expect(() =>
      withAxis(blank(), {
        kind: 'two-point',
        points: [at(1, 2, 3), at(1, 2, 3)]
      })
    ).toThrow(/two different points/);
    expect(() =>
      withAxis(blank(), { kind: 'plane-intersection', sources: [xy, xy] })
    ).toThrow(/two different planes/);
    expect(() =>
      withAxis(blank(), {
        kind: 'plane-intersection',
        sources: [
          xy,
          { type: 'datum', datumFeatureId: 'feat_gone' as FeatureId }
        ]
      })
    ).toThrow(/No datum plane/);
    expect(() =>
      withAxis(blank(), {
        kind: 'cylinder',
        source: {
          type: 'face',
          bodyId: 'body_gone' as BodyId,
          faceReference: {
            kind: 'face',
            producingFeatureId: 'feat_gone' as FeatureId,
            lineageName: 'face:side',
            currentHash: 1,
            witnessVersion: 1,
            witness: {
              surfaceType: 'cylinder',
              perimeter: 1,
              centroid: null,
              analytic: { kind: 'none' },
              closure: { u: 'closed', v: 'open' }
            }
          }
        }
      })
    ).toThrow(/does not exist/);
    expect(() =>
      withAxis(blank(), { kind: 'helix' } as unknown as DatumAxisDefinition)
    ).toThrow(/runs through two points/);
  });

  it('lets consumers turn only about an existing, earlier axis', () => {
    const block = box(blank());
    const axis = withAxis(block.document, {
      kind: 'two-point',
      points: [at(10, 0, 0), at(10, 0, 1)]
    });
    expect(() =>
      commandFactories
        .patternBody({
          name: 'Ring',
          targetBodyId: block.bodyId,
          patternKind: 'circular',
          count: 4,
          axis: 'z',
          axisRef: axisRef('feat_gone' as FeatureId)
        })
        .validate(axis.document)
    ).toThrow(/No datum axis/);
    expect(() =>
      commandFactories
        .patternBody({
          name: 'Row',
          targetBodyId: block.bodyId,
          patternKind: 'linear',
          count: 4,
          axis: 'x',
          axisRef: axisRef(axis.featureId)
        })
        .validate(axis.document)
    ).toThrow(/Only a circular pattern/);

    // A Move placed before the axis cannot turn about it.
    const moved = transformBody(axis.document, {
      name: 'Turn',
      targetBodyId: block.bodyId,
      translation: { x: 0, y: 0, z: 0 },
      axisRotation: { axis: axisRef(axis.featureId), angleDeg: 90 }
    }).document;
    const turn = listFeaturesInOrder(moved).at(-1)!;
    const later = withAxis(moved, {
      kind: 'two-point',
      points: [at(0, 0, 0), at(0, 0, 1)]
    });
    expect(() =>
      updateFeature(later.document, {
        featureId: turn.featureId,
        data: {
          axisRotation: { axis: axisRef(later.featureId), angleDeg: 90 }
        }
      })
    ).toThrow(/comes later in history/);
  });

  it('refuses to delete an axis something turns about, naming it', () => {
    const block = box(blank());
    const axis = withAxis(block.document, {
      kind: 'two-point',
      points: [at(10, 0, 0), at(10, 0, 1)]
    });
    const ringed = patternBody(axis.document, {
      name: 'Ring',
      targetBodyId: block.bodyId,
      patternKind: 'circular',
      count: 4,
      axis: 'z',
      axisRef: axisRef(axis.featureId)
    }).document;
    expect(() => deleteFeature(ringed, { featureId: axis.featureId })).toThrow(
      /Cannot delete datum axis "Axis": Ring turns about it/
    );

    // A datum plane an axis is built from is held the same way.
    const planed = addDatumPlane(blank(), {
      name: 'Lid',
      definition: { kind: 'offset', source: xy, offset: 5 }
    });
    const crossing = withAxis(planed.document, {
      kind: 'plane-intersection',
      sources: [{ type: 'datum', datumFeatureId: planed.featureId }, yz]
    });
    expect(() =>
      deleteFeature(crossing.document, { featureId: planed.featureId })
    ).toThrow(/Cannot delete datum plane "Lid": Axis uses it/);
  });
});

describe('datum axes in the exact build', () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  async function built(document: ProjectDocument) {
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    return derived;
  }

  it('publishes an axis through two expression points', async () => {
    const axis = withAxis(blank(), {
      kind: 'two-point',
      points: [at(1, 2, 3), at(1, '1 + 1', '13')]
    });
    const derived = await built(axis.document);
    expect(derived.datumAxes?.[axis.featureId]).toEqual({
      origin: { x: 1, y: 2, z: 3 },
      direction: { x: 0, y: 0, z: 1 }
    });
  });

  it('meets XZ and YZ along Z, and an offset plane along its line', async () => {
    const crossing = withAxis(blank(), {
      kind: 'plane-intersection',
      sources: [xz, yz]
    });
    const lid = addDatumPlane(crossing.document, {
      name: 'Lid',
      definition: { kind: 'offset', source: xy, offset: 7 }
    });
    const edge = withAxis(
      lid.document,
      {
        kind: 'plane-intersection',
        sources: [{ type: 'datum', datumFeatureId: lid.featureId }, yz]
      },
      'Lid edge'
    );
    const derived = await built(edge.document);
    const z = derived.datumAxes![crossing.featureId]!;
    expect(z.origin.x).toBeCloseTo(0, 12);
    expect(z.origin.y).toBeCloseTo(0, 12);
    expect(z.direction.z).toBeCloseTo(1, 12);
    // XY+7 (normal +Z) meets YZ (normal +X) along +Y, on the line (0, t, 7).
    const lidEdge = derived.datumAxes![edge.featureId]!;
    expect(lidEdge.origin.x).toBeCloseTo(0, 12);
    expect(lidEdge.origin.z).toBeCloseTo(7, 12);
    expect(lidEdge.direction.y).toBeCloseTo(1, 12);
  });

  it('refuses parallel planes by name and publishes no axis', async () => {
    const lid = addDatumPlane(blank(), {
      name: 'Lid',
      definition: { kind: 'offset', source: xy, offset: 7 }
    });
    const parallel = withAxis(
      lid.document,
      {
        kind: 'plane-intersection',
        sources: [xy, { type: 'datum', datumFeatureId: lid.featureId }]
      },
      'Nowhere'
    );
    const derived = await adapter.syncDocument(parallel.document);
    expect(derived.warnings.join('\n')).toMatch(
      /Nowhere.*planes that are not parallel; these are parallel/
    );
    expect(derived.datumAxes?.[parallel.featureId]).toBeUndefined();
  });

  it('refuses points that coincide once evaluated', async () => {
    const axis = withAxis(blank(), {
      kind: 'two-point',
      points: [at(0, 0, 0), at('3 - 3', 0, 0)]
    });
    const derived = await adapter.syncDocument(axis.document);
    expect(derived.warnings.join('\n')).toMatch(/coincide/);
    expect(derived.datumAxes?.[axis.featureId]).toBeUndefined();
  });

  it('runs along a straight edge of a block and follows its edits', async () => {
    const block = box(blank(), 20, 20, 20);
    const derived = await built(block.document);
    // The vertical edge at x = 20, y = 0.
    const reference = edgeReference(derived, block.bodyId, (ends) =>
      ends.every(([x, y]) => Math.abs(x! - 20) < 1e-9 && Math.abs(y!) < 1e-9)
    );
    const axis = withAxis(block.document, {
      kind: 'edge',
      source: { type: 'edge', bodyId: block.bodyId, edgeReference: reference }
    });
    const line = (await built(axis.document)).datumAxes![axis.featureId]!;
    expect(line.origin).toEqual({ x: 20, y: 0, z: 0 });
    expect(line.direction).toEqual({ x: 0, y: 0, z: 1 });

    // Widen the block: the axis follows its edge to x = 30.
    const primitive = listFeaturesInOrder(axis.document)[0]!;
    const wider = updateFeature(axis.document, {
      featureId: primitive.featureId,
      data: {
        featureKind: 'primitive',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 20, depth: 20 }
      }
    });
    const moved = (await built(wider)).datumAxes![axis.featureId]!;
    expect(moved.origin.x).toBeCloseTo(30, 9);
  });

  it('follows a cylinder’s axis and refuses a planar face or curved edge', async () => {
    const cylinder = addPrimitiveFeature(blank(), {
      name: 'Post',
      primitiveKind: 'cylinder',
      dimensions: { radius: 5, height: 20 }
    });
    const bodyId = cylinder.bodyOrder.at(-1)!;
    const derived = await built(cylinder);
    const side = derived.bodyRepresentations[bodyId]!.topology!.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    )!;
    const axis = withAxis(cylinder, {
      kind: 'cylinder',
      source: { type: 'face', bodyId, faceReference: side.reference! }
    });
    const line = (await built(axis.document)).datumAxes![axis.featureId]!;
    const { axisStart, axisEnd } = side.geometry!;
    expect(line.origin.x).toBeCloseTo((axisStart!.x + axisEnd!.x) / 2, 9);
    expect(line.origin.y).toBeCloseTo((axisStart!.y + axisEnd!.y) / 2, 9);
    expect(line.origin.z).toBeCloseTo((axisStart!.z + axisEnd!.z) / 2, 9);
    // Canonical sense: +Z however the surface is parametrised.
    expect(line.direction.z).toBeCloseTo(1, 12);

    const flat = withAxis(
      cylinder,
      {
        kind: 'cylinder',
        source: {
          type: 'face',
          bodyId,
          faceReference: faceReference(derived, bodyId, 'plane')
        }
      },
      'Flat'
    );
    const refused = await adapter.syncDocument(flat.document);
    expect(refused.warnings.join('\n')).toMatch(
      /Datum axis "Flat" cannot follow a face of source feature "Post": the face is a plane, not an exact cylinder or cone/
    );

    const rim = derived.bodyRepresentations[bodyId]!.topology!.edges.find(
      (edge) => edge.reference?.witness.curveType.toLowerCase() === 'circle'
    );
    if (rim?.reference && !rim.reference.witness.closed) {
      const curved = withAxis(
        cylinder,
        {
          kind: 'edge',
          source: { type: 'edge', bodyId, edgeReference: rim.reference }
        },
        'Curved'
      );
      const curvedRefused = await adapter.syncDocument(curved.document);
      expect(curvedRefused.warnings.join('\n')).toMatch(
        /Datum axis "Curved" cannot run along an edge.*not a straight edge/
      );
    }
  });

  it('refuses by name when its source body is gone', async () => {
    const block = box(blank(), 20, 20, 20);
    const derived = await built(block.document);
    const reference = edgeReference(derived, block.bodyId, (ends) =>
      ends.every(([x, y]) => Math.abs(x! - 20) < 1e-9 && Math.abs(y!) < 1e-9)
    );
    const axis = withAxis(
      block.document,
      {
        kind: 'edge',
        source: { type: 'edge', bodyId: block.bodyId, edgeReference: reference }
      },
      'Corner'
    );
    const orphaned = deleteFeature(axis.document, {
      featureId: listFeaturesInOrder(axis.document)[0]!.featureId
    });
    const broken = await adapter.syncDocument(orphaned);
    expect(broken.warnings.join('\n')).toMatch(
      /Datum axis "Corner" cannot use an edge of body .* unavailable/
    );
    expect(broken.datumAxes?.[axis.featureId]).toBeUndefined();
  });

  it('revolves a profile about a datum axis in its plane', async () => {
    const sketched = profile(blank());
    const crossing = withAxis(sketched.document, {
      kind: 'plane-intersection',
      sources: [xz, yz]
    });
    const revolved = revolveSketch(crossing.document, {
      name: 'Ring',
      sketchId: sketched.sketchId,
      axis: 'horizontal',
      axisRef: axisRef(crossing.featureId)
    });
    const derived = await built(revolved.document);
    const ring = derived.bodyRepresentations[revolved.bodyId]!;
    // An annulus of radii 10..14 and height 6 about Z.
    expect(ring.volume).toBeCloseTo(Math.PI * (14 ** 2 - 10 ** 2) * 6, 3);
    expect(ring.bbox.min.x).toBeCloseTo(-14, 6);
    expect(ring.bbox.max.y).toBeCloseTo(14, 6);
    expect(ring.bbox.max.z).toBeCloseTo(6, 6);

    // About x = 20 instead: radii 6..10.
    const offAxis = withAxis(sketched.document, {
      kind: 'two-point',
      points: [at(20, 0, 0), at(20, 0, 10)]
    });
    const offRevolved = revolveSketch(offAxis.document, {
      name: 'Ring',
      sketchId: sketched.sketchId,
      axis: 'horizontal',
      axisRef: axisRef(offAxis.featureId)
    });
    const off = (await built(offRevolved.document)).bodyRepresentations[
      offRevolved.bodyId
    ]!;
    expect(off.volume).toBeCloseTo(Math.PI * (10 ** 2 - 6 ** 2) * 6, 3);
    expect(off.bbox.min.x).toBeCloseTo(10, 6);
    expect(off.bbox.max.x).toBeCloseTo(30, 6);
  });

  it('refuses a revolve about an axis that leaves the sketch plane', async () => {
    const sketched = profile(blank());
    const skew = withAxis(sketched.document, {
      kind: 'two-point',
      points: [at(0, 5, 0), at(0, 5, 10)]
    });
    const revolved = revolveSketch(skew.document, {
      name: 'Ring',
      sketchId: sketched.sketchId,
      axis: 'horizontal',
      axisRef: axisRef(skew.featureId)
    });
    const derived = await adapter.syncDocument(revolved.document);
    expect(derived.warnings.join('\n')).toMatch(
      /does not lie in the plane of sketch "Profile"/
    );
  });

  it('refuses a consumer whose axis failed, naming the axis', async () => {
    const block = box(blank());
    const lid = addDatumPlane(block.document, {
      name: 'Lid',
      definition: { kind: 'offset', source: xy, offset: 7 }
    });
    const parallel = withAxis(
      lid.document,
      {
        kind: 'plane-intersection',
        sources: [xy, { type: 'datum', datumFeatureId: lid.featureId }]
      },
      'Nowhere'
    );
    const ringed = patternBody(parallel.document, {
      name: 'Ring',
      targetBodyId: block.bodyId,
      patternKind: 'circular',
      count: 4,
      axis: 'z',
      axisRef: axisRef(parallel.featureId)
    });
    const derived = await adapter.syncDocument(ringed.document);
    expect(derived.warnings.join('\n')).toMatch(
      /Pattern "Ring" cannot use datum axis "Nowhere" because it is unavailable/
    );
  });

  it('patterns copies about a datum axis through its own origin', async () => {
    const block = box(blank());
    const axis = withAxis(block.document, {
      kind: 'two-point',
      points: [at(10, 0, 0), at(10, 0, 1)]
    });
    const ringed = patternBody(axis.document, {
      name: 'Ring',
      targetBodyId: block.bodyId,
      patternKind: 'circular',
      count: 4,
      axis: 'z',
      angleDeg: 360,
      axisRef: axisRef(axis.featureId)
    });
    const ring = (await built(ringed.document)).bodyRepresentations[
      ringed.bodyId
    ]!;
    expect(ring.volume).toBeCloseTo(4 * 8, 6);
    expect(ring.bbox.min.x).toBeCloseTo(0, 6);
    expect(ring.bbox.max.x).toBeCloseTo(20, 6);
    expect(ring.bbox.min.y).toBeCloseTo(-10, 6);
    expect(ring.bbox.max.y).toBeCloseTo(10, 6);

    // A partial 90° sweep of two: the copy sits a quarter turn on, at y −10..−8.
    const partial = patternBody(axis.document, {
      name: 'Pair',
      targetBodyId: block.bodyId,
      patternKind: 'circular',
      count: 2,
      axis: 'z',
      angleDeg: 90,
      axisRef: axisRef(axis.featureId)
    });
    const pair = (await built(partial.document)).bodyRepresentations[
      partial.bodyId
    ]!;
    expect(pair.bbox.min.y).toBeCloseTo(-10, 6);
    expect(pair.bbox.max.x).toBeCloseTo(10, 6);
  });

  it('turns a Move about a datum axis before its translation', async () => {
    const block = box(blank());
    const axis = withAxis(block.document, {
      kind: 'two-point',
      points: [at(10, 0, 0), at(10, 0, 1)]
    });
    const moved = transformBody(axis.document, {
      name: 'Turn',
      targetBodyId: block.bodyId,
      translation: { x: 0, y: 0, z: 5 },
      axisRotation: { axis: axisRef(axis.featureId), angleDeg: '90 * 2' }
    });
    const turned = (await built(moved.document)).bodyRepresentations[
      block.bodyId
    ]!.bbox;
    expect(turned.min.x).toBeCloseTo(18, 6);
    expect(turned.max.x).toBeCloseTo(20, 6);
    expect(turned.min.y).toBeCloseTo(-2, 6);
    expect(turned.max.y).toBeCloseTo(0, 6);
    expect(turned.min.z).toBeCloseTo(5, 6);

    // Reversing the axis reverses a quarter turn.
    const quarter = (reverseDirection: boolean) => {
      const reversed = withAxis(block.document, {
        kind: 'two-point',
        points: [at(10, 0, 0), at(10, 0, 1)],
        reverseDirection
      });
      return transformBody(reversed.document, {
        name: 'Turn',
        targetBodyId: block.bodyId,
        translation: { x: 0, y: 0, z: 0 },
        axisRotation: { axis: axisRef(reversed.featureId), angleDeg: 90 }
      }).document;
    };
    const forward = (await built(quarter(false))).bodyRepresentations[
      block.bodyId
    ]!.bbox;
    const backward = (await built(quarter(true))).bodyRepresentations[
      block.bodyId
    ]!.bbox;
    expect(forward.min.y).toBeCloseTo(-10, 6);
    expect(backward.max.y).toBeCloseTo(10, 6);
  });

  it('moves every consumer when the axis is edited', async () => {
    const block = box(blank());
    const axis = withAxis(block.document, {
      kind: 'two-point',
      points: [at(10, 0, 0), at(10, 0, 1)]
    });
    const moved = transformBody(axis.document, {
      name: 'Turn',
      targetBodyId: block.bodyId,
      translation: { x: 0, y: 0, z: 0 },
      axisRotation: { axis: axisRef(axis.featureId), angleDeg: 180 }
    });
    await built(moved.document);
    const edited = updateFeature(moved.document, {
      featureId: axis.featureId,
      data: {
        definition: {
          kind: 'two-point',
          points: [at(20, 0, 0), at(20, 0, 1)]
        }
      }
    });
    const turned = (await built(edited)).bodyRepresentations[block.bodyId]!
      .bbox;
    expect(turned.min.x).toBeCloseTo(38, 6);
    expect(turned.max.x).toBeCloseTo(40, 6);
  });
});
