import { describe, expect, it } from 'vitest';
import { CommandManager } from '@openzcad/command-system';
import {
  addDatumPlane,
  addSplitFeature,
  addPrimitiveFeature,
  createProjectDocument,
  findFeature
} from '@openzcad/document-core';
import {
  toUserId,
  type DatumFrame,
  type DatumPlaneDefinition,
  type EdgeVertexPointSource,
  type FeatureId,
  type FeatureNode,
  type FeatureWarning,
  type ProjectDocument
} from '@openzcad/shared';
import { datumFaceAttachFailed, datumOffsetHandle } from './datumPlaneDisplay';
import {
  buildDatumPlaneDefinition,
  datumFormStateFromFeature,
  datumFaceRepairEdit,
  datumFormValidation,
  datumPlaneCommand,
  datumPlaneDescription,
  datumPlaneDisplays,
  datumPlaneRows,
  datumSourceOptions,
  datumVertexFromEdgePick,
  datumVertexOption,
  downstreamDatumIds,
  edgeEnds,
  earlierDatumPlanes,
  newDatumPlaneFormState,
  nextDatumPlaneName,
  requireResolvedDatum,
  requireResolvedDatums,
  type DatumPlaneFormState
} from './datumPlanes';

const XY = { type: 'canonical', plane: 'XY', offset: 0 } as const;
const frame: DatumFrame = {
  origin: { x: 0, y: 0, z: 10 },
  u: { x: 1, y: 0, z: 0 },
  v: { x: 0, y: 1, z: 0 },
  normal: { x: 0, y: 0, z: 1 }
};

function withFrames(
  document: ProjectDocument,
  frames: Record<string, DatumFrame>
): ProjectDocument {
  return {
    ...document,
    derived: { ...document.derived, datumFrames: frames }
  };
}

function twoDatums() {
  const empty = createProjectDocument('Datums', toUserId('user_datum_ui'));
  const first = addDatumPlane(empty, {
    name: 'Plane 1',
    definition: { kind: 'offset', source: XY, offset: 'lid' }
  });
  const second = addDatumPlane(first.document, {
    name: 'Plane 2',
    definition: {
      kind: 'midplane',
      sources: [XY, { type: 'datum', datumFeatureId: first.featureId }],
      reverseNormal: true
    }
  });
  return {
    document: second.document,
    first: first.featureId,
    second: second.featureId
  };
}

describe('Plane card state (R01-C)', () => {
  it('offers the principal planes, then only earlier datums', () => {
    const { document, first, second } = twoDatums();
    expect(datumSourceOptions(document, null).map((o) => o.label)).toEqual([
      'Top (XY)',
      'Front (XZ)',
      'Right (YZ)',
      'Plane 1',
      'Plane 2'
    ]);
    // An edited datum may not read itself or anything after it.
    expect(
      datumSourceOptions(document, second).map((o) => o.label)
    ).not.toContain('Plane 2');
    expect(earlierDatumPlanes(document, first)).toEqual([]);
  });

  it('round-trips an offset definition through the card unchanged', () => {
    const { document, first } = twoDatums();
    const feature = findFeature(document, first)!;
    const state = datumFormStateFromFeature(feature);
    expect(state).toMatchObject({ mode: 'offset', offset: 'lid' });
    expect(buildDatumPlaneDefinition(state)).toEqual({
      kind: 'offset',
      source: XY,
      offset: 'lid'
    });
  });

  it('keeps midplane roles and the flip', () => {
    const { document, first, second } = twoDatums();
    const state = datumFormStateFromFeature(findFeature(document, second)!);
    expect(buildDatumPlaneDefinition(state)).toEqual({
      kind: 'midplane',
      sources: [XY, { type: 'datum', datumFeatureId: first }],
      reverseNormal: true
    });
  });

  it('says what is missing before it says what is wrong', () => {
    const state = newDatumPlaneFormState('Plane 1', null);
    expect(datumFormValidation(state, {})?.kind).toBe('missing');
    const offset = { ...state, sourceA: XY, offset: 'nope +' };
    expect(datumFormValidation(offset, {})?.kind).toBe('invalid');
    expect(datumFormValidation({ ...offset, offset: '-4' }, {})).toBeNull();
    expect(datumFormValidation({ ...offset, offset: '0' }, {})).toBeNull();
    const same = { ...offset, mode: 'midplane' as const, sourceB: XY };
    expect(datumFormValidation(same, {})).toEqual({
      kind: 'invalid',
      reason: 'A midplane needs two different planes.'
    });
  });

  it('accepts a unit-bearing offset as a length in the document units', () => {
    const state = { ...newDatumPlaneFormState('Plane 1', XY), offset: '1 in' };
    expect(datumFormValidation(state, {}, 'mm')).toBeNull();
    expect(
      datumFormValidation({ ...state, offset: '30 deg' }, {}, 'mm')?.kind
    ).toBe('invalid');
  });

  it('describes a datum by its source, in document units', () => {
    const { document, first, second } = twoDatums();
    expect(
      datumPlaneDescription(
        document,
        findFeature(document, first)!,
        { lid: 12 },
        'mm'
      )
    ).toBe('12 mm from Top (XY)');
    expect(
      datumPlaneDescription(document, findFeature(document, second)!, {}, 'mm')
    ).toBe('Midway between Top (XY) and Plane 1, flipped');
  });

  it('lists datum rows with their dependents and resolution', () => {
    const { document, first, second } = twoDatums();
    const rows = datumPlaneRows(withFrames(document, { [first]: frame }), {
      lid: 10
    });
    expect(rows.map((row) => [row.name, row.dependents, row.resolved])).toEqual(
      [
        ['Plane 1', ['Plane 2'], true],
        ['Plane 2', [], false]
      ]
    );
    expect(rows[1]!.featureId).toBe(second);
  });

  it('draws only resolved, shown datums', () => {
    const { document, first, second } = twoDatums();
    const framed = withFrames(document, { [first]: frame, [second]: frame });
    expect(
      datumPlaneDisplays(framed, new Set([second]), first).map((plane) => [
        plane.featureId,
        plane.selected
      ])
    ).toEqual([[first, true]]);
    expect(datumPlaneDisplays(document, new Set(), null)).toEqual([]);
  });

  it('numbers new planes past the names already taken', () => {
    expect(nextDatumPlaneName(twoDatums().document)).toBe('Plane 3');
  });
});

