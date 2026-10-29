import { describe, expect, it } from 'vitest';
import { extrudeSidesConflict } from '@openzcad/document-core';
import {
  toBodyId,
  toFeatureId,
  toSketchId,
  type ExtrudeToFaceTarget,
  type FeatureNode
} from '@openzcad/shared';
import {
  extrudeFormValue,
  initialExtrudeDraft,
  type ExtrudeDraft,
  type ExtrudeDraftContext,
  type ExtrudeToFacePicking
} from './extrudeDraft';
import {
  extrudeEditCommand,
  extrudeEditData,
  extrudeEditInitial
} from './extrudeEditing';

type ExtrudeData = Extract<FeatureNode['data'], { featureKind: 'extrude' }>;

const sketchId = toSketchId('layout');
const plate = toBodyId('plate');
const face = { type: 'face', bodyId: plate } as unknown as ExtrudeToFaceTarget;
const picking: ExtrudeToFacePicking = {
  armed: false,
  onPick: () => {},
  cancel: () => {},
  describe: () => ({ label: 'Ceiling', distance: 6 }),
  setterRef: { current: null }
};

function feature(data: Partial<ExtrudeData>): FeatureNode {
  return {
    id: 'node_post',
    kind: 'feature',
    name: 'Post',
    parentId: null,
    revisionId: null,
    featureId: toFeatureId('feature_post'),
    featureKind: 'extrude',
    bodyId: toBodyId('post'),
    data: { featureKind: 'extrude', sketchId, distance: 10, ...data }
  } as unknown as FeatureNode;
}

/** The edit as Done would send it, after `change` (nothing: untouched). */
function edited(
  node: FeatureNode,
  change: (draft: ExtrudeDraft) => Partial<ExtrudeDraft> = () => ({})
) {
  const initial = extrudeEditInitial(node);
  const ctx: ExtrudeDraftContext = {
    scope: { thickness: 8 },
    units: 'mm',
    initial,
    bodies: [{ bodyId: plate, name: 'Plate' }],
    toFacePicking: picking
  };
  const draft = initialExtrudeDraft(initial, false);
  return extrudeEditData(
    node.data as ExtrudeData,
    extrudeFormValue({ ...draft, ...change(draft) }, ctx)
  );
}

describe('extrude edit in place', () => {
  it.each([
    ['a legacy one-sided new body', {}],
    ['a symmetric expression', { distance: 'thickness * 2', symmetric: true }],
    ['a back distance', { backDistance: 'thickness / 4' }],
    ['explicit defaults', { symmetric: false, backDistance: 0 }],
    ['a cut into a target', { operation: 'cut', targetBodyId: plate }],
    [
      'a through-all cut',
      {
        operation: 'cut',
        targetBodyId: plate,
        endCondition: 'through-all',
        throughAllSide: 'both'
      }
    ],
    [
      'a drafted extrude to a face',
      { endCondition: 'to-face', toFace: face, draftAngleDeg: '2 deg' }
    ],
    ['a stored straight-wall draft', { draftAngleDeg: 0 }],
    ['an explicit blind extent', { endCondition: 'blind' }]
  ] as [string, Partial<ExtrudeData>][])(
    'writes %s back exactly as stored when nothing changes',
    (_name, data) => {
      const node = feature(data);
      expect(edited(node)).toEqual(node.data);
    }
  );

  // F002 (edit path): switching an extrude that stores a back distance to
  // Symmetric must not leave the two side by side for the document to
  // refuse. The field cannot be cleared, so it is zeroed.
  it('zeroes a stored back distance when the edit switches to Symmetric', () => {
    const twoSided = feature({ backDistance: 5 });
    const data = edited(twoSided, () => ({ symmetric: true }));
    expect(data).toMatchObject({ symmetric: true, backDistance: 0 });
    expect(extrudeSidesConflict(data)).toBe(false);
    // A stored zero keeps its written form; an absent one stays absent.
    expect(
      edited(feature({ backDistance: '0' }), () => ({ symmetric: true }))
    ).toMatchObject({ symmetric: true, backDistance: '0' });
    expect(edited(feature({}), () => ({ symmetric: true }))).not.toHaveProperty(
      'backDistance'
    );
  });

  it('seeds the draft from the stored feature, expressions as written', () => {
    const initial = extrudeEditInitial(
      feature({
        distance: 'thickness',
        operation: 'add',
        targetBodyId: plate,
        endCondition: 'through-all',
        throughAllSide: 'backward',
        draftAngleDeg: '3'
      })
    );
    expect(initialExtrudeDraft(initial, false)).toMatchObject({
      name: 'Post',
      distance: 'thickness',
      choice: { operation: 'add', targetBodyId: plate },
      endCondition: 'through-all',
      throughAllSide: 'backward',
      draftAngle: '3'
    });
    // A legacy feature with no stored operation is a new body, not inferred.
    expect(
      initialExtrudeDraft(extrudeEditInitial(feature({})), false).choice
    ).toEqual({ operation: 'new-body' });
  });

  it('writes what changed, and clears what the new extent no longer uses', () => {
    const cut = feature({
      operation: 'cut',
      targetBodyId: plate,
      endCondition: 'through-all',
      throughAllSide: 'both',
      draftAngleDeg: 2
    });
    // Back to a blind new body: the extent, its side and the operation go.
    const blind = edited(cut, () => ({
      endCondition: 'blind',
      choice: { operation: 'new-body' },
      distance: '12'
    }));
    expect(blind).toMatchObject({ distance: 12, operation: 'new-body' });
    expect(blind).not.toHaveProperty('endCondition');
    expect(blind).not.toHaveProperty('throughAllSide');
    const command = extrudeEditCommand(cut, {
      ...extrudeFormValue(
        {
          ...initialExtrudeDraft(extrudeEditInitial(cut), false),
          endCondition: 'blind',
          choice: { operation: 'new-body' },
          draftAngle: '0'
        },
        {
          scope: {},
          units: 'mm',
          initial: extrudeEditInitial(cut),
          bodies: []
        }
      )
    });
    expect(command.payload).toMatchObject({
      clearData: ['endCondition', 'throughAllSide', 'draftAngleDeg']
    });
  });

  it('refuses an automatic operation, a missing target and a missing face', () => {
    const node = feature({});
    const base = extrudeFormValue(
      initialExtrudeDraft(extrudeEditInitial(node), false),
      {
        scope: {},
        units: 'mm',
        initial: extrudeEditInitial(node),
        bodies: [],
        toFacePicking: picking
      }
    );
    expect(() =>
      extrudeEditCommand(node, { ...base, choice: { operation: 'automatic' } })
    ).toThrow('Choose New Body, Add, Cut, or Intersect');
    expect(() =>
      extrudeEditCommand(node, { ...base, choice: { operation: 'cut' } })
    ).toThrow('Select a target body');
    expect(() =>
      extrudeEditCommand(node, { ...base, endCondition: 'to-face' })
    ).toThrow('Pick the face');
  });
});
