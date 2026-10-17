import { describe, expect, it } from 'vitest';
import { toggleBodyIsolation } from './bodyIsolation';

const bodies = ['a', 'b', 'c', 'd'];

describe('toggleBodyIsolation', () => {
  it('restores bodies hidden before isolating instead of showing all', () => {
    const before = new Set(['c']);
    const enter = toggleBodyIsolation(bodies, 'a', before, before, null);
    expect(enter.entered).toBe(true);
    expect([...enter.hidden].sort()).toEqual(['b', 'c', 'd']);

    const leave = toggleBodyIsolation(
      bodies,
      'a',
      enter.hidden,
      enter.hidden,
      enter.isolation
    );
    expect(leave.entered).toBe(false);
    expect(leave.isolation).toBeNull();
    expect([...leave.hidden]).toEqual(['c']);
  });

  it('keeps the original hidden set when isolation moves to another body', () => {
    const before = new Set(['d']);
    const first = toggleBodyIsolation(bodies, 'a', before, before, null);
    const second = toggleBodyIsolation(
      bodies,
      'b',
      first.hidden,
      first.hidden,
      first.isolation
    );
    expect([...second.hidden].sort()).toEqual(['a', 'c', 'd']);
    const leave = toggleBodyIsolation(
      bodies,
      'b',
      second.hidden,
      second.hidden,
      second.isolation
    );
    expect([...leave.hidden]).toEqual(['d']);
  });

  it('isolates a hidden body and hides it again on leaving', () => {
    const before = new Set(['a']);
    const enter = toggleBodyIsolation(bodies, 'a', before, before, null);
    expect(enter.hidden.has('a')).toBe(false);
    const leave = toggleBodyIsolation(
      bodies,
      'a',
      enter.hidden,
      enter.hidden,
      enter.isolation
    );
    expect([...leave.hidden]).toEqual(['a']);
  });

  it('drops the snapshot once something else replaced the hidden set', () => {
    // Isolate with C hidden, then a view reset clears every hidden body.
    const before = new Set(['c']);
    const enter = toggleBodyIsolation(bodies, 'a', before, before, null);
    const reset = new Set<string>();
    // Isolating again starts a new session from the reset state, so leaving
    // it does not bring back C from before the reset.
    const again = toggleBodyIsolation(
      bodies,
      'a',
      reset,
      reset,
      enter.isolation
    );
    expect(again.entered).toBe(true);
    const leave = toggleBodyIsolation(
      bodies,
      'a',
      again.hidden,
      again.hidden,
      again.isolation
    );
    expect(leave.hidden.size).toBe(0);
  });

  it('ignores a stale snapshot when the body is alone for another reason', () => {
    const before = new Set(['c']);
    const enter = toggleBodyIsolation(bodies, 'a', before, before, null);
    // A restored view happens to hide every other body, but not through
    // this isolation: its set differs from the one isolation applied.
    const restored = new Set(['b', 'c', 'd', 'e']);
    const leave = toggleBodyIsolation(
      bodies,
      'a',
      restored,
      restored,
      enter.isolation
    );
    expect(leave.entered).toBe(false);
    expect(leave.hidden.size).toBe(0);
  });

  it('shows everything when leaving without a recorded isolation', () => {
    // A body that is alone for another reason (e.g. after a reload) has no
    // prior set to restore.
    const alone = new Set(['b', 'c', 'd']);
    const leave = toggleBodyIsolation(bodies, 'a', alone, alone, null);
    expect(leave.entered).toBe(false);
    expect(leave.hidden.size).toBe(0);
  });
});
