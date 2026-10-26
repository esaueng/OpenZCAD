import { describe, expect, it } from 'vitest';
import { toBodyId, toSketchId } from '@openzcad/shared';
import {
  extrudeChoiceWith,
  extrudeDraftRefusal,
  extrudeDraftValue,
  initialExtrudeDraft,
  type ExtrudeDraft,
  type ExtrudeDraftContext
} from './extrudeDraft';

const sketchId = toSketchId('layout');
const plate = toBodyId('plate');
const ctx: ExtrudeDraftContext = {
  scope: { thickness: 8 },
  units: 'mm',
  initial: { name: 'Extrude', sketchId, distance: 0 },
  bodies: [{ bodyId: plate, name: 'Plate' }]
};

function draft(patch: Partial<ExtrudeDraft>): ExtrudeDraft {
  return { ...initialExtrudeDraft(ctx.initial, true), ...patch };
}

describe('extrude draft rules', () => {
  it('waits on a zero distance silently until it is edited', () => {
    expect(extrudeDraftRefusal(draft({}), ctx, false)).toBe('');
    expect(extrudeDraftRefusal(draft({}), ctx, true)).toMatch(
      /Distance cannot be zero/
    );
    expect(extrudeDraftValue(draft({ distance: 'thickness' }), ctx)).toEqual(
      expect.objectContaining({ distance: 'thickness', backDistance: 0 })
    );
  });

  it('refuses a draft beside Symmetric or a back distance, by name', () => {
    expect(
      extrudeDraftRefusal(
        draft({ distance: '10', draftAngle: '3', symmetric: true }),
        ctx,
        true
      )
    ).toBe(
      'Draft tapers a one-sided extrusion; turn off Symmetric to draft it.'
    );
    expect(
      extrudeDraftRefusal(
        draft({ distance: '10', draftAngle: '3', backDistance: '2' }),
        ctx,
        true
      )
    ).toBe(
      'Draft tapers a one-sided extrusion; clear Back distance to draft it.'
    );
    expect(
      extrudeDraftRefusal(
        draft({ distance: '10', draftAngle: '89' }),
        ctx,
        true
      )
    ).toBe('Draft must be between -89° and 89°.');
    expect(
      extrudeDraftValue(draft({ distance: '10', draftAngle: '3' }), ctx)
    ).toEqual(expect.objectContaining({ draftAngleDeg: 3 }));
  });

  it('refuses a negative back distance, and drops it for Symmetric', () => {
    expect(
      extrudeDraftRefusal(
        draft({ distance: '10', backDistance: '-1' }),
        ctx,
        true
      )
    ).toBe('Back distance cannot be negative.');
    expect(
      extrudeDraftValue(
        draft({ distance: '10', backDistance: '-1', symmetric: true }),
        ctx
      )
    ).toEqual(expect.objectContaining({ symmetric: true, backDistance: 0 }));
  });

  it('needs a target for Add, Cut and Intersect, guessing the only body', () => {
    const cut = extrudeChoiceWith(
      { operation: 'automatic' },
      'cut',
      ctx.bodies
    );
    expect(cut).toEqual({ operation: 'cut', targetBodyId: plate });
    expect(
      extrudeChoiceWith({ operation: 'automatic' }, 'cut', [
        ...ctx.bodies,
        { bodyId: toBodyId('other') }
      ])
    ).toEqual({ operation: 'cut' });
    expect(
      extrudeDraftRefusal(
        draft({ distance: '10', choice: { operation: 'intersect' } }),
        ctx,
        true
      )
    ).toBe('Select a target before applying.');
    expect(extrudeChoiceWith(cut, 'new-body', ctx.bodies)).toEqual({
      operation: 'new-body'
    });
  });

  it('sends a through-all cut with its side and a dormant distance', () => {
    expect(
      extrudeDraftValue(
        draft({
          choice: { operation: 'cut', targetBodyId: plate },
          endCondition: 'through-all',
          throughAllSide: 'both',
          draftAngle: '5'
        }),
        ctx
      )
    ).toEqual(
      expect.objectContaining({
        endCondition: 'through-all',
        throughAllSide: 'both',
        distance: 1
      })
    );
    // Off Cut, a through-all extent reads as Distance again.
    expect(
      extrudeDraftValue(
        draft({ distance: '4', endCondition: 'through-all' }),
        ctx
      )
    ).toEqual(expect.objectContaining({ endCondition: 'blind', distance: 4 }));
  });

  it('asks for the face a to-face extrude reaches', () => {
    const picking = {
      armed: false,
      onPick: () => {},
      cancel: () => {},
      describe: () => ({ label: 'Ceiling', distance: null }),
      setterRef: { current: null }
    };
    const withPick = { ...ctx, toFacePicking: picking };
    expect(
      extrudeDraftRefusal(draft({ endCondition: 'to-face' }), withPick, true)
    ).toBe('Pick the face for the extrusion to reach.');
  });
});
