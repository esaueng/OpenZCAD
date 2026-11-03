import { describe, expect, it } from 'vitest';
import {
  emptyAssemblySet,
  evaluateTrack,
  type AssemblyFrame,
  type AssemblyJoint,
  type AssemblyJointKind,
  type AssemblyMotionStudy,
  type AssemblySet
} from '@openzcad/shared';
import {
  KEY_TIME_TOLERANCE_S,
  addTrack,
  createDefaultStudy,
  deleteKey,
  dofName,
  formatDofValue,
  formatStudyTime,
  keyTimeBounds,
  moveKey,
  nextKeyTime,
  nextStudyName,
  previousKeyTime,
  removeTrack,
  rulerTicks,
  setKeyAt,
  setStudyDuration,
  studyError,
  studyKeyTimes,
  trackCurvePoints,
  untrackedMotions,
  updateKey
} from './motionStudy';

const FRAME: AssemblyFrame = {
  origin: { x: 0, y: 0, z: 0 },
  zAxis: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 }
};

const PLACEMENT = {
  translation: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 }
};

function joint(
  id: string,
  kind: AssemblyJointKind,
  parent: string,
  child: string,
  values: number[]
): AssemblyJoint {
  return {
    id,
    name: id === 'j_pivot' ? 'Pivot' : id === 'j_slide' ? 'Slide' : id,
    kind,
    parent: { componentId: parent, frame: FRAME },
    child: { componentId: child, frame: FRAME },
    values,
    limits: values.map(() => null)
  };
}

function assembly(): AssemblySet {
  return {
    ...emptyAssemblySet(),
    components: ['a', 'b', 'c', 'd'].map((id, index) => ({
      id,
      name: id.toUpperCase(),
      bodyId: `body_${id}` as AssemblySet['components'][number]['bodyId'],
      grounded: index === 0,
      placement: PLACEMENT
    })),
    joints: [
      joint('j_pivot', 'revolute', 'a', 'b', [15]),
      joint('j_fixed', 'rigid', 'a', 'c', []),
      joint('j_slide', 'cylindrical', 'a', 'd', [0, 4])
    ]
  };
}

function study(keys: [number, number][] = [[0, 0]]): AssemblyMotionStudy {
  return {
    id: 'study_1',
    name: 'Motion 1',
    durationS: 2,
    playback: 'loop',
    tracks: [
      {
        jointId: 'j_pivot',
        dof: 0,
        keys: keys.map(([t, value]) => ({ t, value, easing: 'linear' }))
      }
    ]
  };
}

