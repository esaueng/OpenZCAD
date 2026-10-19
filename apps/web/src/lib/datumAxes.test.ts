import { describe, expect, it } from 'vitest';
import {
  addDatumAxis,
  addDatumPlane,
  addPrimitiveFeature,
  createProjectDocument,
  patternBody
} from '@openzcad/document-core';
import {
  toBodyId,
  toUserId,
  type BodyRepresentation,
  type DatumAxisLine,
  type EdgeTopologyReferenceV5,
  type FaceTopologyReferenceV5,
  type FeatureId,
  type FeatureNode,
  type FeatureWarning,
  type ProjectDocument
} from '@openzcad/shared';
import {
  buildDatumAxisDefinition,
  datumAxisCommand,
  datumAxisDescription,
  datumAxisEdgeFromPick,
  datumAxisFaceFromPick,
  datumAxisFormStateFromFeature,
  datumAxisFormValidation,
  datumAxisRows,
  datumAxisSourceRepairEdit,
  newDatumAxisFormState,
  nextDatumAxisName
} from './datumAxes';
import { datumAxisChoices } from './datumAxisChoices';
import { datumAxisDisplays } from './datumAxisDisplay';
import { datumAxisSourceFailed } from './datumPlaneDisplay';
import { requireResolvedDatums } from './datumPlanes';

/**
 * R01 datum axes, browser side: the card's state and validation, what a
 * viewport pick can give it, the words Items and History use, the pickers'
 * axis choices, the display set, and the source re-pick edit.
 */

const user = toUserId('user_axis_lib');
const XZ = { type: 'canonical', plane: 'XZ', offset: 0 } as const;
const YZ = { type: 'canonical', plane: 'YZ', offset: 0 } as const;
const line: DatumAxisLine = {
  origin: { x: 0, y: 0, z: 0 },
  direction: { x: 0, y: 0, z: 1 }
};

const straight: EdgeTopologyReferenceV5 = {
  kind: 'edge',
  producingFeatureId: 'feat_block' as FeatureId,
  lineageName: 'edge.side',
  currentHash: 11,
  witnessVersion: 1,
  witness: {
    curveType: 'LINE',
    length: 20_000_000,
    closed: false,
    endpoints: [
      [20_000_000, 0, 0],
      [20_000_000, 0, 20_000_000]
    ],
    midpoint: [20_000_000, 0, 10_000_000]
  }
};
const arc: EdgeTopologyReferenceV5 = {
  ...straight,
  lineageName: 'edge.arc',
  currentHash: 12,
  witness: { ...straight.witness, curveType: 'CIRCLE' }
};
const side: FaceTopologyReferenceV5 = {
  kind: 'face',
  producingFeatureId: 'feat_post' as FeatureId,
  lineageName: 'face.side',
  currentHash: 21,
  witnessVersion: 1,
  witness: {
    surfaceType: 'cylinder',
    perimeter: 1,
    centroid: null,
    analytic: { kind: 'none' },
    closure: { u: 'closed', v: 'open' }
  }
};

/** A document whose derived state publishes one body's topology. */
function withBody(document: ProjectDocument): ProjectDocument {
  const bodyId = toBodyId('body_block');
  const body = {
    bodyId,
    name: 'Block',
    topology: {
      faces: [
        {
          topologyId: 'f1',
          hash: 21,
          reference: side,
          triangleStart: 0,
          triangleCount: 0,
          geometry: { surfaceType: 'cylinder', area: 1, center: line.origin }
        },
        {
          topologyId: 'f2',
          hash: 22,
          triangleStart: 0,
          triangleCount: 0,
          geometry: { surfaceType: 'plane', area: 1, center: line.origin }
        }
      ],
      edges: [
        { topologyId: 'e1', hash: 11, reference: straight },
        { topologyId: 'e2', hash: 12, reference: arc },
        { topologyId: 'e3', hash: 13 }
      ]
    }
  } as unknown as BodyRepresentation;
  return {
    ...document,
    derived: {
      ...document.derived,
      bodyRepresentations: { [bodyId]: body }
    }
  };
}

