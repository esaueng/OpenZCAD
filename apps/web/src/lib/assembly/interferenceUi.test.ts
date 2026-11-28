import { describe, expect, it } from 'vitest';
import type { BodyClashVerdict } from '@openzcad/shared';
import {
  checkedPartName,
  describeInterference,
  describeInterferenceSummary,
  describeSweepSummary,
  describeSweepUnknown
} from './interferenceUi';

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

describe('interference summaries (AS04)', () => {
  const none = { interfering: 0, unknown: 0, missing: 0 };

  it('claims no overlap only when every pair was decided, and names the pose (#2154)', () => {
    expect(describeInterferenceSummary(none)).toEqual({
      headline: 'No parts overlap at the rest position.',
      status: 'Interference: no parts overlap at the rest position.'
    });
    expect(
      describeInterferenceSummary({ ...none, unknown: 2, missing: 1 }).headline
    ).toBe(
      'No overlap found at the rest position, but 2 pairs could not be checked exactly and 1 part had no geometry to check.'
    );
    expect(
      describeInterferenceSummary({ interfering: 2, unknown: 1, missing: 0 })
    ).toEqual({
      headline:
        '2 pairs overlap at the rest position; 1 pair could not be checked exactly.',
      status:
        'Interference: 2 pairs of parts overlap at the rest position; 1 pair could not be checked exactly.'
    });
  });

  const swept = {
    overlapping: 0,
    unknown: 0,
    unknownEverywhere: 0,
    onlyUnknown: null,
    missing: 0,
    unchecked: 0
  };

  it('never calls a sweep clear while a pair left at rest was not checked', () => {
    expect(
      describeSweepSummary({ ...swept, unchecked: 1 }, 25, 'Hold')
    ).toEqual({
      headline:
        'No overlap found at the 25 positions checked, but 1 pair the motion leaves at rest was not checked.',
      status:
        'Interference through motion: no overlap found at 25 positions checked along Hold, but 1 pair the motion leaves at rest was not checked.'
    });
    expect(
      describeSweepSummary(
        { ...swept, overlapping: 1, unchecked: 3, missing: 1 },
        25,
        'Hold'
      ).headline
    ).toBe(
      '1 pair overlaps along the motion; 1 part had no geometry to check and 3 pairs the motion leaves at rest were not checked.'
    );
  });

  it('counts an undecided pair in the sweep summary beside the positions (#2183)', () => {
    // The issue's rack and pinion: 37 samples, one pair unknown at each.
    expect(
      describeSweepSummary(
        {
          ...swept,
          unknown: 1,
          unknownEverywhere: 1,
          onlyUnknown: { positions: 37, checked: 37 }
        },
        37,
        'Rack slide (−32.4 mm to 43.0 mm)'
      )
    ).toEqual({
      headline:
        'No overlap found at the 37 positions checked, but 1 pair could not be checked exactly at any of its 37 positions.',
      status:
        'Interference through motion: no overlap found at 37 positions checked along Rack slide (−32.4 mm to 43.0 mm), but 1 pair could not be checked exactly at any of its 37 positions.'
    });
    // The all-clear control keeps its own wording.
    expect(describeSweepSummary(swept, 37, 'Rack slide')).toEqual({
      headline: 'No overlap at the 37 positions checked.',
      status:
        'Interference through motion: no overlap at 37 positions checked along Rack slide.'
    });
  });

  it('says how much of a sweep was undecided, with overlaps and missing parts', () => {
    expect(
      describeSweepSummary(
        {
          ...swept,
          unknown: 1,
          onlyUnknown: { positions: 3, checked: 41 }
        },
        45,
        'Slide'
      ).headline
    ).toBe(
      'No overlap found at the 45 positions checked, but 1 pair could not be checked exactly at 3 of its 41 positions.'
    );
    expect(
      describeSweepSummary(
        { ...swept, unknown: 2, unknownEverywhere: 1, missing: 1 },
        37,
        'Slide'
      ).headline
    ).toBe(
      'No overlap found at the 37 positions checked, but 2 pairs could not be checked exactly at some positions and 1 part had no geometry to check.'
    );
    expect(
      describeSweepSummary(
        { ...swept, overlapping: 1, unknown: 2, unknownEverywhere: 2 },
        37,
        'Slide'
      )
    ).toEqual({
      headline:
        '1 pair overlaps along the motion; 2 pairs could not be checked exactly at any position.',
      status:
        'Interference through motion: 1 pair of parts overlaps along Slide; 2 pairs could not be checked exactly at any position.'
    });
  });

  it('names a part with the configuration it was checked in (#2388)', () => {
    expect(checkedPartName('Plate', { rowName: 'Wide' })).toBe('Plate (Wide)');
    expect(checkedPartName('Plate', undefined)).toBe('Plate');
  });

  it("says why a swept pair is undecided, in the check's own words (#2388)", () => {
    expect(
      describeSweepUnknown(['0 mm', '5 mm'], false, [
        'the Wide configuration of Plate could not be built'
      ])
    ).toBe(
      'Not checked exactly at 0 mm, 5 mm: the Wide configuration of Plate could not be built. Not reported as clear there.'
    );
    // Each reason once, without doubling a full stop the kernel wrote.
    expect(
      describeSweepUnknown(['0 mm'], true, [
        'the bodies could not be intersected exactly.',
        'the check returned no result for this position'
      ])
    ).toBe(
      'Not checked exactly at 0 mm, …: the bodies could not be intersected exactly; the check returned no result for this position. Not reported as clear there.'
    );
    expect(describeSweepUnknown(['0 mm'], false, [])).toBe(
      'Not checked exactly at 0 mm; not reported as clear there.'
    );
  });
});