describe('Plane card commands (R01-C)', () => {
  it('creates a datum through one undoable command with its id assigned', () => {
    const empty = createProjectDocument('Create', toUserId('user_datum_ui'));
    const { command, featureId } = datumPlaneCommand(
      {
        name: 'Lid plane',
        definition: { kind: 'offset', source: XY, offset: 10 }
      },
      null
    );
    const manager = new CommandManager(empty);
    manager.execute(command);
    expect(findFeature(manager.document, featureId)?.data).toEqual({
      featureKind: 'datum-plane',
      definition: { kind: 'offset', source: XY, offset: 10 }
    });
    // Replay rebuilds the same feature id from the serialized command.
    expect(command.serialize()).toMatchObject({ kind: 'feature.datum-plane' });
    manager.undo();
    expect(findFeature(manager.document, featureId)).toBeUndefined();
  });

  it('edits a datum in place and refuses a forward reference', () => {
    const { document, first, second } = twoDatums();
    const edit = datumPlaneCommand(
      {
        name: 'Plane 1',
        definition: {
          kind: 'offset',
          source: XY,
          offset: -4,
          reverseNormal: true
        }
      },
      findFeature(document, first)!
    );
    expect(edit.featureId).toBe(first);
    const edited = edit.command.apply(document);
    expect(findFeature(edited, first)?.data).toMatchObject({
      definition: { offset: -4, reverseNormal: true }
    });
    const forward = datumPlaneCommand(
      {
        name: 'Plane 1',
        definition: {
          kind: 'offset',
          source: { type: 'datum', datumFeatureId: second },
          offset: 1
        }
      },
      findFeature(document, first)!
    );
    expect(() => forward.command.validate(document)).toThrow();
  });

  it('accepts a datum only once its frame is published', () => {
    const id = 'feat_lid' as FeatureId;
    const document = createProjectDocument('Check', toUserId('user_datum_ui'));
    expect(() => requireResolvedDatum(document.derived, id, 'Lid')).toThrow(
      'Lid did not resolve to a plane.'
    );
    expect(() =>
      requireResolvedDatum(
        {
          ...document.derived,
          datumFrames: { [id]: frame },
          featureWarnings: [
            {
              featureId: id,
              featureName: 'Lid',
              message: 'Feature "Lid": the planes are not parallel.',
              kind: 'build-failed'
            }
          ]
        },
        id,
        'Lid'
      )
    ).toThrow('the planes are not parallel');
    expect(() =>
      requireResolvedDatum(
        { ...document.derived, datumFrames: { [id]: frame } },
        id,
        'Lid'
      )
    ).not.toThrow();
  });

  it('refuses an edit that breaks a later datum built on the edited one', () => {
    const { document, first, second } = twoDatums();
    expect(downstreamDatumIds(document, first)).toEqual([second]);
    const before = withFrames(document, { [first]: frame, [second]: frame });
    // The edited plane resolves; the midplane on it no longer does.
    expect(() =>
      requireResolvedDatums(
        before,
        { ...document.derived, datumFrames: { [first]: frame } },
        first,
        'Plane 1'
      )
    ).toThrow('Plane 2 did not resolve to a plane.');
    // A later datum that was already broken is not this edit's to answer for.
    expect(() =>
      requireResolvedDatums(
        withFrames(document, { [first]: frame }),
        { ...document.derived, datumFrames: { [first]: frame } },
        first,
        'Plane 1'
      )
    ).not.toThrow();
  });

  it('also checks a later datum on a face of a body the edit splits', () => {
    const { document, first } = twoDatums();
    const boxed = addPrimitiveFeature(document, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 20 }
    });
    const split = addSplitFeature(boxed, {
      name: 'Split',
      targetBodyId: boxed.bodyOrder.at(-1)!,
      plane: { type: 'datum', datumFeatureId: first }
    });
    const half = split.document.bodyOrder.at(-1)!;
    const onFace = addDatumPlane(split.document, {
      name: 'Plane 3',
      definition: {
        kind: 'offset',
        source: {
          type: 'face',
          bodyId: half,
          faceHash: 1,
          faceReference: { kind: 'face' } as never,
          sourceArea: 1,
          sourceCenter: { x: 0, y: 0, z: 0 },
          sourceCentroid: { x: 0, y: 0, z: 0 },
          sourceNormal: { x: 0, y: 0, z: 1 },
          frame: {
            origin: { x: 0, y: 0, z: 0 },
            xAxis: { x: 1, y: 0, z: 0 },
            yAxis: { x: 0, y: 1, z: 0 },
            zAxis: { x: 0, y: 0, z: 1 }
          }
        },
        offset: 1
      }
    });
    expect(downstreamDatumIds(onFace.document, first)).toContain(
      onFace.featureId
    );
  });

  it('lets Split name a datum by id', () => {
    const { document, first } = twoDatums();
    const boxed = addPrimitiveFeature(document, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 20 }
    });
    const split = addSplitFeature(boxed, {
      name: 'Split',
      targetBodyId: boxed.bodyOrder.at(-1)!,
      plane: { type: 'datum', datumFeatureId: first }
    });
    expect(datumPlaneRows(split.document, { lid: 8 })[0]!.dependents).toEqual([
      'Plane 2',
      'Split'
    ]);
  });
});

