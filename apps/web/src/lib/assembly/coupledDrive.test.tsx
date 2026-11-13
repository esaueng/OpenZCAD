import {
  act,
  fireEvent,
  render,
  renderHook,
  screen
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IDENTITY_PLACEMENT,
  motionStudyDrivers,
  motionStudyValues,
  solveAssembly,
  type AssemblyFrame,
  type AssemblyJoint,
  type AssemblyMotionStudy,
  type AssemblySet,
  type BodyId
} from '@openzcad/shared';
import { AssemblyPlayer } from '../../components/assembly/AssemblyPlayer';
import { coupledPairProject } from '../../components/assembly/motionTestFixture';
import { recordingExecute } from '../../test/assemblyFixture';
import { useAssembleWorkspace } from './assembleWorkspace';
import { playbackFrame } from './assemblyPlayback';
import { assemblyRuntime, getAssemblyRuntime } from './assemblyRuntime';
import { buildAssemblyView } from './assemblyView';
import { setAnimatePrefs } from './assemblyUi';
import {
  createDefaultStudy,
  jointSweepStudy,
  keyPoseAt,
  shownJointValues,
  untrackedMotions
} from './motionStudy';

/**
 * AS02 gear coupling: which coupled motion leads, end to end. The motion
 * the user is moving drives its mates through a drag, its commit and
 * playback, whatever an earlier scrub left on screen, and View and Animate
 * sweep the same range the coupled pair can really travel.
 */
let frames: FrameRequestCallback[] = [];

function frame(nowMs: number) {
  const pending = frames;
  frames = [];
  act(() => {
    for (const callback of pending) callback(nowMs);
  });
}

beforeEach(() => {
  frames = [];
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    frames = [];
  });
  assemblyRuntime.setActive(false);
  assemblyRuntime.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  assemblyRuntime.setActive(false);
  assemblyRuntime.reset();
});

/** The angles on screen: [A, B]. */
function shown(set: AssemblySet): [number, number] {
  const runtime = getAssemblyRuntime();
  const values = solveAssembly(set, runtime.overrides, runtime.drivers).values;
  return [values.get('turn_a')?.[0] ?? NaN, values.get('turn_b')?.[0] ?? NaN];
}

const spin: AssemblyMotionStudy = {
  id: 'study_spin',
  name: 'Spin',
  durationS: 2,
  playback: 'once',
  tracks: [
    {
      jointId: 'turn_a',
      dof: 0,
      keys: [
        { t: 0, value: 0, easing: 'linear' },
        { t: 2, value: 80, easing: 'linear' }
      ]
    }
  ]
};

