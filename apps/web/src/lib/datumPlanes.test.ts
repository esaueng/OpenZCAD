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
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  buildDatumPlaneDefinition,
  datumFormStateFromFeature,
  datumFormValidation,
  datumPlaneCommand,
  datumPlaneDescription,
  datumPlaneDisplays,
  datumPlaneRows,
  datumSourceOptions,
  downstreamDatumIds,
  earlierDatumPlanes,
  newDatumPlaneFormState,
  nextDatumPlaneName,
  requireResolvedDatum,
  requireResolvedDatums
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