describe('datum viewport handle and repair (R01)', () => {
  it("offers a face re-pick only for the build's own attach failure", () => {
    const feature = {
      featureId: 'feature_lid' as FeatureId,
      name: 'Lid plane'
    } as FeatureNode;
    const warning = (featureId: string, message: string): FeatureWarning => ({
      featureId: featureId as FeatureId,
      featureName: 'Lid plane',
      message,
      kind: 'build-failed'
    });
    const lost =
      'Feature "Lid plane": Datum plane "Lid plane" cannot attach because source body body_x is unavailable at the datum\'s history position.';
    expect(datumFaceAttachFailed(feature, [warning('feature_lid', lost)])).toBe(
      true
    );
    expect(
      datumFaceAttachFailed(feature, [
        warning(
          'feature_lid',
          'Feature "Lid plane": Datum plane "Lid plane" cannot attach to source feature "Block": the attached face was deleted or no longer exists.'
        )
      ])
    ).toBe(true);
    // Still rebuilding (no warning) or failing for another reason: no.
    expect(datumFaceAttachFailed(feature, [])).toBe(false);
    expect(
      datumFaceAttachFailed(feature, [
        warning(
          'feature_lid',
          'Feature "Lid plane": datum plane offset: Unknown identifier "nope" in expression.'
        )
      ])
    ).toBe(false);
    // A same-named datum's attach failure belongs to that datum, not this.
    expect(
      datumFaceAttachFailed(feature, [warning('feature_twin', lost)])
    ).toBe(false);
  });

  const offsetDatum = (offset: number | string, reverseNormal = false) => {
    const empty = createProjectDocument('Handle', toUserId('user_handle'));
    const added = addDatumPlane(empty, {
      name: 'Lid plane',
      definition: {
        kind: 'offset',
        source: XY,
        offset,
        ...(reverseNormal ? { reverseNormal: true } : {})
      }
    });
    return {
      document: withFrames(added.document, { [added.featureId]: frame }),
      featureId: added.featureId
    };
  };

  it('offers a handle only for a shown offset datum with a literal offset', () => {
    const { document, featureId } = offsetDatum(10);
    expect(datumOffsetHandle(document, featureId, new Set())).toEqual({
      featureId,
      point: frame.origin,
      normal: frame.normal,
      offset: 10,
      sense: 1
    });
    expect(datumOffsetHandle(document, featureId, new Set([featureId]))).toBe(
      null
    );
    expect(datumOffsetHandle(document, null, new Set())).toBe(null);
    const reversed = offsetDatum(10, true);
    expect(
      datumOffsetHandle(reversed.document, reversed.featureId, new Set())?.sense
    ).toBe(-1);
    // An expression-driven datum still has a pin (the card decides from its
    // live draft whether a drag may land); its stored offset is not a number.
    const driven = offsetDatum('lid_z');
    expect(
      datumOffsetHandle(driven.document, driven.featureId, new Set())
    ).toMatchObject({ offset: null });
  });

  it('re-picks a source face only with a planar face it can follow', () => {
    const { document, featureId } = offsetDatum(10);
    expect(() =>
      datumFaceRepairEdit(document, featureId, {
        bodyId: 'body_x' as never,
        kind: 'edge',
        hash: 1
      } as never)
    ).toThrow('Click a planar face for "Lid plane".');
    expect(() =>
      datumFaceRepairEdit(document, featureId, {
        bodyId: 'body_missing' as never,
        kind: 'face',
        hash: 7
      } as never)
    ).toThrow();
    // An offset plane has one source: there is no second face to re-pick.
    expect(() =>
      datumFaceRepairEdit(
        document,
        featureId,
        { bodyId: 'body_x' as never, kind: 'face', hash: 1 } as never,
        1
      )
    ).toThrow('Only a datum plane source can be re-picked here.');
  });
});

