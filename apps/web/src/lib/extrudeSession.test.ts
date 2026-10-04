import { describe, expect, it } from 'vitest';
import { isExtrudeSessionCurrent } from './extrudeSession';
import {
  IDLE,
  interactionReducer,
  type InteractionState
} from './interaction/machine';

const bore = {
  sketchId: 'bores',
  regionFingerprint: 1,
  samplePoint: { x: 0, y: 0 },
  area: 20,
  sourceEntityIds: ['circle']
};
const session: Extract<InteractionState, { mode: 'region' }> = {
  mode: 'region',
  target: bore,
  targets: [bore],
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
    // A region added or removed after the commit started is a new session.
    expect(
      isExtrudeSessionCurrent(
        session,
        { ...session, targets: [...session.targets] },
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
