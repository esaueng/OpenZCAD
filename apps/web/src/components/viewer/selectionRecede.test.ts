import { describe, expect, it } from 'vitest';
import { SELECTION_RECEDE_MS, SelectionRecede } from './selectionRecede';

const FRAME_MS = 1000 / 60;

/** Steps until settled, recording every level drawn for `bodyId`. */
function run(recede: SelectionRecede, bodyId: string, firstDtMs = FRAME_MS) {
  const levels: number[] = [];
  let dt = firstDtMs;
  let frames = 0;
  while (
    recede.step(dt, (id, _base, level) => {
      if (id === bodyId) levels.push(level);
    })
  ) {
    dt = FRAME_MS;
    if (++frames > 1000) throw new Error('never settled');
  }
  return levels;
}

describe('selection recede', () => {
  it('starts a body it has not seen at its target, with nothing to ease', () => {
    const recede = new SelectionRecede();
    expect(recede.set('a', '#cccccc', 1, true)).toBe(1);
    expect(recede.animating).toBe(false);
    expect(recede.step(FRAME_MS, () => undefined)).toBe(false);
  });

  it('eases the recede on over about SELECTION_RECEDE_MS, never in one frame', () => {
    const recede = new SelectionRecede();
    recede.set('a', '#cccccc', 0, false);
    // The first frame of the ease draws the body where it was.
    expect(recede.set('a', '#cccccc', 1, true)).toBe(0);
    expect(recede.animating).toBe(true);
    // A long idle gap before the first frame does not land the ease there.
    const levels = run(recede, 'a', 2_000);
    expect(levels.at(-1)).toBe(1);
    expect(levels[0]!).toBeLessThan(0.1);
    for (let index = 1; index < levels.length; index++) {
      expect(levels[index]!).toBeGreaterThan(levels[index - 1]!);
      // No frame moves more than a third of the way.
      expect(levels[index]! - levels[index - 1]!).toBeLessThan(0.34);
    }
    const frames = levels.length;
    expect(frames).toBeGreaterThanOrEqual(
      Math.floor(SELECTION_RECEDE_MS / FRAME_MS)
    );
    expect(frames).toBeLessThanOrEqual(
      Math.ceil(SELECTION_RECEDE_MS / FRAME_MS) + 1
    );
    expect(recede.animating).toBe(false);
  });

  it('eases the recede off the same way', () => {
    const recede = new SelectionRecede();
    recede.set('a', '#cccccc', 1, false);
    recede.set('a', '#cccccc', 0, true);
    const levels = run(recede, 'a');
    expect(levels.at(-1)).toBe(0);
    expect(levels.every((level, i) => i === 0 || level < levels[i - 1]!)).toBe(
      true
    );
  });

  it('cuts when asked to, as a change of which body is picked does', () => {
    const recede = new SelectionRecede();
    recede.set('a', '#cccccc', 0, false);
    expect(recede.set('a', '#cccccc', 1, false)).toBe(1);
    expect(recede.animating).toBe(false);
  });

  it('keeps an ease in flight when the same target is set again', () => {
    // Bodies passes re-run mid-ease (a rebuilt mesh, a new callout); each one
    // must continue from where the ease is, not restart or land it.
    const recede = new SelectionRecede();
    recede.set('a', '#cccccc', 0, false);
    recede.set('a', '#cccccc', 1, true);
    recede.step(FRAME_MS, () => undefined);
    recede.step(FRAME_MS, () => undefined);
    const midway = recede.level('a')!;
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(1);
    expect(recede.set('a', '#cccccc', 1, false)).toBe(midway);
    expect(recede.animating).toBe(true);
  });

  it('turns back from wherever it is, over the remaining distance', () => {
    const recede = new SelectionRecede();
    recede.set('a', '#cccccc', 0, false);
    recede.set('a', '#cccccc', 1, true);
    for (let frame = 0; frame < 3; frame++)
      recede.step(FRAME_MS, () => undefined);
    const turned = recede.level('a')!;
    expect(recede.set('a', '#cccccc', 0, true)).toBe(turned);
    const levels = run(recede, 'a');
    // No jump back to either end: it leaves from where it turned.
    expect(Math.abs(levels[0]! - turned)).toBeLessThan(0.34);
    expect(levels.at(-1)).toBe(0);
  });

  it('applies only bodies that moved, and forgets ones no longer drawn', () => {
    const recede = new SelectionRecede();
    recede.set('a', '#cccccc', 0, false);
    recede.set('b', '#888888', 1, false);
    recede.set('a', '#cccccc', 1, true);
    const applied: [string, unknown][] = [];
    recede.step(FRAME_MS, (id, base) => applied.push([id, base]));
    expect(applied).toEqual([['a', '#cccccc']]);
    recede.retain(new Set(['b']));
    expect(recede.level('a')).toBeUndefined();
    expect(recede.animating).toBe(false);
    expect([...recede.levels()]).toEqual([['b', 1]]);
  });
});
