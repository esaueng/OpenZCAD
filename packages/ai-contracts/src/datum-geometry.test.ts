import { describe, expect, it } from 'vitest';
import {
  addDatumAxis,
  addDatumPlane,
  addPrimitiveFeature,
  createProjectDocument,
  findFeature
} from '@openzcad/document-core';
import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  toFeatureId,
  toUserId,
  type EdgeTopologyReferenceV5,
  type FaceTopologyReferenceV5
} from '@openzcad/shared';
import {
  CAD_PATCH_JSON_SCHEMA,
  createCadDocumentDigest,
  describeCadPatchOperation,
  parseCadPatchProposal,
  type CadDatumPlaneSourceV2,
  type CadDocumentDigest
} from './index';

const v = (x: number, y: number, z: number) => ({ x, y, z });
const frame = {
  origin: v(0, 0, 10),
  xAxis: v(1, 0, 0),
  yAxis: v(0, 1, 0),
  zAxis: v(0, 0, 1)
};
const faceReference: FaceTopologyReferenceV5 = {
  kind: 'face',
  producingFeatureId: toFeatureId('feature_source'),
  lineageName: 'source/top',
  currentHash: 101,
  witnessVersion: 1,
  witness: {
    surfaceType: 'plane',
    perimeter: 40_000_000,
    centroid: [0, 0, 10_000_000],
    analytic: { kind: 'plane', normal: [0, 0, 1_000_000], offset: 10_000_000 },
    closure: { u: 'open', v: 'open' }
  }
};
const edgeReference: EdgeTopologyReferenceV5 = {
  kind: 'edge',
  producingFeatureId: toFeatureId('feature_source'),
  lineageName: 'source/edge',
  currentHash: 201,
  witnessVersion: 1,
  witness: {
    curveType: 'LINE',
    length: 10_000_000,
    closed: false,
    endpoints: [
      [0, 0, 10_000_000],
      [10_000_000, 0, 10_000_000]
    ],
    midpoint: [5_000_000, 0, 10_000_000]
  }
};
const sourceFace: Extract<CadDatumPlaneSourceV2, { type: 'face' }> = {
  type: 'face',
  bodyId: 'body_source',
  faceHash: 101,
  faceReference,
  sourceArea: 100.123456,
  sourceCenter: v(5, 0, 10),
  sourceCentroid: v(0, 0, 10),
  sourceNormal: v(0, 0, 1),
  frame
};
const canonical = (plane = 'XY') => ({
  type: 'canonical',
  plane,
  offset: 0,
  datum: null
});
const point = (x: number | string, y: number | string, z: number | string) => ({
  type: 'point' as const,
  point: { x, y, z }
});
const vertex = (end = 0) => ({
  type: 'edge-vertex',
  bodyId: 'body_source',
  edgeReference,
  end
});
const plane = (definition: unknown, localId: string | null = null) => ({
  kind: 'add_datum_plane_v2',
  name: 'Plane',
  localId,
  definition
});
const axis = (definition: unknown, localId: string | null = null) => ({
  kind: 'add_datum_axis',
  name: 'Axis',
  localId,
  definition
});
const proposal = (operations: unknown[]) => ({
  proposalId: 'datum_geometry',
  summary: 'Qualified datums',
  assumptions: [],
  operations
});
const clone = <T>(value: T): T => structuredClone(value);