describe('Axis card state', () => {
  it('validates each mode and builds its definition', () => {
    const state = newDatumAxisFormState('Axis 1');
    expect(datumAxisFormValidation(state, {})).toEqual({
      kind: 'missing',
      reason: 'Pick an edge end for the first point, or type its position.'
    });
    const typed = {
      ...state,
      points: [
        { type: 'typed', x: '0', y: '0', z: '0' },
        { type: 'typed', x: '0', y: '0', z: 'h' }
      ]
    } as typeof state;
    expect(datumAxisFormValidation(typed, { h: 5 })).toBeNull();
    expect(buildDatumAxisDefinition(typed).kind).toBe('two-point');
    expect(
      datumAxisFormValidation({ ...state, mode: 'edge' }, {})?.reason
    ).toMatch(/straight edge/);
    expect(
      datumAxisFormValidation(
        { ...state, mode: 'plane-intersection', sourceA: XZ, sourceB: XZ },
        {}
      )?.reason
    ).toMatch(/two different planes/);
  });

  it('reopens every kind as it was authored', () => {
    const made = addDatumAxis(createProjectDocument('Axes', user), {
      name: 'Crossing',
      definition: {
        kind: 'plane-intersection',
        sources: [XZ, YZ],
        reverseDirection: true
      }
    });
    const feature = made.document.nodes[
      Object.keys(made.document.nodes).find(
        (id) =>
          (made.document.nodes[id] as FeatureNode).featureId === made.featureId
      )!
    ] as FeatureNode;
    const state = datumAxisFormStateFromFeature(feature);
    expect(state).toMatchObject({
      name: 'Crossing',
      mode: 'plane-intersection',
      sourceA: XZ,
      sourceB: YZ,
      reverseDirection: true
    });
    expect(buildDatumAxisDefinition(state)).toEqual({
      kind: 'plane-intersection',
      sources: [XZ, YZ],
      reverseDirection: true
    });
    expect(datumAxisDescription(made.document, feature, {}, 'mm')).toBe(
      'Where Front (XZ) meets Right (YZ), reversed'
    );
    expect(nextDatumAxisName(made.document)).toBe('Axis 1');
  });

  it('commits a new axis under the id it was checked with', () => {
    const { command, featureId } = datumAxisCommand(
      {
        name: 'Axis 1',
        definition: { kind: 'plane-intersection', sources: [XZ, YZ] }
      },
      null
    );
    expect(command.serialize()).toMatchObject({ kind: 'feature.datum-axis' });
    expect(
      command.apply(createProjectDocument('Axes', user)).featureOrder
    ).toContain(featureId);
  });
});

describe('what a pick can give the Axis card', () => {
  const document = withBody(createProjectDocument('Picks', user));
  const bodyId = toBodyId('body_block');

  it('takes a straight edge with lineage, refusing a curved or unnamed one', () => {
    expect(
      datumAxisEdgeFromPick(document, { kind: 'edge', bodyId, hash: 11 })
    ).toEqual({ type: 'edge', bodyId, edgeReference: straight });
    expect(
      datumAxisEdgeFromPick(document, { kind: 'edge', bodyId, hash: 12 })
    ).toEqual({
      reason: 'An axis runs along a straight edge; this edge is curved.'
    });
    expect(
      datumAxisEdgeFromPick(document, { kind: 'edge', bodyId, hash: 13 })
    ).toHaveProperty('reason', expect.stringMatching(/no identity/));
  });

  it('takes a cylinder, refusing a flat face', () => {
    expect(
      datumAxisFaceFromPick(document, { kind: 'face', bodyId, hash: 21 })
    ).toEqual({ type: 'face', bodyId, faceReference: side });
    expect(
      datumAxisFaceFromPick(document, { kind: 'face', bodyId, hash: 22 })
    ).toHaveProperty('reason', expect.stringMatching(/cylindrical or conical/));
  });
});

