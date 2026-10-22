import { describe, expect, it } from 'vitest';
import {
  addDatumAxis,
  addDatumPlane,
  addPrimitiveFeature,
  createProjectDocument,
  findFeature,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { CommandManager, replayCommands } from '@openzcad/command-system';
import {
  deepClone,
  FEATURE_SUPPRESSED_METADATA_KEY,
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type EdgeTopology,
  type EdgeVertexPointSource,
  type FeatureId,
  type FeatureWarning,
  type TopologySelection
} from '@openzcad/shared';
import {
  beginDatumVertexRepair,
  datumVertexRepairEdit,
  datumVertexRepairSlots,
  datumVertexSourceFailed,
  stageDatumVertexRepairPick
} from '../apps/web/src/lib/datumVertexRepair';

const point = (x: number | string, y = 0, z = 0) => ({
  type: 'point' as const,
  point: { x, y, z }
});

function edge(hash: number, producingFeatureId: FeatureId): EdgeTopology {
  return {
    hash,
    topologyId: `edge_${hash}`,
    points: [hash, 0, 0, hash, 0, 10],
    reference: {
      kind: 'edge',
      producingFeatureId,
      lineageName: `edge/${hash}`,
      currentHash: hash,
      witnessVersion: 1,
      witness: {
        closed: false,
        curveType: 'line',
        length: 10_000_000,
        endpoints: [
          [hash * 1_000_000, 0, 10_000_000],
          [hash * 1_000_000, 0, 0]
        ],
        midpoint: [hash * 1_000_000, 0, 5_000_000]
      }
    }
  };
}

function representation(
  bodyId: BodyId,
  edges: EdgeTopology[]
): BodyRepresentation {
  return {
    bodyId,
    name: 'Replacement',
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: new Float32Array(),
      indices: new Uint32Array()
    },
    faceCount: 0,
    color: '#888888',
    exportableStep: true,
    consumed: false,
    volume: 1,
    bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 1, z: 10 } },
    topology: { faces: [], edges }
  };
}