describe('the motion being moved drives its coupled mates', () => {
  it('drags the driven gear after a scrub, and saves that pose', () => {
    const manager = coupledPairProject({ limited: false });
    const document = manager.document;
    const set = document.assembly!;
    const { commands, execute } = recordingExecute(manager);
    renderHook(() =>
      useAssembleWorkspace(true, { document, execute, onStatus: vi.fn() })
    );
    // A scrub leaves A at 40° (B follows to −20°), with every joint's
    // value on screen as a study does.
    act(() =>
      assemblyRuntime.setOverrides(
        motionStudyValues(set, spin, 1),
        motionStudyDrivers(spin)
      )
    );
    expect(shown(set)).toEqual([40, -20]);
    // Then B is dragged to −30°: it leads now, A's retained 40° does not.
    act(() => assemblyRuntime.setOverride('turn_b', [-30], 0));
    expect(getAssemblyRuntime().drivers[0]).toEqual({
      jointId: 'turn_b',
      dof: 0
    });
    expect(shown(set)).toEqual([60, -30]);
    // The view (what the viewport draws) agrees.
    const view = buildAssemblyView(document, getAssemblyRuntime())!;
    expect(
      Object.fromEntries(view.glyphs.map((g) => [g.jointId, g.values[0]]))
    ).toEqual({ turn_a: 60, turn_b: -30 });
    // Releasing saves it with the dragged motion named first.
    act(() => assemblyRuntime.commitOverrides());
    const pose = commands.at(-1)!;
    expect(pose.kind).toBe('assembly.pose.set');
    expect(
      (pose.payload as { drivers?: { jointId: string }[] }).drivers?.[0]
    ).toEqual({ jointId: 'turn_b', dof: 0 });
    expect(manager.document.assembly!.joints.map((j) => j.values[0])).toEqual([
      60, -30
    ]);
    expect(getAssemblyRuntime().overrides.size).toBe(0);
    expect(getAssemblyRuntime().drivers).toEqual([]);
  });

  it('keeps drivers in step with the values on screen', () => {
    act(() => assemblyRuntime.setOverride('turn_a', [10], 0));
    act(() => assemblyRuntime.setOverride('turn_b', [5], 0));
    act(() => assemblyRuntime.setOverride('turn_a', [12], 0));
    expect(getAssemblyRuntime().drivers.map((d) => d.jointId)).toEqual([
      'turn_a',
      'turn_b'
    ]);
    // A value shown without a moved motion (a preview) names no driver.
    act(() => assemblyRuntime.setOverride('preview', [1]));
    expect(getAssemblyRuntime().drivers).toHaveLength(2);
    act(() => assemblyRuntime.setOverride('turn_a', null));
    expect(getAssemblyRuntime().drivers.map((d) => d.jointId)).toEqual([
      'turn_b'
    ]);
    act(() => assemblyRuntime.clearOverrides());
    expect(getAssemblyRuntime().drivers).toEqual([]);
  });

  it('keys the gear the study plays when its mate is dragged', () => {
    const set = coupledPairProject({ limited: false }).document.assembly!;
    // The study plays A; B dragged to −30° at t = 1 means A at 60° there.
    const { study, changed } = keyPoseAt(
      set,
      spin,
      1,
      { turn_a: [40], turn_b: [-30] },
      [{ jointId: 'turn_b', dof: 0 }]
    );
    expect(changed).toBe(true);
    expect(study?.tracks.map((t) => t.jointId)).toEqual(['turn_a']);
    expect(study?.tracks[0]?.keys.map((k) => [k.t, k.value])).toEqual([
      [0, 0],
      [1, 60],
      [2, 80]
    ]);
    // The same pose again changes nothing.
    expect(
      keyPoseAt(set, study!, 1, { turn_a: [60], turn_b: [-30] }, [
        { jointId: 'turn_b', dof: 0 }
      ]).changed
    ).toBe(false);
    // With no track in the group yet, the dragged gear takes the key.
    const empty = { ...spin, tracks: [] };
    expect(
      keyPoseAt(set, empty, 1, { turn_b: [-30] }, [
        { jointId: 'turn_b', dof: 0 }
      ]).study?.tracks.map((t) => [t.jointId, t.keys.at(-1)?.value])
    ).toEqual([['turn_b', -30]]);
  });

  it('leaves a limited track’s keys alone when another joint is moved', () => {
    // B = −A / 2 and B stops at ±20°, so the pair shows A = 40° at the end
    // of a study keyed to 80°. Scrubbed there, the unrelated joint C is
    // moved and the pose committed: every shown value arrives, A's raw 80°
    // among them. A did not move, so its key must not become 40°.
    const set = coupledPairProject({ third: true }).document.assembly!;
    const end = Object.fromEntries(motionStudyValues(set, spin, 2));
    expect(end.turn_a).toEqual([80]);
    expect(
      solveAssembly(
        set,
        motionStudyValues(set, spin, 2),
        motionStudyDrivers(spin)
      ).values.get('turn_a')
    ).toEqual([40]);
    const moved = keyPoseAt(set, spin, 2, { ...end, turn_c: [15] }, [
      { jointId: 'turn_c', dof: 0 },
      ...motionStudyDrivers(spin)
    ]);
    expect(moved.changed).toBe(true);
    expect(moved.study?.tracks[0]).toEqual(spin.tracks[0]);
    expect(
      moved.study?.tracks.slice(1).map((t) => [t.jointId, t.keys.at(-1)?.value])
    ).toEqual([['turn_c', 15]]);
    // The same commit with nothing moved changes nothing at all.
    expect(keyPoseAt(set, spin, 2, end, motionStudyDrivers(spin)).changed).toBe(
      false
    );
    // Moving the pair itself there does re-key it, to what it then shows.
    const dragged = keyPoseAt(set, spin, 2, { ...end, turn_b: [-10] }, [
      { jointId: 'turn_b', dof: 0 },
      ...motionStudyDrivers(spin)
    ]);
    expect(dragged.study?.tracks.map((t) => t.jointId)).toEqual(['turn_a']);
    expect(dragged.study?.tracks[0]?.keys.at(-1)).toMatchObject({
      t: 2,
      value: 20
    });
  });

  it('keys a move that is tiny on the tracked shaft of a geared-down train', () => {
    // Five shafts, four stages at −0.05 each; the study tracks the last.
    // Moving the first by 0.1° turns the last by 0.1 × 0.05⁴ = 6.25e-7°,
    // under the 1e-6° "same pose" tolerance. The group did move, so the key
    // must be written: dropped, playback would put the first shaft back.
    const joints: AssemblyJoint[] = [1, 2, 3, 4, 5].map((n) => {
      const frame: AssemblyFrame = {
        origin: { x: 50 * n, y: 0, z: 0 },
        zAxis: { x: 0, y: 0, z: 1 },
        xAxis: { x: 1, y: 0, z: 0 }
      };
      return {
        id: `shaft_${n}`,
        name: `Shaft ${n}`,
        kind: 'revolute',
        parent: { componentId: 'plate', frame },
        child: { componentId: `part_${n}`, frame },
        values: [0],
        limits: [null]
      };
    });
    const train: AssemblySet = {
      components: [
        'plate',
        'part_1',
        'part_2',
        'part_3',
        'part_4',
        'part_5'
      ].map((id) => ({
        id,
        name: id,
        bodyId: `body_${id}` as BodyId,
        grounded: id === 'plate',
        placement: IDENTITY_PLACEMENT
      })),
      joints,
      positions: [],
      studies: [],
      couplings: [1, 2, 3, 4].map((n) => ({
        id: `stage_${n}`,
        name: `Stage ${n}`,
        driver: { jointId: `shaft_${n}`, dof: 0 },
        driven: { jointId: `shaft_${n + 1}`, dof: 0 },
        ratio: -0.05,
        offset: 0
      }))
    };
    const study: AssemblyMotionStudy = {
      id: 'study_out',
      name: 'Output',
      durationS: 2,
      playback: 'once',
      tracks: [
        {
          jointId: 'shaft_5',
          dof: 0,
          keys: [{ t: 0, value: 0, easing: 'linear' }]
        }
      ]
    };
    const first = { jointId: 'shaft_1', dof: 0 };
    const pose = Object.fromEntries(motionStudyValues(train, study, 1));
    const { study: keyed, changed } = keyPoseAt(
      train,
      study,
      1,
      { ...pose, shaft_1: [0.1] },
      [first, ...motionStudyDrivers(study)]
    );
    expect(changed).toBe(true);
    expect(keyed?.tracks.map((t) => t.jointId)).toEqual(['shaft_5']);
    const key = keyed?.tracks[0]?.keys.at(-1);
    expect(key?.t).toBe(1);
    expect(key?.value).toBeCloseTo(6.25e-7, 15);
    // Played back, the first shaft stands where it was put.
    const played = solveAssembly(
      train,
      motionStudyValues(train, keyed!, 1),
      motionStudyDrivers(keyed!)
    ).values;
    expect(played.get('shaft_1')?.[0]).toBeCloseTo(0.1, 9);
    // A pose that moves nothing is still no edit, at any scale.
    expect(
      keyPoseAt(train, study, 1, pose, [first, ...motionStudyDrivers(study)])
        .changed
    ).toBe(false);
  });

  it('gives a coupled pair one track, and reads the values on screen', () => {
    const set = coupledPairProject({ limited: false }).document.assembly!;
    const values = shownJointValues(set, new Map([['turn_b', [-30]]]), [
      { jointId: 'turn_b', dof: 0 }
    ]);
    expect(values.get('turn_a')).toEqual([60]);
    const created = createDefaultStudy(set, 'study_new', values);
    expect(created.tracks.map((t) => [t.jointId, t.keys[0]?.value])).toEqual([
      ['turn_a', 60]
    ]);
    // A's track already moves B: B is not offered a track of its own.
    expect(untrackedMotions(set, created)).toEqual([]);
    expect(
      untrackedMotions(set, { ...created, tracks: [] }).map((m) => m.joint.id)
    ).toEqual(['turn_a', 'turn_b']);
  });
});

