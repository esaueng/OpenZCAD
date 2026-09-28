import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type FaceTopology,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import { ghostBodiesFor, historyFeatureFocus } from './historyFocus';

function body(
  bodyId: BodyId,
  consumed: boolean,
  faces: Pick<FaceTopology, 'topologyId' | 'hash' | 'reference'>[] = []
): BodyRepresentation {
  return {
    bodyId,
    name: bodyId,
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2])
    },
    faceCount: faces.length,
    color: '#888',
    exportableStep: true,
    consumed,
    volume: 1,
    bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    topology: {
      faces: faces.map((face) => ({
        ...face,
        triangleStart: 0,
        triangleCount: 1
      })),
      edges: []
    }
  } as unknown as BodyRepresentation;
}

/**
 * A face as the kernel names it on a finished part: produced by the LAST
 * boolean, with the operand path back to its origin in the lineage name.
 */
function faceFrom(
  featureId: FeatureId,
  topologyId: string,
  hash: number,
  lineageName: string
) {
  return {
    topologyId,
    hash,
    reference: {
      kind: 'face' as const,
      producingFeatureId: featureId,
      lineageName,
      currentHash: hash,
      witnessVersion: 1 as const,
      witness: {} as never
    }
  };
}

/** Base and Boss boxes unioned into a Bracket, with hand-made projections. */
function bracket(bossFacesSurvive: boolean) {
  let doc = createProjectDocument('Focus', toUserId('user_test'));
  doc = addPrimitiveFeature(doc, {
    name: 'Base',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 20, depth: 5 }
  });
  doc = addPrimitiveFeature(doc, {
    name: 'Boss',
    primitiveKind: 'box',
    dimensions: { width: 10, height: 10, depth: 10 }
  });
  const [baseId, bossId] = doc.bodyOrder as [BodyId, BodyId];
  const union = booleanBodies(doc, {
    name: 'Bracket',
    operation: 'union',
    targetBodyIds: [baseId, bossId]
  });
  doc = union.document;
  const [base, boss, bracketFeature] = listFeaturesInOrder(doc);
  const representations: ProjectDocument['derived']['bodyRepresentations'] = {
    [baseId]: body(baseId, true),
    [bossId]: body(bossId, true),
    [union.bodyId]: body(union.bodyId, false, [
      faceFrom(
        bracketFeature!.featureId,
        'base-top',
        1,
        'boolean.face.operand.0.primitive.box.face.z-max'
      ),
      ...(bossFacesSurvive
        ? [
            faceFrom(
              bracketFeature!.featureId,
              'boss-top',
              2,
              'boolean.face.operand.1.primitive.box.face.z-max'
            ),
            faceFrom(
              bracketFeature!.featureId,
              'boss-side',
              3,
              'boolean.face.operand.1.primitive.box.face.x-min'
            )
          ]
        : []),
      faceFrom(bracketFeature!.featureId, 'seam', 4, 'boolean.face.seam')
    ])
  };
  doc = {
    ...doc,
    derived: { ...doc.derived, bodyRepresentations: representations }
  };
  const visible = (id: BodyId) =>
    Boolean(representations[id] && !representations[id].consumed);
  return {
    doc,
    base: base!,
    boss: boss!,
    bracket: bracketFeature!,
    visible,
    bracketBodyId: union.bodyId
  };
}

describe('historyFeatureFocus', () => {
  it('selects the body of a feature still on screen', () => {
    const { doc, bracket: feature, visible, bracketBodyId } = bracket(true);
    expect(historyFeatureFocus(doc, feature, visible)).toEqual({
      kind: 'bodies',
      bodyIds: [bracketBodyId]
    });
  });

  it('lights only the faces a consumed feature made on the final part', () => {
    const { doc, boss, visible, bracketBodyId } = bracket(true);
    const focus = historyFeatureFocus(doc, boss, visible);
    expect(focus.kind).toBe('focus');
    if (focus.kind !== 'focus') return;
    expect(focus.faces.map((face) => face.topologyId)).toEqual([
      'boss-top',
      'boss-side'
    ]);
    expect(focus.faces.every((face) => face.bodyId === bracketBodyId)).toBe(
      true
    );
    expect(focus.ghostBodyIds).toEqual([]);
    expect(ghostBodiesFor(doc, focus)).toEqual([]);
  });

  it('ghosts the consumed body when none of its faces survived', () => {
    const { doc, boss, visible } = bracket(false);
    const focus = historyFeatureFocus(doc, boss, visible);
    expect(focus).toEqual({
      kind: 'focus',
      faces: [],
      ghostBodyIds: [doc.bodyOrder[1]]
    });
    expect(ghostBodiesFor(doc, focus).map((ghost) => ghost.bodyId)).toEqual([
      doc.bodyOrder[1]
    ]);
  });

  it('falls back to the downstream bodies when there is nothing to show', () => {
    const { doc, boss, visible, bracketBodyId } = bracket(false);
    const bossBody = doc.bodyOrder[1] as BodyId;
    const stripped = {
      ...doc,
      derived: {
        ...doc.derived,
        bodyRepresentations: {
          ...doc.derived.bodyRepresentations,
          [bossBody]: {
            ...doc.derived.bodyRepresentations[bossBody]!,
            mesh: {
              kind: 'mesh' as const,
              vertices: new Float32Array(),
              indices: new Uint32Array()
            }
          }
        }
      }
    };
    expect(historyFeatureFocus(stripped, boss, visible)).toEqual({
      kind: 'bodies',
      bodyIds: [bracketBodyId]
    });
  });
});
