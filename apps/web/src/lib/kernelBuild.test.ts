import { describe, expect, it } from 'vitest';
import { supportsBlendGroupEdits, supportsShoulderRise } from './kernelBuild';
describe('blend-group kernel capability', () => {
  it.each(['unknown', '', '2026.1.124', '2026.1.125-rc1', 'nonsense'])(
    'keeps legacy selection for %s',
    (v) => expect(supportsBlendGroupEdits(v)).toBe(false)
  );
  it.each([
    '2026.1.125',
    '2026.1.125+local',
    '2026.1.126',
    '2026.2.0',
    '2027.1.0'
  ])('supports the paired release %s', (v) =>
    expect(supportsBlendGroupEdits(v)).toBe(true)
  );
});
describe('shoulder-rise kernel capability', () => {
  it.each(['unknown', '2026.1.155', '2026.1.156-rc1', '2026.1.155+local'])(
    'keeps the Box resize for %s',
    (v) => expect(supportsShoulderRise(v)).toBe(false)
  );
  it.each(['2026.1.156', '2026.1.156+local', '2026.2.0', '2027.1.0'])(
    'supports the paired release %s',
    (v) => expect(supportsShoulderRise(v)).toBe(true)
  );
});
