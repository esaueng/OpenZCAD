import { describe, expect, it } from 'vitest';
import { SpaceMouseNavigation } from './spaceMouseNavigation';

describe('SpaceMouse navigation', () => {
  it('integrates held motion from both reports and stops on release or timeout', () => {
    const nav = new SpaceMouseNavigation();
    nav.receive({ kind: 'translation', value: [350, 350, 350] }, 100, true);
    nav.receive({ kind: 'rotation', value: [350, 350, 350] }, 100, true);
    const step = nav.step(100)!;
    expect(step.panX).toBeCloseTo(1 / 60);
    expect(step.panY).toBeCloseTo(-1 / 60);
    expect(step.zoom).toBeCloseTo(-1.6 / 60);
    expect(step.pitch).toBeCloseTo(-2.2 / 60);
    expect(step.yaw).toBeCloseTo(2.2 / 60);
    expect(step.roll).toBeCloseTo(-2.2 / 60);
    expect(nav.step(110)?.panX).toBeCloseTo(0.01);
    nav.receive({ kind: 'translation', value: [0, 0, 0] }, 115, true);
    const afterTranslationRelease = nav.step(116);
    expect(afterTranslationRelease?.panX).toBe(0);
    expect(afterTranslationRelease?.roll).toBeLessThan(0);
    expect(nav.step(251)).toBeNull();
  });

  it('ignores jitter and background motion and clears input on disconnect', () => {
    const nav = new SpaceMouseNavigation();
    nav.receive({ kind: 'translation', value: [12, -12, 0] }, 0, true);
    nav.receive({ kind: 'rotation', value: [350, 0, 0] }, 0, false);
    expect(nav.step(0)).toBeNull();
    nav.receive({ kind: 'rotation', value: [350, 0, 0] }, 1, true);
    expect(nav.moving).toBe(true);
    nav.receive({ kind: 'disconnected' }, 2, true);
    expect(nav.step(2)).toBeNull();
  });

  it('uses button down edges and preserves pan when rotation is locked', () => {
    const nav = new SpaceMouseNavigation();
    const fit = 1 << 1;
    const toggle = 1 << 26;
    expect(nav.receive({ kind: 'buttons', value: fit }, 0, false)).toEqual([]);
    expect(nav.receive({ kind: 'buttons', value: fit }, 1, true)).toEqual([]);
    expect(nav.receive({ kind: 'buttons', value: toggle }, 2, true)).toEqual([
      'toggle-rotation'
    ]);
    nav.receive({ kind: 'translation', value: [350, 0, 0] }, 3, true);
    nav.receive({ kind: 'rotation', value: [350, 0, 0] }, 3, true);
    expect(nav.step(4)?.panX).toBeGreaterThan(0);
    expect(nav.step(5)?.pitch).toBeCloseTo(0);
    expect(
      nav.receive({ kind: 'buttons', value: fit | toggle }, 6, true)
    ).toEqual(['fit']);
    nav.receive({ kind: 'buttons', value: 0 }, 7, true);
    expect(nav.receive({ kind: 'buttons', value: toggle }, 8, true)).toEqual([
      'toggle-rotation'
    ]);
    nav.receive({ kind: 'rotation', value: [350, 0, 0] }, 9, true);
    expect(nav.step(10)?.pitch).toBeLessThan(0);
  });
});
