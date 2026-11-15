import { describe, expect, it } from 'vitest';
import type { BodyClashVerdict } from '@openzcad/shared';
import { describeInterference } from './interferenceUi';

const clear = (
  patch: Partial<Extract<BodyClashVerdict, { kind: 'clear' }>>
): BodyClashVerdict => ({
  kind: 'clear',
  touching: false,
  distance: null,
  closest: null,
  atLeast: null,
  ...patch
});

describe('interference wording (AS04)', () => {
  it('says which exact boolean measured an overlap, and in the document unit', () => {
    const text = describeInterference(
      {
        kind: 'interference',
        volume: 13.37395622,
        proof: 'difference',
        point: { x: 1, y: 2, z: 3 },
        bounds: null,
        complete: true
      },
      'inch'
    );
    expect(text).toEqual({
      tone: 'interference',
      value: '13.37 in³',
      detail:
        '13.37 in³ shared, measured by an exact difference. Inside both at (1, 2, 3) in.'
    });
  });

  it('marks an incomplete volume as a lower bound and an unmeasured one as unmeasured', () => {
    const base = {
      kind: 'interference' as const,
      point: null,
      bounds: null
    };
    expect(
      describeInterference(
        { ...base, volume: 4, proof: 'intersect', complete: false },
        'mm'
      ).value
    ).toBe('≥ 4 mm³');
    const unmeasured = describeInterference(
      { ...base, volume: null, proof: 'point', complete: false },
      'mm'
    );
    expect(unmeasured.value).toBe('Overlap');
    expect(unmeasured.detail).toMatch(/could not measure/);
  });

  it('separates contact, certified gaps and unmeasured clearance', () => {
    expect(
      describeInterference(clear({ touching: true, distance: 0 }), 'mm').value
    ).toBe('Touching');
    expect(
      describeInterference(
        clear({
          distance: 2,
          atLeast: 2,
          closest: [
            { x: 10, y: 0, z: 0 },
            { x: 12, y: 0, z: 0 }
          ]
        }),
        'mm'
      )
    ).toEqual({
      tone: 'clear',
      value: '2 mm gap',
      detail:
        'Certified minimum distance 2 mm, between (10, 0, 0) mm and (12, 0, 0) mm.'
    });
    expect(describeInterference(clear({ atLeast: 17 }), 'mm').detail).toBe(
      'No shared volume; at least 17 mm apart.'
    );
    expect(describeInterference(clear({ touching: null }), 'mm').detail).toBe(
      'No shared volume. Whether the parts touch is not certified on these surfaces.'
    );
  });
});