describe('axis lists, display and repair', () => {
  function document() {
    let doc = addPrimitiveFeature(createProjectDocument('Axes', user), {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 2, height: 2, depth: 2 }
    });
    const bodyId = doc.bodyOrder[0]!;
    const axis = addDatumAxis(doc, {
      name: 'Spin',
      definition: { kind: 'plane-intersection', sources: [XZ, YZ] }
    });
    doc = patternBody(axis.document, {
      name: 'Ring',
      targetBodyId: bodyId,
      patternKind: 'circular',
      count: 4,
      axis: 'z',
      axisRef: { type: 'datum-axis', datumFeatureId: axis.featureId }
    }).document;
    return { doc, axisId: axis.featureId };
  }

  it('lists axes with what turns about them, and offers earlier ones', () => {
    const { doc, axisId } = document();
    const resolved = {
      ...doc,
      derived: { ...doc.derived, datumAxes: { [axisId]: line } }
    };
    expect(datumAxisRows(resolved, {})).toEqual([
      expect.objectContaining({
        name: 'Spin',
        dependents: ['Ring'],
        resolved: true,
        description: 'Where Front (XZ) meets Right (YZ)'
      })
    ]);
    expect(datumAxisChoices(doc, null)).toEqual([
      { featureId: axisId, name: 'Spin' }
    ]);
    expect(datumAxisChoices(doc, axisId)).toEqual([]);
    expect(datumAxisDisplays(resolved, new Set(), axisId)).toEqual([
      { featureId: axisId, name: 'Spin', axis: line, selected: true }
    ]);
    expect(datumAxisDisplays(resolved, new Set([axisId]), null)).toEqual([]);
    expect(datumAxisDisplays(doc, new Set(), null)).toEqual([]);
  });

  it('requires a new or edited axis to resolve to a line', () => {
    const { doc, axisId } = document();
    expect(() =>
      requireResolvedDatums(doc, doc.derived, axisId, 'Spin', 'datum-axis')
    ).toThrow('Spin did not resolve to an axis.');
    expect(() =>
      requireResolvedDatums(
        doc,
        { ...doc.derived, datumAxes: { [axisId]: line } },
        axisId,
        'Spin'
      )
    ).not.toThrow();
  });

  it('a plane edit checks the axes built on it', () => {
    const lid = addDatumPlane(createProjectDocument('Axes', user), {
      name: 'Lid',
      definition: { kind: 'offset', source: XZ, offset: 5 }
    });
    const axis = addDatumAxis(lid.document, {
      name: 'Hinge',
      definition: {
        kind: 'plane-intersection',
        sources: [{ type: 'datum', datumFeatureId: lid.featureId }, YZ]
      }
    });
    const frame = {
      origin: { x: 0, y: 0, z: 0 },
      u: { x: 1, y: 0, z: 0 },
      v: { x: 0, y: 0, z: 1 },
      normal: { x: 0, y: -1, z: 0 }
    };
    const before = {
      ...axis.document,
      derived: {
        ...axis.document.derived,
        datumFrames: { [lid.featureId]: frame },
        datumAxes: { [axis.featureId]: line }
      }
    };
    expect(() =>
      requireResolvedDatums(
        before,
        { ...before.derived, datumAxes: {} },
        lid.featureId,
        'Lid'
      )
    ).toThrow('Hinge did not resolve to an axis.');
  });

  it('re-picks a lost edge source in one validated edit', () => {
    const base = withBody(createProjectDocument('Repair', user));
    const bodyId = toBodyId('body_block');
    const axis = addDatumAxis(
      { ...base, bodyOrder: [bodyId] },
      {
        name: 'Hinge',
        definition: {
          kind: 'edge',
          source: {
            type: 'edge',
            bodyId,
            edgeReference: { ...straight, lineageName: 'edge.gone' }
          },
          reverseDirection: true
        }
      }
    );
    const doc = { ...axis.document, derived: base.derived };
    const edit = datumAxisSourceRepairEdit(doc, axis.featureId, {
      kind: 'edge',
      bodyId,
      hash: 11,
      topologyId: 'e1'
    });
    expect(edit.label).toBe('Re-pick source for Hinge');
    expect(edit.command.payload).toMatchObject({
      featureId: axis.featureId,
      data: {
        definition: {
          kind: 'edge',
          source: { edgeReference: straight },
          reverseDirection: true
        }
      }
    });
    expect(() =>
      datumAxisSourceRepairEdit(doc, axis.featureId, {
        kind: 'edge',
        bodyId,
        hash: 12,
        topologyId: 'e2'
      })
    ).toThrow(/curved/);
    expect(() =>
      datumAxisSourceRepairEdit(doc, axis.featureId, {
        kind: 'face',
        bodyId,
        hash: 21,
        topologyId: 'f1'
      })
    ).toThrow(/Click a straight edge for "Hinge"/);
  });

  it('offers a re-pick only for the build’s own lost-source failure', () => {
    const feature = {
      featureId: 'feat_axis' as FeatureId,
      name: 'Hinge'
    } as FeatureNode;
    const warning = (message: string): FeatureWarning =>
      ({
        featureId: feature.featureId,
        message,
        kind: 'build-failed'
      }) as FeatureWarning;
    expect(
      datumAxisSourceFailed(feature, [
        warning(
          'Datum axis "Hinge" cannot run along an edge of source feature "Block": its edge was deleted.'
        )
      ])
    ).toBe(true);
    expect(
      datumAxisSourceFailed(feature, [
        warning('An axis through two points needs two separate points.')
      ])
    ).toBe(false);
  });
});