describe('View and Animate sweep what a coupled pair can travel', () => {
  it('plays the same bounded range in both', () => {
    setAnimatePrefs({ mode: 'ping-pong', sweepS: 1.5 });
    const manager = coupledPairProject();
    const set = manager.document.assembly!;
    const jointA = set.joints[0]!;
    // A has no limit of its own; B's ±20° allows it ±40°, not a full turn.
    expect(jointSweepStudy(jointA, 1.5)?.tracks[0]?.keys.at(-1)?.value).toBe(
      360
    );
    expect(
      jointSweepStudy(jointA, 1.5, set)?.tracks[0]?.keys.map((k) => k.value)
    ).toEqual([-40, 40]);

    // Animate (Assemble): low end, middle, high end.
    const animate = [1000, 1750, 2500].map(
      (now) =>
        playbackFrame(
          set,
          {
            kind: 'joint',
            jointId: 'turn_a',
            dof: 0,
            mode: 'ping-pong',
            sweepS: 1.5,
            startedAtMs: 1000
          },
          now
        )?.overrides.get('turn_a')?.[0]
    );
    expect(animate[0]).toBeCloseTo(-40, 9);
    expect(animate[1]).toBeCloseTo(0, 9);
    expect(animate[2]).toBeCloseTo(40, 9);

    // View: the player's sweep of the same joint visits the same angles,
    // negatives included, and B never leaves its limit.
    render(<AssemblyPlayer assembly={set} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    const seen: [number, number][] = [];
    for (const now of [1000, 1750, 2500]) {
      frame(now);
      seen.push(shown(set));
    }
    expect(seen[0]![0]).toBeCloseTo(-40, 9);
    expect(seen[1]![0]).toBeCloseTo(0, 9);
    expect(seen[2]![0]).toBeCloseTo(40, 9);
    for (const [a, b] of seen) {
      expect(b).toBeCloseTo(-a / 2, 9);
      expect(Math.abs(b)).toBeLessThanOrEqual(20);
    }
  });
});
