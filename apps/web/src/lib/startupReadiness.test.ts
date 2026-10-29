import { afterEach, describe, expect, it } from 'vitest';
import {
  INPUT_READY_MARK,
  MODEL_VISIBLE_MARK,
  createReadinessReporter
} from './startupReadiness';

const names = () =>
  performance
    .getEntriesByType('mark')
    .map((entry) => entry.name)
    .filter((name) => name === MODEL_VISIBLE_MARK || name === INPUT_READY_MARK);

afterEach(() => {
  performance.clearMarks(MODEL_VISIBLE_MARK);
  performance.clearMarks(INPUT_READY_MARK);
});

describe('startup readiness marks', () => {
  it('marks the first exact frame, then the first analysed one, once per project', () => {
    const report = createReadinessReporter();
    report({ projectId: 'a', analysis: 'pending' }, 3);
    expect(names()).toEqual([MODEL_VISIBLE_MARK]);
    report({ projectId: 'a', analysis: 'pending' }, 3);
    report({ projectId: 'a', analysis: 'ready' }, 3);
    report({ projectId: 'a', analysis: 'ready' }, 4);
    expect(names()).toEqual([MODEL_VISIBLE_MARK, INPUT_READY_MARK]);
    // Opening another project is a new open with its own pair.
    report({ projectId: 'b', analysis: 'ready' }, 1);
    expect(names()).toEqual([
      MODEL_VISIBLE_MARK,
      INPUT_READY_MARK,
      MODEL_VISIBLE_MARK,
      INPUT_READY_MARK
    ]);
  });

  it('gives a return to a project that was ready before its own pair', () => {
    const report = createReadinessReporter();
    report({ projectId: 'a', analysis: 'ready' }, 2);
    report({ projectId: 'b', analysis: 'pending' }, 2);
    report({ projectId: 'a', analysis: 'ready' }, 2);
    expect(names()).toEqual([
      MODEL_VISIBLE_MARK,
      INPUT_READY_MARK,
      MODEL_VISIBLE_MARK,
      MODEL_VISIBLE_MARK,
      INPUT_READY_MARK
    ]);
  });

  it('ignores a frame with no bodies to show', () => {
    const report = createReadinessReporter();
    report({ projectId: 'empty', analysis: 'ready' }, 0);
    expect(names()).toEqual([]);
  });
});
