import { describe, expect, it } from 'vitest';
import {
  faceOffsetChipState,
  offsetChipText,
  regionChipState
} from './offsetChip';

describe('offset chip', () => {
  it('reads a primitive resize as its total and any other face as the change', () => {
    expect(faceOffsetChipState(20, 10)).toEqual({ mode: 'total', extent: 10 });
    expect(faceOffsetChipState(undefined, 10)).toEqual({
      mode: 'offset',
      extent: 10
    });
  });

  it('reads Total as the span plus the signed offset', () => {
    expect(
      offsetChipText({
        rawValue: -5,
        mode: 'total',
        span: 10,
        sense: 1,
        units: 'mm'
      })
    ).toBe('5 mm');
    expect(
      offsetChipText({
        rawValue: 2.004,
        mode: 'offset',
        span: 10,
        sense: 1,
        units: 'mm'
      })
    ).toBe('+2 mm');
  });

  it('starts a region drag from its own state, not the last face offset', () => {
    // The defect: a region rig reused the face rig's chip refs, so after a
    // face offset left Total mode and a 10 mm span behind, a −5 mm region
    // drag read "5 mm" under a Total tag.
    const stale = faceOffsetChipState(20, 10);
    const region = regionChipState();
    expect(region).toEqual({ mode: 'offset', extent: null });
    const reading = (state: typeof stale) =>
      offsetChipText({
        rawValue: -5,
        mode: state.mode,
        span: state.extent,
        sense: 1,
        units: 'mm'
      });
    expect(reading(stale)).toBe('5 mm');
    expect(reading(region)).toBe('-5 mm');
  });

  it('never reads Total without a span to add to', () => {
    expect(
      offsetChipText({
        rawValue: -5,
        mode: 'total',
        span: null,
        sense: 1,
        units: 'mm'
      })
    ).toBe('-5 mm');
  });
});
