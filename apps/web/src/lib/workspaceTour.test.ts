import { describe, expect, it } from 'vitest';
import {
  advanceOnSignals,
  advanceThroughCompleted,
  tourStepBody,
  WORKSPACE_TOUR_STEPS,
  type WorkspaceTourSignals
} from './workspaceTour';

const signals = (
  over: Partial<WorkspaceTourSignals> = {}
): WorkspaceTourSignals => ({
  featureCount: 0,
  hasSelection: false,
  historyOpen: false,
  exportSeen: false,
  ...over
});

describe('workspace tour', () => {
  it('keeps every step teachable and uniquely identified', () => {
    const ids = WORKSPACE_TOUR_STEPS.map((step) => step.id);
    expect(new Set(ids).size).toBe(WORKSPACE_TOUR_STEPS.length);
    for (const step of WORKSPACE_TOUR_STEPS) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(tourStepBody(step, () => 'B').length).toBeGreaterThan(0);
    }
  });

  it('teaches the live Box key, and none when it is unbound', () => {
    const create = WORKSPACE_TOUR_STEPS[0]!;
    expect(tourStepBody(create, () => 'B')).toContain(
      'click Box (the cube), or press B, then press Enter'
    );
    expect(tourStepBody(create, () => 'J')).toContain('or press J,');
    expect(tourStepBody(create, () => undefined)).toContain(
      'click Box (the cube) then press Enter'
    );
  });

  it('speaks to a finger on a touch-only device (I12)', () => {
    for (const step of WORKSPACE_TOUR_STEPS) {
      const touch = tourStepBody(step, () => 'B', true);
      expect(touch.length).toBeGreaterThan(0);
      // No key to press, nothing to click or right-click.
      expect(touch).not.toMatch(/\bpress\b|\bclick|right-click|\bEnter\b/i);
    }
    const [create, , history] = WORKSPACE_TOUR_STEPS;
    expect(tourStepBody(create!, () => 'B', true)).toContain(
      'Tap Box (the cube)'
    );
    expect(tourStepBody(create!, () => 'B', true)).toContain('then Done');
    expect(tourStepBody(history!, () => 'B', true)).toContain(
      'touch and hold a row'
    );
    // The desktop wording is unchanged.
    expect(tourStepBody(history!, () => 'B')).toContain(
      'right-click a row for actions'
    );
  });

  it('advances exactly through the steps the user already did', () => {
    expect(advanceThroughCompleted(0, signals())).toBe(0);
    expect(advanceThroughCompleted(0, signals({ featureCount: 1 }))).toBe(1);
    expect(
      advanceThroughCompleted(
        0,
        signals({ featureCount: 1, hasSelection: true })
      )
    ).toBe(2);
  });

  it('never leapfrogs the history step', () => {
    // Neither export progress nor a History panel left open earlier carries
    // the tour past it: the user still gets told about the history.
    expect(
      advanceThroughCompleted(
        0,
        signals({
          featureCount: 1,
          hasSelection: true,
          historyOpen: true,
          exportSeen: true
        })
      )
    ).toBe(2);
  });

  it('moves on from the history step when History is opened from it', () => {
    // The step stayed put while the user did exactly what it asked.
    const shown = signals({ featureCount: 1, hasSelection: true });
    expect(advanceOnSignals(2, shown, { ...shown, historyOpen: true })).toBe(3);
    // Opened and the export dialog already seen: nothing is left to teach.
    expect(
      advanceOnSignals(
        2,
        { ...shown, exportSeen: true },
        { ...shown, exportSeen: true, historyOpen: true }
      )
    ).toBe(WORKSPACE_TOUR_STEPS.length);
  });

  it("reads opening History as the history step's action only", () => {
    const open = signals({ featureCount: 1, historyOpen: true });
    // Opened during an earlier step: that step is still the one to do.
    expect(advanceOnSignals(1, signals({ featureCount: 1 }), open)).toBe(1);
    // Already open when the step comes up, or closed from it: it stays.
    expect(advanceOnSignals(2, open, { ...open, hasSelection: true })).toBe(2);
    expect(advanceOnSignals(2, open, signals({ featureCount: 1 }))).toBe(2);
  });

  it('finishes from the export step once the dialog was seen', () => {
    expect(advanceThroughCompleted(3, signals({ exportSeen: true }))).toBe(
      WORKSPACE_TOUR_STEPS.length
    );
  });

  it('never moves backwards when a signal is undone', () => {
    // A cleared selection must not send the tour back to re-teach selecting.
    expect(advanceThroughCompleted(2, signals())).toBe(2);
  });
});