describe('motion study helpers', () => {
  it('creates a two second looping study keyed where the joints stand', () => {
    const set = assembly();
    const created = createDefaultStudy(
      set,
      'study_new',
      new Map([['j_pivot', [42]]])
    );
    expect(created).toMatchObject({
      id: 'study_new',
      name: 'Motion 1',
      durationS: 2,
      playback: 'loop'
    });
    // One track per joint that moves (its first motion); the rigid joint
    // has none. The shown value wins over the saved one.
    expect(created.tracks).toEqual([
      {
        jointId: 'j_pivot',
        dof: 0,
        keys: [{ t: 0, value: 42, easing: 'linear' }]
      },
      {
        jointId: 'j_slide',
        dof: 0,
        keys: [{ t: 0, value: 0, easing: 'linear' }]
      }
    ]);
    expect(studyError(set, created)).toBeNull();
  });

  it('names new studies after the first unused number', () => {
    const set = assembly();
    expect(nextStudyName(undefined)).toBe('Motion 1');
    set.studies = [study(), { ...study(), id: 'study_3', name: 'Motion 3' }];
    expect(nextStudyName(set)).toBe('Motion 2');
  });

  it('inserts keys in order and replaces one within 1 ms', () => {
    const base = study([
      [0, 0],
      [1, 90]
    ]);
    const inserted = setKeyAt(base, 0, 0.5, 30);
    expect(inserted?.tracks[0]?.keys.map((k) => [k.t, k.value])).toEqual([
      [0, 0],
      [0.5, 30],
      [1, 90]
    ]);
    // Within the tolerance: the existing key keeps its time and easing.
    const replaced = setKeyAt(
      {
        ...base,
        tracks: [
          {
            ...base.tracks[0]!,
            keys: [
              { t: 0, value: 0, easing: 'linear' },
              { t: 1, value: 90, easing: 'ease' }
            ]
          }
        ]
      },
      0,
      1 + KEY_TIME_TOLERANCE_S * 0.9,
      45
    );
    expect(replaced?.tracks[0]?.keys).toEqual([
      { t: 0, value: 0, easing: 'linear' },
      { t: 1, value: 45, easing: 'ease' }
    ]);
    // Just beyond it is a new key.
    expect(
      setKeyAt(base, 0, 0.9985, 45)?.tracks[0]?.keys.map((k) => k.t)
    ).toEqual([0, 0.9985, 1]);
    // Clamped into the study, never edits its input.
    expect(setKeyAt(base, 0, 5, 10)?.tracks[0]?.keys.at(-1)).toEqual({
      t: 2,
      value: 10,
      easing: 'linear'
    });
    expect(base.tracks[0]?.keys).toHaveLength(2);
    expect(setKeyAt(base, 0, 0.5, Number.NaN)).toBeNull();
    expect(setKeyAt(base, 3, 0.5, 1)).toBeNull();
  });

  it('moves a key only between its neighbours, 1 ms clear of them', () => {
    const base = study([
      [0, 0],
      [0.5, 30],
      [1, 90]
    ]);
    expect(keyTimeBounds(base, 0, 1)).toEqual({ min: 0.001, max: 0.999 });
    expect(moveKey(base, 0, 1, 0.75)?.t).toBe(0.75);
    expect(moveKey(base, 0, 1, 5)?.t).toBe(0.999);
    expect(moveKey(base, 0, 1, -1)?.t).toBe(0.001);
    // The last key runs to the study's end, the first to its start.
    expect(moveKey(base, 0, 2, 9)?.t).toBe(2);
    expect(moveKey(base, 0, 0, 0.3)?.t).toBe(0.3);
    const moved = moveKey(base, 0, 1, 5)!.study;
    expect(studyError(assembly(), moved)).toBeNull();
    expect(moveKey(base, 0, 7, 0.2)).toBeNull();
  });

  it('edits a key value and easing, and refuses a non-finite value', () => {
    const base = study([
      [0, 0],
      [1, 90]
    ]);
    expect(
      updateKey(base, 0, 1, { value: 45, easing: 'ease' })?.tracks[0]?.keys[1]
    ).toEqual({ t: 1, value: 45, easing: 'ease' });
    expect(updateKey(base, 0, 1, { value: Infinity })).toBeNull();
  });

  it('deletes keys but keeps one on every track', () => {
    const base = study([
      [0, 0],
      [1, 90]
    ]);
    const one = deleteKey(base, 0, 0);
    expect(one?.tracks[0]?.keys).toEqual([
      { t: 1, value: 90, easing: 'linear' }
    ]);
    expect(deleteKey(one!, 0, 0)).toBeNull();
  });

  it('adds a track per untracked joint motion, once', () => {
    const set = assembly();
    const base = study();
    expect(
      untrackedMotions(set, base).map(({ joint, dof }) => `${joint.id}/${dof}`)
    ).toEqual(['j_slide/0', 'j_slide/1']);
    const added = addTrack(set, base, 'j_slide', 1, 4);
    expect(added?.tracks[1]).toEqual({
      jointId: 'j_slide',
      dof: 1,
      keys: [{ t: 0, value: 4, easing: 'linear' }]
    });
    expect(addTrack(set, added!, 'j_slide', 1, 4)).toBeNull();
    expect(addTrack(set, base, 'j_fixed', 0, 0)).toBeNull();
    expect(addTrack(set, base, 'j_slide', 2, 0)).toBeNull();
    expect(addTrack(set, base, 'missing', 0, 0)).toBeNull();
    expect(removeTrack(added!, 0)?.tracks.map((t) => t.jointId)).toEqual([
      'j_slide'
    ]);
  });

  it('clamps keys into a shorter duration, keeping them in order', () => {
    const base = study([
      [0, 0],
      [0.5, 10],
      [1.5, 20],
      [2, 30]
    ]);
    const shorter = setStudyDuration(base, 1);
    expect(shorter?.durationS).toBe(1);
    expect(shorter?.tracks[0]?.keys.map((k) => k.t)).toEqual([
      0, 0.5, 0.999, 1
    ]);
    expect(studyError(assembly(), shorter!)).toBeNull();
    // Longer leaves every key where it was.
    expect(setStudyDuration(base, 4)?.tracks[0]?.keys.map((k) => k.t)).toEqual([
      0, 0.5, 1.5, 2
    ]);
    // Four keys need 3 ms between the first and last.
    expect(setStudyDuration(base, 0.002)).toBeNull();
    expect(setStudyDuration(base, 0)).toBeNull();
    expect(setStudyDuration(base, Number.NaN)).toBeNull();
    expect(setStudyDuration(base, 3601)).toBeNull();
  });

  it('steps between key times across tracks or within one', () => {
    const base: AssemblyMotionStudy = {
      ...study([
        [0, 0],
        [1, 90]
      ]),
      tracks: [
        ...study([
          [0, 0],
          [1, 90]
        ]).tracks,
        {
          jointId: 'j_slide',
          dof: 0,
          keys: [
            { t: 0.5, value: 0, easing: 'linear' },
            { t: 1.0004, value: 5, easing: 'linear' }
          ]
        }
      ]
    };
    expect(studyKeyTimes(base)).toEqual([0, 0.5, 1]);
    expect(nextKeyTime(base, 0)).toBe(0.5);
    expect(nextKeyTime(base, 0.5)).toBe(1);
    expect(nextKeyTime(base, 1)).toBeNull();
    expect(previousKeyTime(base, 1)).toBe(0.5);
    expect(previousKeyTime(base, 0.0005)).toBeNull();
    expect(nextKeyTime(base, 0, 0)).toBe(1);
  });

  it('ticks every quarter second, labelled on whole and half seconds', () => {
    const ticks = rulerTicks(2);
    expect(ticks.map((tick) => tick.t)).toEqual([
      0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2
    ]);
    expect(
      ticks.filter((tick) => tick.label).map((tick) => tick.label)
    ).toEqual(['0s', '0.5s', '1s', '1.5s', '2s']);
    // Long studies coarsen instead of drawing thousands of ticks.
    const long = rulerTicks(600);
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.at(-1)?.t).toBe(600);
    expect(rulerTicks(0)).toEqual([]);
  });

  it('formats times, values and motion names', () => {
    expect(formatStudyTime(0.8449)).toBe('0.84');
    expect(formatStudyTime(2)).toBe('2.00');
    expect(formatDofValue(12.345, 'deg')).toBe('12.35°');
    expect(formatDofValue(-0.001, 'mm')).toBe('0 mm');
    expect(dofName('cylindrical', 1)).toBe('Distance');
    expect(dofName('revolute', 4)).toBe('Motion 5');
  });

  it('draws the value curve through the keys in a 1000 × 100 box', () => {
    const track = study([
      [0, 0],
      [1, 90]
    ]).tracks[0]!;
    const points = trackCurvePoints(track, 2, 4)
      .split(' ')
      .map((p) => p.split(',').map(Number));
    expect(points).toHaveLength(5);
    expect(points[0]).toEqual([0, 90]);
    expect(points[2]).toEqual([500, 10]);
    expect(points[4]).toEqual([1000, 10]);
    expect(evaluateTrack(track, 0.5)).toBe(45);
  });

  it('reports a study the set would refuse', () => {
    const bad = study([
      [0, 0],
      [0, 10]
    ]);
    expect(studyError(assembly(), bad)).toMatch(/out of order/);
  });
});
