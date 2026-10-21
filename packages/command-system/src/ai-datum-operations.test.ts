import { describe, expect, it } from 'vitest';
import {
  addDatumAxis,
  addDatumPlane,
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  findFeature,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  deepClone,
  FEATURE_SUPPRESSED_METADATA_KEY,
  toUserId,
  type EdgeTopologyReferenceV5,
  type FacePlaneSource,
  type FaceTopologyReferenceV5
} from '@openzcad/shared';
import type {
  CadDatumPlaneDefinitionV2,
  CadPatchOperation,
  CadPatchProposal
} from '@openzcad/ai-contracts';
import { CommandManager, commandsForCadPatch, replayCommands } from './index';

const v = (x: number, y: number, z: number) => ({ x, y, z });
const point = (x: number | string, y: number | string, z: number | string) => ({
  type: 'point' as const,
  point: { x, y, z }
});
const xy = { type: 'canonical' as const, plane: 'XY' as const, offset: 0 };
const proposal = (operations: CadPatchOperation[]): CadPatchProposal => ({
  proposalId: 'r01_compiler',
  summary: 'Create and edit named construction geometry.',
  assumptions: [],
  operations
});

function fixture() {
  let document = createProjectDocument(
    'AI datum compiler',
    toUserId('user_test')
  );
  for (const name of ['Source', 'Other'])
    document = addPrimitiveFeature(document, {
      name,
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
  const [bodyId, otherBodyId] = document.bodyOrder;
  const producingFeatureId = listFeaturesInOrder(document)[0]!.featureId;
  const edgeReference: EdgeTopologyReferenceV5 = {
    kind: 'edge',
    producingFeatureId,
    lineageName: 'source/edge:vertical',
    currentHash: 102,
    witnessVersion: 1,
    witness: {
      curveType: 'line',
      length: 10_000_000,
      closed: false,
      endpoints: [
        [0, 0, 0],
        [0, 0, 10_000_000]
      ],
      midpoint: [0, 0, 5_000_000]
    }
  };
  const faceReference: FaceTopologyReferenceV5 = {
    kind: 'face',
    producingFeatureId,
    lineageName: 'source/face:top',
    currentHash: 101,
    witnessVersion: 1,
    witness: {
      surfaceType: 'plane',
      perimeter: 40_000_000,
      centroid: [5_000_000, 5_000_000, 10_000_000],
      analytic: {
        kind: 'plane',
        normal: [0, 0, 1_000_000_000],
        offset: 10_000_000
      },
      closure: { u: 'open', v: 'open' }
    }
  };
  const face: FacePlaneSource = {
    type: 'face',
    bodyId: bodyId!,
    faceHash: 101,
    faceReference,
    sourceArea: 100,
    sourceCenter: v(5, 5, 10),
    sourceCentroid: v(5, 5, 10),
    sourceNormal: v(0, 0, 1),
    frame: {
      origin: v(5, 5, 10),
      xAxis: v(1, 0, 0),
      yAxis: v(0, 1, 0),
      zAxis: v(0, 0, 1)
    }
  };
  document.derived.bodyRepresentations[bodyId!] = {
    bodyId: bodyId!,
    name: 'Source',
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: new Float32Array(),
      indices: new Uint32Array()
    },
    faceCount: 6,
    color: '#cccccc',
    exportableStep: true,
    consumed: false,
    volume: 1000,
    bbox: { min: v(0, 0, 0), max: v(10, 10, 10) },
    topology: {
      faces: [
        {
          topologyId: 'face_top',
          hash: 101,
          reference: faceReference,
          triangleStart: 0,
          triangleCount: 0,
          geometry: {
            surfaceType: 'plane',
            area: 100,
            center: v(5, 5, 10),
            centroid: v(5, 5, 10),
            normal: v(0, 0, 1)
          }
        }
      ],
      edges: [
        {
          topologyId: 'edge_vertical',
          hash: 102,
          reference: edgeReference,
          points: [0, 0, 0, 0, 0, 10]
        }
      ]
    }
  };
  return {
    document,
    bodyId: bodyId!,
    otherBodyId: otherBodyId!,
    face,
    edgeReference
  };
}

const plane = (localId = 'plane'): CadPatchOperation => ({
  kind: 'add_datum_plane_v2',
  name: 'Point plane',
  localId,
  definition: {
    kind: 'three-point',
    points: [point('1 in', 0, 0), point(0, 2, 0), point(0, 0, 3)],
    reverseNormal: true
  }
});
const axis = (localId = 'axis'): CadPatchOperation => ({
  kind: 'add_datum_axis',
  name: 'Axis',
  localId,
  definition: {
    kind: 'two-point',
    points: [point(0, 0, 0), point(0, 0, '1 in')],
    reverseDirection: true
  }
});

describe('R01 AI datum compiler', () => {
  it('lowers all new operation kinds to ordinary commands with typed IDs and one undoable transaction', () => {
    const { document, bodyId, face } = fixture();
    const operations: CadPatchOperation[] = [
      plane(),
      axis(),
      {
        kind: 'update_datum_plane',
        featureId: '$plane',
        definition: {
          kind: 'parallel-point',
          source: xy,
          point: point(0, 0, '2 in'),
          reverseNormal: false
        }
      },
      {
        kind: 'update_datum_axis',
        featureId: '$axis',
        definition: {
          kind: 'plane-intersection',
          sources: [xy, { type: 'canonical', plane: 'YZ', offset: '1 mm' }],
          reverseDirection: false
        }
      },
      {
        kind: 'add_datum_plane_v2',
        name: 'Face plane',
        localId: 'face',
        definition: { kind: 'offset', source: face, offset: '1 mm' }
      },
      {
        kind: 'add_datum_sketch',
        name: 'Profile',
        localId: 'profile',
        datum: '$plane',
        objects: [{ objectKind: 'circle', centerX: 0, centerY: 4, radius: 1 }]
      },
      {
        kind: 'add_datum_revolve',
        name: 'Turned',
        localId: 'turned',
        sketchId: '$profile',
        datum: '$axis',
        angleDeg: '180'
      },
      {
        kind: 'add_datum_transform',
        name: 'Move',
        targetBodyId: bodyId,
        datum: '$axis',
        angleDeg: '90',
        translation: { x: '1 mm', y: 0, z: 0 }
      },
      {
        kind: 'add_datum_pattern',
        name: 'Copies',
        localId: 'copies',
        targetBodyId: '$turned',
        datum: '$axis',
        count: '2 + 2',
        angleDeg: '360'
      }
    ];
    const commands = commandsForCadPatch(document, proposal(operations));
    expect(commands.map((command) => command.kind)).toEqual([
      'feature.datum-plane',
      'feature.datum-axis',
      'feature.update',
      'feature.update',
      'feature.datum-plane',
      'sketch.add',
      'feature.revolve',
      'feature.transform',
      'feature.pattern'
    ]);
    const manager = new CommandManager(document);
    manager.runTransaction('AI construction geometry', commands);
    const changed = listFeaturesInOrder(manager.document);
    const authoredPlane = changed.find(
      (feature) => feature.name === 'Point plane'
    )!;
    const authoredAxis = changed.find((feature) => feature.name === 'Axis')!;
    expect(authoredPlane.data).toMatchObject({
      definition: {
        kind: 'parallel-point',
        point: point(0, 0, '2 in'),
        reverseNormal: false
      }
    });
    expect(authoredAxis.data).toMatchObject({
      definition: { kind: 'plane-intersection', reverseDirection: false }
    });
    for (const feature of changed.filter((item) =>
      ['revolve', 'pattern'].includes(item.data.featureKind)
    ))
      expect(feature.data).toMatchObject({
        axisRef: { type: 'datum-axis', datumFeatureId: authoredAxis.featureId }
      });
    expect(
      changed.find((feature) => feature.name === 'Move')!.data
    ).toMatchObject({
      axisRotation: { axis: { datumFeatureId: authoredAxis.featureId } },
      transform: { translation: { x: '1 mm', y: 0, z: 0 } }
    });
    const serialized = commands.map((command) => command.serialize());
    expect(
      listFeaturesInOrder(replayCommands(document, serialized)).map(
        (feature) => feature.data
      )
    ).toEqual(changed.map((feature) => feature.data));
    manager.undo();
    expect(manager.document.nodes).toEqual(document.nodes);
    manager.redo();
    expect(
      listFeaturesInOrder(manager.document).map((feature) => feature.data)
    ).toEqual(changed.map((feature) => feature.data));
  });

  it('refuses forward, wrong-kind and suppressed datum targets without touching the document', () => {
    const { document } = fixture();
    const before = deepClone(document);
    const consumer = (datum: string): CadPatchOperation => ({
      kind: 'add_datum_transform',
      name: 'Move',
      targetBodyId: document.bodyOrder[0]!,
      datum,
      angleDeg: 45,
      translation: v(0, 0, 0)
    });
    for (const operations of [
      [consumer('$axis'), axis()],
      [plane(), consumer('$plane')],
      [
        axis(),
        {
          kind: 'update_datum_plane',
          featureId: '$axis',
          definition: { kind: 'offset', source: xy, offset: 1 }
        }
      ],
      [consumer(listFeaturesInOrder(document)[0]!.featureId)]
    ] as CadPatchOperation[][])
      expect(() => commandsForCadPatch(document, proposal(operations))).toThrow(
        /not declared|not a datum/
      );
    const datum = addDatumAxis(document, {
      name: 'Suppressed axis',
      definition: {
        kind: 'two-point',
        points: [point(0, 0, 0), point(0, 0, 1)]
      }
    });
    findFeature(datum.document, datum.featureId)!.metadata = {
      [FEATURE_SUPPRESSED_METADATA_KEY]: true
    };
    expect(() =>
      commandsForCadPatch(datum.document, proposal([consumer(datum.featureId)]))
    ).toThrow(/suppressed/);
    expect(document).toEqual(before);
  });

  it('enforces global alias uniqueness even when typed callers bypass the parser', () => {
    const { document } = fixture();
    for (const operations of [
      [plane('same'), axis('same')],
      [
        axis('same'),
        {
          kind: 'add_sketch',
          name: 'Sketch',
          localId: 'same',
          plane: 'XY',
          offset: 0,
          objects: []
        }
      ],
      [
        plane('same'),
        {
          kind: 'add_primitive',
          name: 'Block',
          localId: 'same',
          primitiveKind: 'box',
          dimensions: { width: 1, height: 1, depth: 1 }
        }
      ]
    ] as CadPatchOperation[][])
      expect(() => commandsForCadPatch(document, proposal(operations))).toThrow(
        /Duplicate localId/
      );
  });

  it('requires unique current topology and refuses aliases, stale witnesses and duplicate identities', () => {
    const { document, face, edgeReference } = fixture();
    const operation = (source = face): CadPatchOperation => ({
      kind: 'add_datum_plane_v2',
      name: 'Face plane',
      definition: { kind: 'offset', source, offset: 1 }
    });
    expect(commandsForCadPatch(document, proposal([operation()]))).toHaveLength(
      1
    );
    expect(
      commandsForCadPatch(
        document,
        proposal([
          {
            kind: 'add_datum_axis',
            name: 'Edge axis',
            definition: {
              kind: 'edge',
              source: { type: 'edge', bodyId: face.bodyId, edgeReference }
            }
          }
        ])
      )
    ).toHaveLength(1);
    for (const source of [
      { ...face, bodyId: '$source' },
      { ...face, faceHash: 999 },
      { ...face, sourceNormal: v(0, 0, -1) },
      {
        ...face,
        frame: { ...face.frame, xAxis: v(0, -1, 0), yAxis: v(1, 0, 0) }
      },
      {
        ...face,
        faceReference: {
          ...face.faceReference,
          witness: { ...face.faceReference.witness, perimeter: 1 }
        }
      }
    ])
      expect(() =>
        commandsForCadPatch(
          document,
          proposal([operation(source as FacePlaneSource)])
        )
      ).toThrow(/same-proposal|current|qualified/);
    const duplicate = deepClone(document);
    duplicate.derived.bodyRepresentations[face.bodyId]!.topology!.faces.push(
      deepClone(
        duplicate.derived.bodyRepresentations[face.bodyId]!.topology!.faces[0]!
      )
    );
    expect(() =>
      commandsForCadPatch(duplicate, proposal([operation()]))
    ).toThrow(/qualified current/);
  });

  it('retains exact authored face and edge sources consumed later, while refusing changed sources on those bodies', () => {
    const f = fixture();
    const plane = addDatumPlane(f.document, {
      name: 'Earlier plane',
      definition: { kind: 'offset', source: f.face, offset: 1 }
    });
    const axis = addDatumAxis(plane.document, {
      name: 'Earlier axis',
      definition: {
        kind: 'edge',
        source: {
          type: 'edge',
          bodyId: f.bodyId,
          edgeReference: f.edgeReference
        }
      }
    });
    const consumed = booleanBodies(axis.document, {
      name: 'Consume later',
      operation: 'union',
      targetBodyIds: [f.bodyId, f.otherBodyId]
    }).document;
    const operations: CadPatchOperation[] = [
      {
        kind: 'update_datum_plane',
        featureId: plane.featureId,
        definition: {
          kind: 'offset',
          source: f.face,
          offset: '1 in',
          reverseNormal: true
        }
      },
      {
        kind: 'update_datum_axis',
        featureId: axis.featureId,
        definition: {
          kind: 'edge',
          source: {
            type: 'edge',
            bodyId: f.bodyId,
            edgeReference: f.edgeReference
          },
          reverseDirection: true
        }
      }
    ];
    const commands = commandsForCadPatch(consumed, proposal(operations));
    const candidate = new CommandManager(consumed).runTransaction(
      'Edit historical datums',
      commands
    );
    expect(findFeature(candidate, plane.featureId)!.data).toMatchObject({
      definition: { source: f.face, offset: '1 in' }
    });
    expect(findFeature(candidate, axis.featureId)!.data).toMatchObject({
      definition: {
        source: { edgeReference: f.edgeReference },
        reverseDirection: true
      }
    });
    const changed: CadDatumPlaneDefinitionV2 = {
      kind: 'offset',
      source: { ...f.face, sourceArea: 99 },
      offset: 2
    };
    expect(() =>
      commandsForCadPatch(
        consumed,
        proposal([
          {
            kind: 'update_datum_plane',
            featureId: plane.featureId,
            definition: changed
          }
        ])
      )
    ).toThrow(/consum/);
  });

  it('refuses a later datum source on updates and invalid coordinate expressions before compilation', () => {
    const { document } = fixture();
    const earlier = addDatumPlane(document, {
      name: 'Earlier plane',
      definition: { kind: 'offset', source: xy, offset: 1 }
    });
    expect(() =>
      commandsForCadPatch(
        earlier.document,
        proposal([
          plane('late'),
          {
            kind: 'update_datum_plane',
            featureId: earlier.featureId,
            definition: {
              kind: 'parallel-point',
              source: { type: 'datum', datum: '$late' },
              point: point(0, 0, 5)
            }
          }
        ])
      )
    ).toThrow(/later|before/);
    const invalid = axis();
    if (
      invalid.kind !== 'add_datum_axis' ||
      invalid.definition.kind !== 'two-point'
    )
      throw new Error('Fixture needs points.');
    invalid.definition.points[1] = point('missing_parameter', 0, 1);
    expect(() => commandsForCadPatch(document, proposal([invalid]))).toThrow(
      /invalid expression/
    );
  });

  it.each([undefined, 2] as const)(
    'keeps canonical XZ basis %s on source-offset and direction edits',
    (basisRevision) => {
      const { document } = fixture();
      const front = {
        type: 'canonical' as const,
        plane: 'XZ' as const,
        offset: '1 mm',
        ...(basisRevision === undefined ? {} : { basisRevision })
      };
      const plane = addDatumPlane(document, {
        name: 'Front plane',
        definition: { kind: 'offset', source: front, offset: 1 }
      });
      const axis = addDatumAxis(plane.document, {
        name: 'Front axis',
        definition: { kind: 'plane-intersection', sources: [xy, front] }
      });
      const wireFront = {
        type: 'canonical' as const,
        plane: 'XZ' as const,
        offset: '3 mm'
      };
      const commands = commandsForCadPatch(
        axis.document,
        proposal([
          {
            kind: 'update_datum_plane',
            featureId: plane.featureId,
            definition: {
              kind: 'offset',
              source: wireFront,
              offset: '4 mm',
              reverseNormal: true
            }
          },
          {
            kind: 'update_datum_axis',
            featureId: axis.featureId,
            definition: {
              kind: 'plane-intersection',
              sources: [xy, wireFront],
              reverseDirection: true
            }
          },
          {
            kind: 'add_datum_plane_v2',
            name: 'New Front',
            definition: { kind: 'offset', source: wireFront, offset: 0 }
          }
        ])
      );
      const next = new CommandManager(axis.document).runTransaction(
        'Edit retained Front',
        commands
      );
      expect(findFeature(next, plane.featureId)!.data).toMatchObject({
        definition: {
          source: { ...front, offset: '3 mm' },
          offset: '4 mm',
          reverseNormal: true
        }
      });
      const updatedPlane = findFeature(next, plane.featureId)!.data;
      if (
        updatedPlane.featureKind !== 'datum-plane' ||
        updatedPlane.definition.kind !== 'offset'
      )
        throw new Error('Fixture needs an offset plane.');
      expect(updatedPlane.definition.source).toEqual({
        ...front,
        offset: '3 mm'
      });
      const updatedAxis = findFeature(next, axis.featureId)!.data;
      if (
        updatedAxis.featureKind !== 'datum-axis' ||
        updatedAxis.definition.kind !== 'plane-intersection'
      )
        throw new Error('Fixture needs a plane-intersection axis.');
      expect(updatedAxis.definition.sources[1]).toEqual({
        ...front,
        offset: '3 mm'
      });
      expect(listFeaturesInOrder(next).at(-1)!.data).toMatchObject({
        definition: { source: { basisRevision: 2 } }
      });
    }
  );

  it('copies authored definitions so later proposal mutation cannot retarget a compiled command', () => {
    const { document } = fixture();
    const operation = plane();
    const commands = commandsForCadPatch(document, proposal([operation]));
    if (
      operation.kind !== 'add_datum_plane_v2' ||
      operation.definition.kind !== 'three-point'
    )
      throw new Error('Fixture needs points.');
    operation.definition.points[0] = point(999, 999, 999);
    const next = new CommandManager(document).runTransaction(
      'Original points',
      commands
    );
    expect(listFeaturesInOrder(next).at(-1)!.data).toMatchObject({
      definition: {
        points: [point('1 in', 0, 0), point(0, 2, 0), point(0, 0, 3)]
      }
    });
  });
});
