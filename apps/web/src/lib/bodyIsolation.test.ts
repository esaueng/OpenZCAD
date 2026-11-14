import { describe, expect, it } from 'vitest';
import {
  activeIsolatedBodyId,
  bodyIsolationState,
  persistedHiddenBodyIds,
  toggleBodyIsolation
} from './bodyIsolation';

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
    const enterAgain = toggleBodyIsolation(
      bodies,
      'a',
      restored,
      restored,
      enter.isolation
    );
    expect(enterAgain.entered).toBe(true);
    expect(enterAgain.isolation?.priorHidden).toEqual(restored);
  });

  it('does not unhide other bodies when isolating one already alone', () => {
    // A body that is alone for another reason (e.g. after a reload) has no
    // prior set to restore.
    const alone = new Set(['b', 'c', 'd']);
    const enter = toggleBodyIsolation(bodies, 'a', alone, alone, null);
    expect(enter.entered).toBe(true);
    expect(enter.hidden).toEqual(alone);
    const leave = toggleBodyIsolation(
      bodies,
      'a',
      enter.hidden,
      enter.hidden,
      enter.isolation
    );
    expect(leave.hidden).toEqual(alone);
  });

  it('reports an active isolation only while its body is alone in its own view', () => {
    const start = new Set<string>();
    const step = toggleBodyIsolation(bodies, 'a', start, start, null);
    expect(
      activeIsolatedBodyId(bodies, step.hidden, step.hidden, step.isolation)
    ).toBe('a');
    // A manual Show, an off parameter or a removed body must not leave an
    // Exit isolation control attached to the wrong view.
    expect(
      activeIsolatedBodyId(
        bodies,
        new Set(['c', 'd']),
        new Set(['c', 'd']),
        step.isolation
      )
    ).toBeNull();
    // A body created while isolated joins the view; isolation goes on.
    expect(
      activeIsolatedBodyId(
        [...bodies, 'new'],
        step.hidden,
        step.hidden,
        step.isolation
      )
    ).toBe('a');
    expect(
      activeIsolatedBodyId(bodies, new Set(bodies), step.hidden, step.isolation)
    ).toBeNull();
    expect(
      activeIsolatedBodyId(
        ['b', 'c', 'd'],
        step.hidden,
        step.hidden,
        step.isolation
      )
    ).toBeNull();
  });
});

// QA 2026-11-14 #17: isolating, then creating or editing a feature, ended
// isolation silently and left every other body hidden, through a reload.
describe('isolation across model changes', () => {
  const before = new Set(['c']);
  const enter = toggleBodyIsolation(bodies, 'a', before, before, null);

  it('keeps isolating when a feature adds a body, and Exit restores the earlier set', () => {
    const withNew = [...bodies, 'new'];
    expect(
      bodyIsolationState(
        withNew,
        enter.hidden,
        enter.hidden,
        enter.isolation,
        false
      )
    ).toEqual({ kind: 'active', bodyId: 'a' });
    const leave = toggleBodyIsolation(
      withNew,
      'a',
      enter.hidden,
      enter.hidden,
      enter.isolation
    );
    expect(leave.entered).toBe(false);
    expect([...leave.hidden]).toEqual(['c']);
  });

  it('puts back the earlier hidden set when the model takes the isolated body away', () => {
    const state = bodyIsolationState(
      ['b', 'c', 'd'],
      enter.hidden,
      enter.hidden,
      enter.isolation,
      false
    );
    expect(state).toEqual({
      kind: 'ended',
      reason: 'removed',
      hidden: new Set(['c'])
    });
    // A parameter switching the body off ends it the same way.
    expect(
      bodyIsolationState(
        bodies,
        new Set([...enter.hidden, 'a']),
        enter.hidden,
        enter.isolation,
        false
      )
    ).toMatchObject({ kind: 'ended', reason: 'hidden' });
  });

  it('waits out a preview that drops the isolated body', () => {
    expect(
      bodyIsolationState(
        ['b', 'c', 'd'],
        enter.hidden,
        enter.hidden,
        enter.isolation,
        true
      )
    ).toEqual({ kind: 'suspended' });
  });

  it('leaves a hidden set the user replaced as it is', () => {
    expect(
      bodyIsolationState(
        bodies,
        new Set(['c', 'd']),
        new Set(['c', 'd']),
        enter.isolation,
        false
      )
    ).toEqual({ kind: 'replaced' });
    expect(bodyIsolationState(bodies, before, before, null, false)).toEqual({
      kind: 'none'
    });
  });

  it('saves the hidden set from before isolating, never the isolated one', () => {
    expect(persistedHiddenBodyIds(enter.hidden, enter.isolation)).toEqual(
      before
    );
    // Once the user replaced the set, theirs is what is saved.
    const manual = new Set(['b', 'c']);
    expect(persistedHiddenBodyIds(manual, enter.isolation)).toBe(manual);
    expect(persistedHiddenBodyIds(before, null)).toBe(before);
  });
});