function digest(): CadDocumentDigest {
  return {
    schemaVersion: 30,
    projectId: 'project_datum',
    name: 'Datum context',
    units: 'mm',
    version: 7,
    parameters: [],
    features: [],
    warnings: [],
    bodies: [
      {
        bodyId: 'body_source',
        name: 'Source',
        consumed: false,
        volume: 1000,
        bbox: { min: v(0, 0, 0), max: v(10, 10, 10) },
        topology: {
          faceCount: 1,
          edgeCount: 1,
          modifierEdgeCount: 1,
          faceInventoryComplete: true,
          edgeInventoryComplete: true,
          faces: [
            {
              topologyId: 'face_top',
              hash: 101,
              reference: clone(faceReference),
              snapshot: {
                surfaceType: 'plane',
                area: sourceFace.sourceArea,
                center: sourceFace.sourceCenter,
                centroid: sourceFace.sourceCentroid,
                normal: sourceFace.sourceNormal
              },
              attachmentFrame: clone(frame)
            }
          ],
          edges: [
            {
              topologyId: 'edge_1',
              hash: 201,
              reference: clone(edgeReference),
              modelingRole: 'edge',
              modifierCandidate: true
            }
          ]
        }
      }
    ]
  };
}

describe('R01 AI datum geometry contract', () => {
  it('keeps the legacy plane wire schema unchanged while adding strict geometry variants', () => {
    const variants = CAD_PATCH_JSON_SCHEMA.properties.operations.items.anyOf;
    const legacy = variants.find(
      (entry) => entry.properties.kind.const === 'add_datum_plane'
    )!;
    if (!('definition' in legacy.properties))
      throw new Error('The legacy datum operation lost its definition schema.');
    expect(legacy.properties.definition).toMatchObject({
      properties: {
        kind: { enum: ['offset', 'midplane'] },
        source: {
          anyOf: [
            { properties: { type: { enum: ['canonical', 'datum'] } } },
            { type: 'null' }
          ]
        }
      },
      required: ['kind', 'source', 'sources', 'offset', 'reverseNormal']
    });
    const walk = (schema: unknown) => {
      if (!schema || typeof schema !== 'object') return;
      const object = schema as Record<string, unknown>;
      if (object.type === 'object') {
        expect(object.additionalProperties).toBe(false);
        expect(object.required).toEqual(
          Object.keys(object.properties as object)
        );
      }
      Object.values(object).forEach((child) =>
        Array.isArray(child) ? child.forEach(walk) : walk(child)
      );
    };
    for (const entry of variants.filter((entry) =>
      [
        'add_datum_plane_v2',
        'update_datum_plane',
        'add_datum_axis',
        'update_datum_axis',
        'add_datum_revolve',
        'add_datum_pattern',
        'add_datum_transform'
      ].includes(entry.properties.kind.const)
    ))
      walk(entry);
  });

  it('parses all four planes and four axes without changing raw point expressions or direction flags', () => {
    const definitions = [
      {
        kind: 'offset',
        source: sourceFace,
        offset: '-lift / 2',
        reverseNormal: true
      },
      {
        kind: 'midplane',
        sources: [canonical(), sourceFace],
        reverseNormal: null
      },
      {
        kind: 'three-point',
        points: [vertex(), point('side / 2', 0, 0), point(0, 10, 0)],
        reverseNormal: true
      },
      {
        kind: 'parallel-point',
        source: sourceFace,
        point: point(0, 0, 'height'),
        reverseNormal: false
      }
    ];
    const cylinders = digest();
    const face = cylinders.bodies![0]!.topology!.faces[0]!;
    face.snapshot!.surfaceType = 'cone';
    face.reference!.witness.surfaceType = 'cone';
    face.reference!.witness.analytic = { kind: 'none' };
    const axes = [
      {
        kind: 'two-point',
        points: [vertex(0), vertex(1)],
        reverseDirection: true
      },
      {
        kind: 'edge',
        source: { type: 'edge', bodyId: 'body_source', edgeReference },
        reverseDirection: false
      },
      {
        kind: 'cylinder',
        source: {
          type: 'face',
          bodyId: 'body_source',
          faceReference: face.reference
        },
        reverseDirection: true
      },
      {
        kind: 'plane-intersection',
        sources: [canonical('XY'), canonical('YZ')],
        reverseDirection: null
      }
    ];
    const parsed = parseCadPatchProposal(
      proposal(definitions.map((definition) => plane(definition))),
      digest()
    );
    expect(parsed.operations[0]).toMatchObject({
      definition: { offset: '-lift / 2', reverseNormal: true }
    });
    expect(parsed.operations[2]).toMatchObject({
      definition: {
        points: [vertex(), point('side / 2', 0, 0), point(0, 10, 0)]
      }
    });
    const parsedAxes = parseCadPatchProposal(
      proposal(axes.map((definition) => axis(definition))),
      cylinders
    );
    expect(
      parsedAxes.operations.map(
        (operation) => 'definition' in operation && operation.definition.kind
      )
    ).toEqual(['two-point', 'edge', 'cylinder', 'plane-intersection']);
    for (const operation of [...parsed.operations, ...parsedAxes.operations])
      expect(describeCadPatchOperation(operation)).toBeTruthy();
  });

  it('keeps plane, axis, sketch and body aliases typed and ordered across creation, updates and consumers', () => {
    const operations = [
      {
        kind: 'add_sketch',
        name: 'Profile',
        localId: 'profile',
        plane: 'XY',
        offset: 0,
        objects: [{ objectKind: 'circle', radius: 2, centerX: 5, centerY: 0 }]
      },
      plane({ kind: 'offset', source: canonical(), offset: 2 }, 'plane'),
      axis(
        {
          kind: 'plane-intersection',
          sources: [{ type: 'datum', datum: '$plane' }, canonical('YZ')]
        },
        'axis'
      ),
      {
        kind: 'update_datum_plane',
        featureId: '$plane',
        definition: {
          kind: 'parallel-point',
          source: canonical(),
          point: point(0, 0, 'top')
        }
      },
      {
        kind: 'update_datum_axis',
        featureId: '$axis',
        definition: {
          kind: 'two-point',
          points: [point(0, 0, 0), point(0, 0, 10)],
          reverseDirection: true
        }
      },
      {
        kind: 'add_datum_revolve',
        name: 'Revolve',
        localId: 'turned',
        sketchId: '$profile',
        datum: '$axis',
        angleDeg: 'turn'
      },
      {
        kind: 'add_datum_pattern',
        name: 'Pattern',
        localId: 'ring',
        targetBodyId: '$turned',
        datum: '$axis',
        count: 3,
        angleDeg: 360
      },
      {
        kind: 'add_datum_transform',
        name: 'Move',
        targetBodyId: '$ring',
        datum: '$axis',
        angleDeg: '-turn',
        translation: v(1, 2, 3)
      }
    ];
    expect(
      parseCadPatchProposal(proposal(operations), digest()).operations
    ).toHaveLength(8);
    for (const [index, replacement] of [
      [5, { ...operations[5], datum: '$plane' }],
      [3, { ...operations[3], featureId: '$axis' }],
      [2, { ...operations[2], localId: 'plane' }],
      [5, { ...operations[5], sketchId: '$axis' }]
    ] as const) {
      const changed = clone(operations);
      changed[index] = replacement as (typeof changed)[number];
      expect(() => parseCadPatchProposal(proposal(changed))).toThrow(
        /earlier|Duplicate|before/
      );
    }
    expect(() =>
      parseCadPatchProposal(proposal([operations[2], operations[1]]))
    ).toThrow(/before/);
  });

  it('refuses malformed, contradictory, closed-edge and same-proposal topology sources before compilation', () => {
    const closed: EdgeTopologyReferenceV5 = {
      ...edgeReference,
      witness: {
        curveType: 'CIRCLE',
        length: 10,
        closed: true,
        center: [0, 0, 0],
        axis: [0, 0, 1]
      }
    };
    for (const definition of [
      {
        kind: 'three-point',
        points: [point(NaN, 0, 0), point(1, 0, 0), point(0, 1, 0)]
      },
      { kind: 'three-point', points: [point(0, 0, 0), point(1, 0, 0)] },
      {
        kind: 'parallel-point',
        source: canonical(),
        point: { ...vertex(), end: 2 }
      },
      {
        kind: 'parallel-point',
        source: canonical(),
        point: { ...vertex(), edgeReference: closed }
      },
      {
        kind: 'parallel-point',
        source: canonical(),
        point: { ...vertex(), bodyId: '$newBody' }
      },
      {
        kind: 'offset',
        source: { ...sourceFace, sourceCentroid: null },
        offset: 2
      },
      {
        kind: 'offset',
        source: sourceFace,
        offset: 2,
        points: [point(0, 0, 0)]
      },
      { kind: 'offset', source: sourceFace, offset: 2, reverseNormal: 'yes' }
    ])
      expect(() =>
        parseCadPatchProposal(proposal([plane(definition)]))
      ).toThrow();
    expect(() =>
      parseCadPatchProposal(
        proposal([
          axis({
            kind: 'edge',
            source: {
              type: 'edge',
              bodyId: 'body_source',
              edgeReference: {
                ...edgeReference,
                witness: {
                  ...edgeReference.witness,
                  curveType: 'BSPLINE_CURVE'
                }
              }
            }
          })
        ])
      )
    ).toThrow(/straight edge/);
  });

  it('binds face geometry and edge identities exactly and refuses invented or ambiguous sources', () => {
    const faceProposal = proposal([
      plane({ kind: 'offset', source: clone(sourceFace), offset: 2 })
    ]);
    const vertexProposal = proposal([
      axis({ kind: 'two-point', points: [vertex(), point(0, 0, 0)] })
    ]);
    expect(parseCadPatchProposal(clone(faceProposal), digest())).toBeTruthy();
    expect(parseCadPatchProposal(clone(vertexProposal), digest())).toBeTruthy();
    for (const property of [
      'sourceArea',
      'sourceCenter',
      'sourceCentroid',
      'sourceNormal',
      'frame'
    ] as const) {
      const changed = clone(sourceFace);
      if (property === 'sourceArea') changed.sourceArea += 0.000001;
      else if (property === 'frame') changed.frame.origin.x += 0.000001;
      else changed[property].x += 0.000001;
      expect(() =>
        parseCadPatchProposal(
          proposal([plane({ kind: 'offset', source: changed, offset: 2 })]),
          digest()
        )
      ).toThrow(/snapshot|centroid|attachmentFrame/);
    }
    for (const mutate of [
      (value: CadDocumentDigest) => {
        value.bodies![0]!.consumed = true;
      },
      (value: CadDocumentDigest) => {
        value.bodies![0]!.topology!.faces.push(
          clone(value.bodies![0]!.topology!.faces[0]!)
        );
      },
      (value: CadDocumentDigest) => {
        value.bodies![0]!.topology!.faces[0]!.reference!.lineageName =
          'invented';
      }
    ]) {
      const current = digest();
      mutate(current);
      expect(() => parseCadPatchProposal(clone(faceProposal), current)).toThrow(
        /unique|stale|unavailable|ambiguous/
      );
    }
    for (const mutate of [
      (value: CadDocumentDigest) => {
        value.bodies![0]!.topology!.edges.push(
          clone(value.bodies![0]!.topology!.edges[0]!)
        );
      },
      (value: CadDocumentDigest) => {
        value.bodies![0]!.topology!.edges[0]!.reference!.witness.length++;
      },
      (value: CadDocumentDigest) => {
        delete value.bodies![0]!.topology!.edges[0]!.reference;
      }
    ]) {
      const current = digest();
      mutate(current);
      expect(() =>
        parseCadPatchProposal(clone(vertexProposal), current)
      ).toThrow(/unique|stale|unavailable|ambiguous/);
    }
  });

  it('allows unresolved update targets, but refuses wrong-kind, suppressed and unresolved source datums', () => {
    const current = digest();
    current.features.push({
      featureId: 'plane_old',
      name: 'Old plane',
      featureKind: 'datum-plane',
      bodyId: null,
      suppressed: false,
      data: {
        featureKind: 'datum-plane',
        definition: { kind: 'offset', source: canonical(), offset: 0 }
      },
      datum: { kind: 'plane', status: 'unresolved' }
    });
    const use = plane({
      kind: 'offset',
      source: { type: 'datum', datum: 'plane_old' },
      offset: 2
    });
    expect(() => parseCadPatchProposal(proposal([use]), current)).toThrow(
      /unresolved/
    );
    const update = {
      kind: 'update_datum_plane',
      featureId: 'plane_old',
      definition: { kind: 'offset', source: canonical(), offset: 3 }
    };
    expect(
      parseCadPatchProposal(proposal([update, use]), current).operations
    ).toHaveLength(2);
    expect(() =>
      parseCadPatchProposal(
        proposal([
          {
            ...update,
            kind: 'update_datum_axis',
            definition: {
              kind: 'two-point',
              points: [point(0, 0, 0), point(0, 0, 1)]
            }
          }
        ]),
        current
      )
    ).toThrow(/not a datum-axis/);
    current.features[0]!.suppressed = true;
    expect(() => parseCadPatchProposal(proposal([update]), current)).toThrow(
      /suppressed/
    );
  });

  it('retains only the target’s verbatim historical sources when a later operation consumed their body', () => {
    const current = digest();
    current.bodies![0]!.consumed = true;
    delete current.bodies![0]!.topology;
    current.features.push({
      featureId: 'plane_old',
      name: 'Earlier face plane',
      featureKind: 'datum-plane',
      bodyId: null,
      suppressed: false,
      data: {
        featureKind: 'datum-plane',
        definition: { kind: 'offset', source: clone(sourceFace), offset: 1 }
      },
      datum: { kind: 'plane', status: 'resolved' }
    });
    const update = (source: unknown) => ({
      kind: 'update_datum_plane',
      featureId: 'plane_old',
      definition: {
        kind: 'offset',
        source,
        offset: 'distance / 2',
        reverseNormal: true
      }
    });
    expect(
      parseCadPatchProposal(proposal([update(clone(sourceFace))]), current)
        .operations[0]
    ).toMatchObject({
      definition: { offset: 'distance / 2', reverseNormal: true }
    });
    expect(() =>
      parseCadPatchProposal(
        proposal([
          plane({ kind: 'offset', source: clone(sourceFace), offset: 2 })
        ]),
        current
      )
    ).toThrow(/unique|unavailable/);
    expect(() =>
      parseCadPatchProposal(
        proposal([
          update({ ...sourceFace, sourceArea: sourceFace.sourceArea + 1 })
        ]),
        current
      )
    ).toThrow(/unique|unavailable/);
    current.features.push({
      featureId: 'axis_old',
      name: 'Earlier vertex axis',
      featureKind: 'datum-axis',
      bodyId: null,
      suppressed: false,
      data: {
        featureKind: 'datum-axis',
        definition: { kind: 'two-point', points: [vertex(0), vertex(1)] }
      },
      datum: { kind: 'axis', status: 'resolved' }
    });
    expect(
      parseCadPatchProposal(
        proposal([
          {
            kind: 'update_datum_axis',
            featureId: 'axis_old',
            definition: {
              kind: 'two-point',
              points: [vertex(0), vertex(1)],
              reverseDirection: true
            }
          }
        ]),
        current
      ).operations
    ).toHaveLength(1);
    expect(() =>
      parseCadPatchProposal(
        proposal([
          {
            kind: 'update_datum_axis',
            featureId: 'axis_old',
            definition: {
              kind: 'two-point',
              points: [
                vertex(0),
                {
                  ...vertex(1),
                  edgeReference: { ...edgeReference, lineageName: 'invented' }
                }
              ]
            }
          }
        ]),
        current
      )
    ).toThrow(/unique|unavailable/);
  });

  it('publishes exact edge identities and current datum status without reusing suppressed or absent results', () => {
    let document = addPrimitiveFeature(
      createProjectDocument('Digest', toUserId('user_ai')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      }
    );
    const bodyId = document.bodyOrder[0]!;
    const newPlane = addDatumPlane(document, {
      name: 'Plane',
      definition: {
        kind: 'offset',
        source: { type: 'canonical', plane: 'XY', offset: 0 },
        offset: 10
      }
    });
    const newAxis = addDatumAxis(newPlane.document, {
      name: 'Axis',
      definition: {
        kind: 'two-point',
        points: [point(0, 0, 0), point(0, 0, 1)]
      }
    });
    document = newAxis.document;
    document.derived.datumFrames = {
      [newPlane.featureId]: {
        origin: v(0, 0, 10),
        u: v(1, 0, 0),
        v: v(0, 1, 0),
        normal: v(0, 0, 1)
      }
    };
    document.derived.datumAxes = {
      [newAxis.featureId]: { origin: v(0, 0, 0), direction: v(0, 0, 1) }
    };
    document.derived.bodyRepresentations[bodyId] = {
      bodyId,
      name: 'Box',
      source: 'primitive',
      mesh: {
        kind: 'mesh',
        vertices: Float32Array.from([]),
        indices: Uint32Array.from([])
      },
      color: '#888888',
      faceCount: 0,
      exportableStep: true,
      consumed: false,
      volume: 1000,
      bbox: { min: v(0, 0, 0), max: v(10, 10, 10) },
      topology: {
        faces: [],
        edges: [
          {
            topologyId: 'edge_1',
            hash: 201,
            reference: clone(edgeReference),
            points: [0, 0, 10, 10, 0, 10]
          }
        ]
      }
    };
    const first = createCadDocumentDigest(document);
    expect(first.bodies![0]!.topology!.edges[0]!.reference).toEqual(
      edgeReference
    );
    expect(
      first.features.find((feature) => feature.featureId === newPlane.featureId)
        ?.datum
    ).toMatchObject({
      kind: 'plane',
      status: 'resolved',
      frame: document.derived.datumFrames[newPlane.featureId]
    });
    expect(
      first.features.find((feature) => feature.featureId === newAxis.featureId)
        ?.datum
    ).toMatchObject({
      kind: 'axis',
      status: 'resolved',
      axis: document.derived.datumAxes[newAxis.featureId]
    });
    const topology = document.derived.bodyRepresentations[bodyId].topology!;
    topology.edges = Array.from({ length: 70 }, (_, index) => ({
      topologyId: `edge_${index}`,
      hash: 201 + index,
      reference: {
        ...clone(edgeReference),
        currentHash: 201 + index,
        lineageName: `source/edge_${index}`
      },
      points: [0, 0, 10, 10, 0, 10]
    }));
    const selected = createCadDocumentDigest(document, {
      kind: 'edge',
      bodyId,
      topologyId: 'edge_69',
      hash: 270
    });
    expect(selected.bodies![0]!.topology!.edges).toHaveLength(64);
    expect(selected.bodies![0]!.topology!.edgeInventoryComplete).toBe(false);
    expect(selected.bodies![0]!.topology!.edges[0]!.reference).toEqual(
      topology.edges[69]!.reference
    );
    findFeature(document, newPlane.featureId)!.metadata = {
      [FEATURE_SUPPRESSED_METADATA_KEY]: true
    };
    delete document.derived.datumAxes[newAxis.featureId];
    document.derived.bodyRepresentations[
      bodyId
    ].topology!.edges[0]!.reference!.currentHash = 999;
    const changed = createCadDocumentDigest(document);
    expect(
      changed.features.find(
        (feature) => feature.featureId === newPlane.featureId
      )?.datum
    ).toEqual({ kind: 'plane', status: 'suppressed' });
    expect(
      changed.features.find(
        (feature) => feature.featureId === newAxis.featureId
      )?.datum
    ).toEqual({ kind: 'axis', status: 'unresolved' });
    expect(changed.bodies![0]!.topology!.edges[0]!.reference).toBeUndefined();
  });
});
