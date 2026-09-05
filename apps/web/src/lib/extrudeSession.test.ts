import { describe, expect, it } from 'vitest';
import { isExtrudeSessionCurrent } from './extrudeSession';
import {
  IDLE,
  interactionReducer,
  type InteractionState
} from './interaction/machine';

const session: Extract<InteractionState, { mode: 'region' }> = {
  mode: 'region',
  target: {
    sketchId: 'bores',
    regionFingerprint: 1,
    samplePoint: { x: 0, y: 0 },
    area: 20,
    sourceEntityIds: ['circle']
  },
  phase: 'armed',
  lastValue: null,
  error: null,
  extrudeChoice: { operation: 'cut' }
};

describe('extrusion session ownership', () => {
  it('allows validation phase changes but rejects canceled, restarted, changed-intent and changed-profile sessions', () => {
    const profiles = ['circle'];
    const validating = interactionReducer(session, {
      type: 'validation-start',
      value: -8
    });
    expect(
      isExtrudeSessionCurrent(session, validating, profiles, profiles)
    ).toBe(true);
    expect(isExtrudeSessionCurrent(session, IDLE, profiles, profiles)).toBe(
      false
    );
    expect(
      isExtrudeSessionCurrent(
        session,
        { ...session, target: { ...session.target } },
        profiles,
        profiles
      )
    ).toBe(false);
    expect(
      isExtrudeSessionCurrent(
        session,
        interactionReducer(session, {
          type: 'set-extrude-choice',
          choice: { operation: 'add' }
        }),
        profiles,
        profiles
      )
    ).toBe(false);
    expect(
      isExtrudeSessionCurrent(session, validating, profiles, [...profiles])
    ).toBe(false);
  });
});
