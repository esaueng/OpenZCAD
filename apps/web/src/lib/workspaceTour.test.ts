import { describe, expect, it } from 'vitest';
import {
  advanceThroughCompleted,
  WORKSPACE_TOUR_STEPS,
  type WorkspaceTourSignals
} from './workspaceTour';

const signals = (
  over: Partial<WorkspaceTourSignals> = {}
): WorkspaceTourSignals => ({
  featureCount: 0,
  hasSelection: false,
  exportSeen: false,
  ...over
});

describe('workspace tour', () => {
  it('keeps every step teachable and uniquely identified', () => {
    const ids = WORKSPACE_TOUR_STEPS.map((step) => step.id);
    expect(new Set(ids).size).toBe(WORKSPACE_TOUR_STEPS.length);
    for (const step of WORKSPACE_TOUR_STEPS) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.body.length).toBeGreaterThan(0);
    }
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

  it('never leapfrogs the manual history step', () => {
    // Export progress cannot carry the tour past the step the app cannot
    // observe: the user still gets told about the history.
    expect(
      advanceThroughCompleted(
        0,
        signals({ featureCount: 1, hasSelection: true, exportSeen: true })
      )
    ).toBe(2);
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
