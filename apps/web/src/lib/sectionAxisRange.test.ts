import { describe, expect, it } from 'vitest';
import { sectionAxisRangeForBodies } from './sectionAxisRange';

describe('section plane range', () => {
  const staged = {
    consumed: false,
    bbox: {
      min: { x: 100, y: 200, z: 300 },
      max: { x: 120, y: 210, z: 340 }
    }
  };

  it.each([
    ['XY', 300, 340],
    ['XZ', 200, 210],
    ['YZ', 100, 120]
  ] as const)('centers %s on the displayed staged body', (plane, min, max) => {
    const range = sectionAxisRangeForBodies(plane, [staged]);
    expect(range).toEqual({ min, max });
    expect((range!.min + range!.max) / 2).toBe((min + max) / 2);
  });

  it('excludes consumed bodies from the visible range', () => {
    const consumed = {
      consumed: true,
      bbox: {
        min: { x: -1000, y: -1000, z: -1000 },
        max: { x: 1000, y: 1000, z: 1000 }
      }
    };
    expect(sectionAxisRangeForBodies('XY', [staged, consumed])).toEqual({
      min: 300,
      max: 340
    });
  });

  it('has no sliding range without a displayed extent', () => {
    expect(sectionAxisRangeForBodies('XY', [])).toBeNull();
    expect(
      sectionAxisRangeForBodies('XY', [
        {
          consumed: false,
          bbox: { min: staged.bbox.min, max: staged.bbox.min }
        }
      ])
    ).toBeNull();
  });
});