describe('three-point and parallel datums (R01)', () => {
  const edgeReference = (name: string, closed = false) =>
    ({
      kind: 'edge',
      producingFeatureId: 'feat_box' as FeatureId,
      lineageName: name,
      currentHash: 1,
      witnessVersion: 1,
      witness: closed
        ? {
            curveType: 'CIRCLE',
            length: 6,
            closed: true,
            center: [0, 0, 0],
            axis: [0, 0, 1000]
          }
        : {
            curveType: 'LINE',
            length: 10,
            closed: false,
            endpoints: [
              [10e6, 0, 20e6],
              [0, 0, 20e6]
            ],
            midpoint: [5e6, 0, 20e6]
          }
    }) as EdgeVertexPointSource['edgeReference'];

  function boxWithEdges(edges: { hash: number; reference?: unknown }[]) {
    const document = addPrimitiveFeature(
      createProjectDocument('Edges', toUserId('user_datum_ui')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 20 }
      }
    );
    const bodyId = document.bodyOrder.at(-1)!;
    return {
      bodyId,
      document: {
        ...document,
        derived: {
          ...document.derived,
          bodyRepresentations: {
            [bodyId]: {
              name: 'Box',
              topology: { faces: [], edges }
            }
          }
        }
      } as unknown as ProjectDocument
    };
  }

  it('orders edge ends by quantized x, then y, then z', () => {
    const ends = edgeEnds(edgeReference('edge:top').witness)!;
    expect(ends[0]).toEqual({ x: 0, y: 0, z: 20 });
    expect(ends[1]).toEqual({ x: 10, y: 0, z: 20 });
    expect(edgeEnds(edgeReference('edge:rim', true).witness)).toBeNull();
  });

  it('takes the end of a picked edge nearer the click, refusing closed or unnamed edges', () => {
    const { document, bodyId } = boxWithEdges([
      { hash: 1, reference: edgeReference('edge:top') },
      { hash: 2, reference: edgeReference('edge:rim', true) },
      { hash: 3 }
    ]);
    const pick = (
      hash: number,
      point: { x: number; y: number; z: number } | null
    ) =>
      datumVertexFromEdgePick(document, { kind: 'edge', bodyId, hash }, point);
    expect(pick(1, { x: 9, y: 0, z: 20 })).toMatchObject({
      type: 'edge-vertex',
      end: 1
    });
    expect(pick(1, { x: 1, y: 0, z: 20 })).toMatchObject({ end: 0 });
    expect(pick(1, null)).toMatchObject({ end: 0 });
    const reason = (result: ReturnType<typeof pick>) =>
      'reason' in result ? result.reason : null;
    expect(reason(pick(2, null))).toMatch(/closed edge has no end vertex/);
    expect(reason(pick(3, null))).toMatch(
      /no identity a rebuild can find again/
    );
    const vertex = pick(1, null) as EdgeVertexPointSource;
    expect(datumVertexOption(document, vertex).label).toBe(
      'Vertex (0, 0, 20) of Box'
    );
  });

  it('round-trips both definitions through the card and describes them', () => {
    const { document, bodyId } = boxWithEdges([]);
    const vertex: EdgeVertexPointSource = {
      type: 'edge-vertex',
      bodyId,
      edgeReference: edgeReference('edge:top'),
      end: 1
    };
    const three: DatumPlaneDefinition = {
      kind: 'three-point',
      points: [
        vertex,
        { type: 'point', point: { x: 'lid', y: 0, z: 0 } },
        { type: 'point', point: { x: 0, y: 10, z: 0 } }
      ],
      reverseNormal: true
    };
    const parallel: DatumPlaneDefinition = {
      kind: 'parallel-point',
      source: XY,
      point: vertex
    };
    let next = document;
    const ids: FeatureId[] = [];
    for (const [name, definition] of [
      ['Tilt', three],
      ['Lid', parallel]
    ] as const) {
      const added = addDatumPlane(next, { name, definition });
      next = added.document;
      ids.push(added.featureId);
      const feature = findFeature(next, added.featureId)!;
      expect(
        buildDatumPlaneDefinition(datumFormStateFromFeature(feature))
      ).toEqual(definition);
    }
    expect(
      datumPlaneDescription(next, findFeature(next, ids[0]!)!, { lid: 4 }, 'mm')
    ).toBe('Through a vertex of Box, (4, 0, 0) and (0, 10, 0), flipped');
    expect(
      datumPlaneDescription(next, findFeature(next, ids[1]!)!, {}, 'mm')
    ).toBe('Parallel to Top (XY) through a vertex of Box');
    // A vertex re-pick is not a face re-pick.
    expect(() =>
      datumFaceRepairEdit(next, ids[0]!, { kind: 'face', bodyId, hash: 1 })
    ).toThrow(/Only a datum plane source/);
  });

  it('validates point slots: missing first, then malformed, then repeated', () => {
    const state = {
      ...newDatumPlaneFormState('Plane 1', XY),
      mode: 'three-point' as const
    };
    expect(datumFormValidation(state, {})?.kind).toBe('missing');
    expect(datumFormValidation(state, {})?.reason).toMatch(/first point/);
    const typed = (x: string) => ({
      type: 'typed' as const,
      x,
      y: '0',
      z: '0'
    });
    const reasonOf = (next: DatumPlaneFormState) =>
      datumFormValidation(next, {})?.reason;
    expect(
      reasonOf({ ...state, points: [typed('0'), typed('nope'), typed('2')] })
    ).toMatch(/second point's X/);
    expect(
      reasonOf({ ...state, points: [typed('0'), typed('0 '), typed('2')] })
    ).toBe('A three-point plane needs three different points.');
    expect(
      reasonOf({ ...state, mode: 'parallel-point', points: [null, null, null] })
    ).toMatch(/through point/);
  });

  it('reports a datum through a vertex of a body an edit changes as downstream', () => {
    const { document, first } = twoDatums();
    const boxed = addPrimitiveFeature(document, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 20 }
    });
    const split = addSplitFeature(boxed, {
      name: 'Split',
      targetBodyId: boxed.bodyOrder.at(-1)!,
      plane: { type: 'datum', datumFeatureId: first }
    });
    const through = addDatumPlane(split.document, {
      name: 'Plane 3',
      definition: {
        kind: 'parallel-point',
        source: XY,
        point: {
          type: 'edge-vertex',
          bodyId: split.document.bodyOrder.at(-1)!,
          edgeReference: edgeReference('edge:top'),
          end: 0
        }
      }
    });
    expect(downstreamDatumIds(through.document, first)).toContain(
      through.featureId
    );
  });
});