function fixture(
  mode: 'three-point' | 'parallel-point' | 'two-point' = 'three-point'
) {
  let document = createProjectDocument(
    'Vertex repair',
    toUserId('user_vertex_repair')
  );
  for (const name of ['Old source', 'Replacement'])
    document = addPrimitiveFeature(document, {
      name,
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
  const [oldBody, bodyId] = document.bodyOrder as [BodyId, BodyId];
  const [oldFeature, replacement] = listFeaturesInOrder(document);
  const source = (hash: number): EdgeVertexPointSource => ({
    type: 'edge-vertex',
    bodyId: oldBody,
    end: 0,
    edgeReference: edge(hash, oldFeature!.featureId).reference!
  });
  const name = 'Repair me';
  const added =
    mode === 'two-point'
      ? addDatumAxis(document, {
          name,
          definition: {
            kind: 'two-point',
            points: [source(1), source(2)],
            reverseDirection: true
          }
        })
      : addDatumPlane(document, {
          name,
          definition:
            mode === 'three-point'
              ? {
                  kind: 'three-point',
                  points: [source(1), point('2 + 3', 1), source(3)],
                  reverseNormal: true
                }
              : {
                  kind: 'parallel-point',
                  source: { type: 'canonical', plane: 'XY', offset: '2 + 3' },
                  point: source(1),
                  reverseNormal: true
                }
        });
  document = added.document;
  const featureId = added.featureId;
  const feature = findFeature(document, featureId)!;
  document.derived.featureWarnings = [
    {
      featureId,
      featureName: name,
      kind: 'build-failed',
      message: `${mode === 'two-point' ? 'Datum axis' : 'Datum plane'} "${name}" cannot use a vertex of source feature "Old source": its edge was deleted or no longer exists.`
    }
  ];
  document.derived.bodyRepresentations[bodyId] = representation(
    bodyId,
    [11, 22, 33].map((hash) => edge(hash, replacement!.featureId))
  );
  const selection = (hash = 11): TopologySelection => ({
    kind: 'edge',
    bodyId,
    hash,
    topologyId: `edge_${hash}`
  });
  const click = (hash = 11, z = 0) => ({ x: hash, y: 0, z });
  return { document, feature, featureId, bodyId, selection, click };
}

describe('datum vertex repair contract', () => {
  it('offers only authored vertex roles and identifies only this datum’s source failure', () => {
    const { document, feature } = fixture();
    expect(
      datumVertexRepairSlots(feature).map((slot) => [slot.index, slot.label])
    ).toEqual([
      [0, 'Point 1'],
      [2, 'Point 3']
    ]);
    const warnings = document.derived.featureWarnings!;
    expect(datumVertexSourceFailed(feature, warnings)).toBe(true);
    expect(
      datumVertexSourceFailed(feature, [{ ...warnings[0]!, kind: 'refusal' }])
    ).toBe(true);
    for (const warning of [
      { ...warnings[0]!, featureId: 'feature_other' as FeatureId },
      { ...warnings[0]!, kind: 'advisory' },
      { ...warnings[0]!, kind: 'suppressed' },
      {
        ...warnings[0]!,
        message: 'Datum plane "Repair me" has collinear points.'
      },
      {
        ...warnings[0]!,
        message: 'Datum plane "Repair me" has coincident points.'
      },
      {
        ...warnings[0]!,
        message: 'Datum plane "Repair me" did not resolve to a plane.'
      }
    ] as FeatureWarning[])
      expect(datumVertexSourceFailed(feature, [warning])).toBe(false);
    expect(datumVertexSourceFailed(feature, [])).toBe(false);
    // Kernel diagnostics sanitize quoted/control/long names. Attribution is
    // by feature identity and the source-specific error, not rendered names.
    expect(
      datumVertexSourceFailed(
        { ...feature, name: 'Quoted " name\n' + 'x'.repeat(300) },
        warnings
      )
    ).toBe(true);
    expect(
      datumVertexSourceFailed(feature, [
        {
          ...warnings[0]!,
          message: `Datum plane "Repair me" cannot use a vertex of body missing_body because it is unavailable at the datum's history position.`
        }
      ])
    ).toBe(true);
    expect(
      datumVertexSourceFailed(
        { ...feature, metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true } },
        warnings
      )
    ).toBe(false);
  });

  it('rejects empty, duplicate, typed, fractional and absent requested slots', () => {
    const { document, featureId } = fixture();
    for (const slots of [[], [0, 0], [1], [3], [-1], [0.5]]) {
      expect(() => beginDatumVertexRepair(document, featureId, slots)).toThrow(
        /role|typed/
      );
    }
    const healthy = deepClone(document);
    healthy.derived.featureWarnings = [];
    expect(() => beginDatumVertexRepair(healthy, featureId, [0])).toThrow(
      /no failed vertex/
    );
    expect(
      beginDatumVertexRepair(
        healthy,
        featureId,
        [0],
        document.derived.featureWarnings
      ).pendingSlot?.index
    ).toBe(0);
  });

  it('stages all requested roles in authored order without changing the source document or earlier session', () => {
    const { document, featureId, selection, click } = fixture();
    const original = deepClone(document);
    const session = beginDatumVertexRepair(document, featureId, [2, 0]);
    expect(session.pendingSlot?.index).toBe(0);
    const first = stageDatumVertexRepairPick(
      document,
      session,
      selection(),
      click()
    );
    expect(session.replacements).toEqual([]);
    expect(first.pendingSlot?.index).toBe(2);
    expect(() => datumVertexRepairEdit(document, first)).toThrow(
      /every requested/
    );
    const complete = stageDatumVertexRepairPick(
      document,
      first,
      selection(22),
      click(22, 10)
    );
    expect(complete.pendingSlot).toBeNull();
    expect(
      complete.replacements.map((replacement) => replacement.source.end)
    ).toEqual([0, 1]);
    expect(document).toEqual(original);
    expect(() =>
      stageDatumVertexRepairPick(document, complete, selection(33), click(33))
    ).toThrow(/already been picked/);
    // Abandoning either staged value is cancellation: no command was emitted or applied.
    expect(document.commandLog).toEqual(original.commandLog);
  });

  it('preserves typed points, source planes and direction while applying a single selected role', () => {
    for (const mode of [
      'three-point',
      'parallel-point',
      'two-point'
    ] as const) {
      const { document, feature, featureId, bodyId, selection, click } =
        fixture(mode);
      const session = stageDatumVertexRepairPick(
        document,
        beginDatumVertexRepair(document, featureId, [0]),
        selection(),
        click()
      );
      const edit = datumVertexRepairEdit(document, session);
      edit.command.validate(document);
      const candidate = edit.command.apply(document);
      const before = deepClone(feature.data);
      const after = findFeature(candidate, featureId)!.data;
      const expected = deepClone(before);
      if (
        expected.featureKind === 'datum-plane' &&
        expected.definition.kind === 'three-point'
      )
        expected.definition.points[0] = session.replacements[0]!.source;
      else if (
        expected.featureKind === 'datum-plane' &&
        expected.definition.kind === 'parallel-point'
      )
        expected.definition.point = session.replacements[0]!.source;
      else if (
        expected.featureKind === 'datum-axis' &&
        expected.definition.kind === 'two-point'
      )
        expected.definition.points[0] = session.replacements[0]!.source;
      expect(after).toEqual(expected);
      expect(session.replacements[0]!.source.bodyId).toBe(bodyId);
      expect(feature.data).toEqual(before);
    }
  });

  it('pins project, version and the authored definition through staging and command execution', () => {
    const { document, featureId, selection, click } = fixture();
    const session = beginDatumVertexRepair(document, featureId, [0]);
    const complete = stageDatumVertexRepairPick(
      document,
      session,
      selection(),
      click()
    );
    const edit = datumVertexRepairEdit(document, complete);
    const changedDefinition = deepClone(document);
    const changed = findFeature(changedDefinition, featureId)!;
    if (
      changed.data.featureKind === 'datum-plane' &&
      changed.data.definition.kind === 'three-point'
    )
      changed.data.definition.reverseNormal = false;
    for (const changed of [
      {
        ...document,
        projectId: createProjectDocument('Other', toUserId('user_other'))
          .projectId
      },
      { ...document, version: document.version + 1 },
      changedDefinition
    ]) {
      expect(() =>
        stageDatumVertexRepairPick(changed, session, selection(), click())
      ).toThrow(/changed/);
      expect(() => datumVertexRepairEdit(changed, complete)).toThrow(/changed/);
      expect(() => edit.command.validate(changed)).toThrow(/changed/);
      expect(() => edit.command.apply(changed)).toThrow(/changed/);
    }
  });

  it('refuses invalid and ambiguous picks atomically, without guessing the first edge or an end', () => {
    const { document, featureId, bodyId, selection, click } = fixture();
    const session = beginDatumVertexRepair(document, featureId, [0]);
    const original = deepClone(session);
    for (const [pick, position] of [
      [{ ...selection(), kind: 'face' }, click()],
      [selection(), null],
      [selection(), { ...click(), x: NaN }],
      [selection(), click(11, 5)],
      [{ ...selection(), hash: 99 }, click()]
    ] as [TopologySelection, ReturnType<typeof click> | null][]) {
      expect(() =>
        stageDatumVertexRepairPick(document, session, pick, position)
      ).toThrow();
      expect(session).toEqual(original);
    }
    const invalidBodies = [
      (edges: EdgeTopology[]) => {
        edges.push(deepClone(edges[0]!));
      },
      (edges: EdgeTopology[]) => {
        edges[1]!.reference!.lineageName = edges[0]!.reference!.lineageName;
      },
      (edges: EdgeTopology[]) => {
        delete edges[0]!.reference;
      },
      (edges: EdgeTopology[]) => {
        edges[0]!.reference!.currentHash = 999;
      },
      (edges: EdgeTopology[]) => {
        edges[0]!.reference!.witness = {
          closed: true,
          curveType: 'circle',
          length: 100,
          center: [0, 0, 0],
          axis: [0, 0, 1]
        };
      },
      (edges: EdgeTopology[]) => {
        const witness = edges[0]!.reference!.witness;
        if (!witness.closed) witness.endpoints[0][0] = Infinity;
      }
    ];
    for (const mutate of invalidBodies) {
      const changed = deepClone(document);
      mutate(changed.derived.bodyRepresentations[bodyId]!.topology!.edges);
      expect(() =>
        stageDatumVertexRepairPick(changed, session, selection(), click())
      ).toThrow();
      expect(session).toEqual(original);
    }
    const ambiguousHash = deepClone(document);
    ambiguousHash.derived.bodyRepresentations[
      bodyId
    ]!.topology!.edges[1]!.hash = 11;
    // Even when a topology id selected one edge, lowering to the existing
    // hash picker cannot choose safely among two edges carrying that hash.
    expect(() =>
      stageDatumVertexRepairPick(
        ambiguousHash,
        session,
        { kind: 'edge', bodyId, topologyId: 'edge_11' },
        click()
      )
    ).toThrow(/ambiguous/);
  });

  it('keeps independent command snapshots and records one undoable replayable update', () => {
    const { document, featureId, selection, click } = fixture();
    let session = beginDatumVertexRepair(document, featureId, [0, 2]);
    session = stageDatumVertexRepairPick(
      document,
      session,
      selection(),
      click()
    );
    session = stageDatumVertexRepairPick(
      document,
      session,
      selection(22),
      click(22)
    );
    const edit = datumVertexRepairEdit(document, session);
    const serialized = edit.command.serialize();
    const mutated = edit.command.serialize();
    if (
      mutated.payload.data?.featureKind === 'datum-plane' &&
      mutated.payload.data.definition?.kind === 'three-point'
    )
      mutated.payload.data.definition.points[0] = point(999);
    if (
      edit.command.payload.data?.featureKind === 'datum-plane' &&
      edit.command.payload.data.definition?.kind === 'three-point'
    )
      edit.command.payload.data.definition.points[0] = point(888);
    expect(edit.command.serialize().payload).toEqual(serialized.payload);
    const manager = new CommandManager(document);
    manager.execute(edit.command);
    const repaired = deepClone(findFeature(manager.document, featureId)!.data);
    expect(manager.document.commandLog).toHaveLength(
      document.commandLog.length + 1
    );
    expect(manager.document.commandLog.at(-1)?.kind).toBe('feature.update');
    manager.undo();
    expect(findFeature(manager.document, featureId)!.data).toEqual(
      findFeature(document, featureId)!.data
    );
    manager.redo();
    expect(findFeature(manager.document, featureId)!.data).toEqual(repaired);
    const replayed = replayCommands(document, [serialized]);
    expect(findFeature(replayed, featureId)!.data).toEqual(repaired);
  });

  it('refuses derived failure or absence, so an invalid candidate cannot be published', () => {
    const { document, featureId, selection, click } = fixture('two-point');
    const complete = stageDatumVertexRepairPick(
      document,
      beginDatumVertexRepair(document, featureId, [0]),
      selection(),
      click()
    );
    const edit = datumVertexRepairEdit(document, complete);
    expect(() => edit.validateDerived(document.derived)).toThrow(
      /cannot use a vertex/
    );
    expect(() =>
      edit.validateDerived({ ...document.derived, featureWarnings: [] })
    ).toThrow(/did not resolve to an axis/);
    expect(document.commandLog).toHaveLength(0);
  });
});
