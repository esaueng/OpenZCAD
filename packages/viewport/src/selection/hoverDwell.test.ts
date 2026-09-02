import { describe, expect, it } from 'vitest';
import { HOVER_DWELL_MS, HoverDwell } from './hoverDwell';

const dwell = () => new HoverDwell<string>((candidate) => candidate);

describe('hover dwell', () => {
  it('commits entering geometry from empty space at once', () => {
    const hover = dwell();
    expect(hover.propose('a', 0)).toEqual({ commit: true, candidate: 'a' });
  });

  it('does nothing while the pointer stays on the committed target', () => {
    const hover = dwell();
    hover.propose('a', 0);
    expect(hover.propose('a', 10)).toEqual({ commit: false, pending: false });
  });

  it('absorbs a boundary flicker shorter than the dwell', () => {
    const hover = dwell();
    hover.propose('a', 0);
    expect(hover.propose('b', 16)).toEqual({ commit: false, pending: true });
    expect(hover.propose('a', 33)).toEqual({ commit: false, pending: false });
    expect(hover.propose('b', 50)).toEqual({ commit: false, pending: true });
    // Back on `a` again: never committed `b`, and nothing is pending.
    expect(hover.propose('a', 66)).toEqual({ commit: false, pending: false });
  });

  it('commits a neighbour once it has been seen for the dwell', () => {
    const hover = dwell();
    hover.propose('a', 0);
    expect(hover.propose('b', 100)).toEqual({ commit: false, pending: true });
    expect(hover.propose('b', 100 + HOVER_DWELL_MS - 1)).toEqual({
      commit: false,
      pending: true
    });
    expect(hover.propose('b', 100 + HOVER_DWELL_MS)).toEqual({
      commit: true,
      candidate: 'b'
    });
    expect(hover.propose('b', 200)).toEqual({ commit: false, pending: false });
  });

  it('leaves geometry only after the dwell, then re-enters at once', () => {
    const hover = dwell();
    hover.propose('a', 0);
    expect(hover.propose(null, 10)).toEqual({ commit: false, pending: true });
    expect(hover.propose(null, 10 + HOVER_DWELL_MS)).toEqual({
      commit: true,
      candidate: null
    });
    expect(hover.propose('c', 200)).toEqual({ commit: true, candidate: 'c' });
  });

  it('restarts the dwell when the pending target changes', () => {
    const hover = dwell();
    hover.propose('a', 0);
    hover.propose('b', 10);
    expect(hover.propose('c', 40)).toEqual({ commit: false, pending: true });
    expect(hover.propose('c', 40 + HOVER_DWELL_MS - 1)).toEqual({
      commit: false,
      pending: true
    });
    expect(hover.propose('c', 40 + HOVER_DWELL_MS)).toEqual({
      commit: true,
      candidate: 'c'
    });
  });

  it('measures from a hover applied outside the dwell after reset', () => {
    const hover = dwell();
    hover.propose('a', 0);
    hover.reset();
    expect(hover.propose('b', 5)).toEqual({ commit: true, candidate: 'b' });
    hover.reset('z');
    expect(hover.propose('z', 6)).toEqual({ commit: false, pending: false });
  });
});
