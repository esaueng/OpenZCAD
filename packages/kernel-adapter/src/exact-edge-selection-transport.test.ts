import { describe, expect, it } from 'vitest';
import type { EdgeWitnessV1 } from '@openzcad/shared';
import {
  direction,
  edgeHeading,
  EdgeSelectionMemory
} from './exact-edge-selection-transport';

describe('edge selection transport labels', () => {
  it('signs an unoriented direction by its rounded components', () => {
    // Near-axis noise on either side of zero rounds away; the sign must be
    // chosen from what is printed, or a mirror twin reads "-1" on one build
    // and "1" on the next.
    expect(direction([1e-4, 1, 0], false)).toBe('0.000,1.000,0.000');
    expect(direction([-1e-4, 1, 0], false)).toBe('0.000,1.000,0.000');
    expect(direction([-1e-4, -1, 0], false)).toBe('0.000,1.000,0.000');
    expect(direction([0, -1, 2e-4], false)).toBe('0.000,1.000,0.000');
    // A genuine lead component still decides.
    expect(direction([-0.6, 0.8, 0], false)).toBe('0.600,-0.800,0.000');
  });

  it('keeps an oriented direction’s own sense', () => {
    expect(direction([-1e-4, -1, 0], true)).toBe('0.000,-1.000,0.000');
    expect(direction([0, 0, 1], true)).toBe('0.000,0.000,1.000');
    expect(direction([0, 0, 0], true)).toBeNull();
    expect(direction([Number.NaN, 0, 1], false)).toBeNull();
  });

  it('reads a straight edge the same from either end', () => {
    const line = (
      start: [number, number, number],
      end: [number, number, number]
    ): EdgeWitnessV1 => ({
      curveType: 'LINE',
      length: 1,
      closed: false,
      endpoints: [start, end],
      midpoint: [
        (start[0] + end[0]) / 2,
        (start[1] + end[1]) / 2,
        (start[2] + end[2]) / 2
      ]
    });
    expect(edgeHeading(line([0, 0, 0], [0, 10, 0]))).toBe(
      edgeHeading(line([0, 10, 0], [0, 0, 0]))
    );
    expect(edgeHeading(line([0, 0, 0], [1, 10_000, 0]))).toBe(
      edgeHeading(line([1, 10_000, 0], [0, 0, 0]))
    );
  });
});

describe('edge selection memory', () => {
  const record = (selection: string) => ({
    edgeLabels: new Map<number, string>(),
    selected: new Map<number, string>(),
    planes: new Map<string, string>(),
    hashSet: '',
    selection,
    upstream: {
      units: 'mm',
      features: [],
      sketches: new Map(),
      scope: {},
      sizes: new Map(),
      resolved: ''
    }
  });

  it('keeps a bounded number of layouts per feature, newest last', () => {
    const memory = new EdgeSelectionMemory();
    for (let index = 0; index < 6; index += 1) {
      memory.store('feature', `layout-${index}`, record(String(index)));
    }
    expect(memory.lookup('feature', 'layout-0')).toBeUndefined();
    expect(memory.lookup('feature', 'layout-1')).toBeUndefined();
    expect(memory.lookup('feature', 'layout-2')?.selection).toBe('2');
    expect(memory.latestRecord('feature')?.selection).toBe('5');
  });

  it('forgets everything on clear, as a new adapter would', () => {
    const memory = new EdgeSelectionMemory();
    memory.store('feature', 'layout', record('a'));
    memory.clear();
    expect(memory.size).toBe(0);
    expect(memory.lookup('feature', 'layout')).toBeUndefined();
    expect(memory.latestRecord('feature')).toBeUndefined();
  });
});
