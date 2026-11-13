import {
  ASSEMBLY_JOINT_DOFS,
  MAX_ASSEMBLY_KEYS,
  MAX_ASSEMBLY_MAGNITUDE,
  MAX_ASSEMBLY_STUDY_SECONDS,
  MAX_ASSEMBLY_TRACKS,
  assemblySetError,
  coupledJointLimits,
  coupledJointValues,
  couplingGroupKeys,
  couplingGroupLead,
  couplingGroups,
  evaluateTrack,
  jointSweepRange,
  motionStudyDrivers,
  motionStudyValues,
  type AssemblyCouplingEnd,
  type AssemblyDofUnit,
  type AssemblyEasing,
  type AssemblyJoint,
  type AssemblyJointKind,
  type AssemblyKeyframe,
  type AssemblyMotionStudy,
  type AssemblySet,
  type AssemblyTrack
} from '@openzcad/shared';

/**
 * AS07 motion study editing. Pure: every helper takes a study and returns a
 * new one (or null when the edit is refused), never touching its input, so
 * the timeline can preview a drag and commit the same result as one
 * `assembly.study.set` command.
 *
 * Times are seconds from the study's start; values are in the joint
 * motion's unit (degrees or millimetres, per `ASSEMBLY_JOINT_DOFS`).
 */

/** Two key times closer than this are the same key (1 ms). */
export const KEY_TIME_TOLERANCE_S = 0.001;

/** The smallest gap kept between neighbouring keys when one moves (1 ms). */
export const MIN_KEY_GAP_S = 0.001;

export const DEFAULT_STUDY_DURATION_S = 2;

/** Joint values to start from: shown (transient) values over saved ones. */
export type JointValueSource = ReadonlyMap<string, readonly number[]>;

function finite(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_ASSEMBLY_MAGNITUDE;
}

function cloneStudy(study: AssemblyMotionStudy): AssemblyMotionStudy {
  return {
    ...study,
    tracks: study.tracks.map((track) => ({
      ...track,
      keys: track.keys.map((key) => ({ ...key }))
    }))
  };
}

function withTrack(
  study: AssemblyMotionStudy,
  trackIndex: number,
  keys: AssemblyKeyframe[]
): AssemblyMotionStudy {
  const next = cloneStudy(study);
  const track = next.tracks[trackIndex];
  if (track) track.keys = keys;
  return next;
}

/** Rounds to the microsecond so drags never store float noise. */
export function roundTime(t: number): number {
  return Math.round(t * 1e6) / 1e6;
}

/** "Motion 1", "Motion 2"…: the next unused default study name. */
export function nextStudyName(set: AssemblySet | undefined): string {
  const names = new Set((set?.studies ?? []).map((s) => s.name));
  for (let n = 1; ; n += 1) if (!names.has(`Motion ${n}`)) return `Motion ${n}`;
}

/**
 * The joint values on screen: the transient values with limits and
 * couplings applied, so a joint that only follows its mate reads the value
 * it is shown at rather than its own stale one.
 */
export function shownJointValues(
  set: AssemblySet | undefined,
  overrides: JointValueSource,
  drivers: readonly AssemblyCouplingEnd[]
): JointValueSource {
  return set ? coupledJointValues(set, overrides, drivers) : overrides;
}

/** The value a joint motion shows now: a transient value, else the saved one. */
export function currentJointValue(
  joint: AssemblyJoint,
  dof: number,
  shown?: JointValueSource
): number {
  return shown?.get(joint.id)?.[dof] ?? joint.values[dof] ?? 0;
}

/**
 * A new study: two seconds, looping, one track per joint that moves (its
 * first motion), each holding one key at 0 with the joint's current value.
 * Joints coupled to one another share one track, the first joint's: a
 * second would only be overruled by it.
 */
export function createDefaultStudy(
  set: AssemblySet | undefined,
  id: string,
  shown?: JointValueSource
): AssemblyMotionStudy {
  const tracks: AssemblyTrack[] = [];
  const groups = set ? couplingGroupKeys(set) : new Map<string, string>();
  const led = new Set<string>();
  for (const joint of set?.joints ?? []) {
    if (ASSEMBLY_JOINT_DOFS[joint.kind].length === 0) continue;
    if (tracks.length >= MAX_ASSEMBLY_TRACKS) break;
    const group = groups.get(`${joint.id}/0`);
    if (group !== undefined) {
      if (led.has(group)) continue;
      led.add(group);
    }
    tracks.push({
      jointId: joint.id,
      dof: 0,
      keys: [
        { t: 0, value: currentJointValue(joint, 0, shown), easing: 'linear' }
      ]
    });
  }
  return {
    id,
    name: nextStudyName(set),
    durationS: DEFAULT_STUDY_DURATION_S,
    playback: 'loop',
    tracks
  };
}

/** Joint values closer than this are the same pose (degrees or millimetres). */
export const POSE_VALUE_TOLERANCE = 1e-6;

/**
 * Keys a pose at `t`: each joint motion whose value differs from what the
 * study shows there gets a key. A motion without a track gains one, starting
 * from its saved value at 0, since that is what the study showed before.
 * `changed` is false when the pose already matches the study; `study` is
 * null when a track or the study is full.
 *
 * Joints coupled to one another take one key between them. `drivers` are
 * the motions that were moved, most recent first: the moved one leads its
 * group, and the key goes on the motion the study already tracks there
 * (else on the moved one) with the value that pose gives it. So dragging a
 * driven gear re-keys the gear the study plays, and no second track is
 * made that the first would overrule.
 *
 * A group is keyed only when the pose really moved it, and that is judged
 * on one motion: the one the pose drives the group from (the moved part,
 * else the study's own track). Its value with the pose applied is compared
 * with what the study shows for it there, both with limits and couplings
 * applied, in its own units. The other members are that value carried
 * through the ratio chain, so comparing them would scale a real move and
 * the solve's rounding alike (nine 1 : 20 stages turn one unit in the last
 * place of 2° into 5e-6° on the first shaft, though nothing moved). Once
 * the driving motion has moved, the key is written whatever the step comes
 * to on the keyed motion, which may be geared far down from it. The values handed in include every joint a
 * scrub left on screen, and a key a limit holds short of (a track keyed to
 * 80° that its mate stops at 40°) reads differently raw than shown; moving
 * some other joint must never rewrite that key.
 */
export function keyPoseAt(
  set: AssemblySet,
  study: AssemblyMotionStudy,
  t: number,
  values: Readonly<Record<string, readonly number[]>>,
  drivers: readonly AssemblyCouplingEnd[] = []
): { study: AssemblyMotionStudy | null; changed: boolean } {
  const at = Math.min(study.durationS, Math.max(0, t));
  let next: AssemblyMotionStudy = study;
  let changed = false;
  let full = false;
  // `moved` says the caller already knows the pose moved this motion, so
  // the key is written however small the step is on this motion's scale.
  const key = (
    joint: AssemblyJoint,
    dof: number,
    value: number,
    moved = false
  ) => {
    let index = next.tracks.findIndex(
      (track) => track.jointId === joint.id && track.dof === dof
    );
    const shown =
      index >= 0
        ? evaluateTrack(next.tracks[index] as AssemblyTrack, at)
        : (joint.values[dof] ?? 0);
    if (!moved && Math.abs(value - shown) <= POSE_VALUE_TOLERANCE) return;
    changed = true;
    if (index < 0) {
      const added = addTrack(set, next, joint.id, dof, shown);
      if (!added) {
        full = true;
        return;
      }
      next = added;
      index = next.tracks.length - 1;
    }
    const keyed = setKeyAt(next, index, at, value);
    if (keyed) next = keyed;
    else full = true;
  };

  const groups = couplingGroupKeys(set);
  const keyedGroups = new Set<string>();
  // What the study shows at `at`, and the pose over it with the moved
  // motion leading: both as the solve shows them.
  let settled: {
    shown: Map<string, number[]>;
    posed: Map<string, number[]>;
    /** Per group: the motion the pose drives it from. */
    leads: Map<string, AssemblyCouplingEnd>;
  } | null = null;
  const settle = () => {
    if (settled) return settled;
    const tracks = motionStudyDrivers(study);
    const pose = motionStudyValues(set, study, at);
    const shown = coupledJointValues(set, pose, tracks);
    for (const [jointId, posed] of Object.entries(values))
      pose.set(jointId, [...posed]);
    const driving = [...drivers, ...tracks];
    const leads = new Map<string, AssemblyCouplingEnd>();
    for (const group of couplingGroups(set)) {
      const first = group.members[0];
      const lead = couplingGroupLead(group, pose, driving);
      if (first && lead) leads.set(`${first.jointId}/${first.dof}`, lead);
    }
    settled = {
      shown,
      posed: coupledJointValues(set, pose, driving),
      leads
    };
    return settled;
  };
  /**
   * Whether the pose moved the group: its driving motion shows a new value.
   * Only that motion is compared. The pose is settled from it and the
   * study from its track, so every other member differs by the rounding of
   * two routes through the ratio chain even when nothing moved.
   */
  const groupMoved = (group: string) => {
    const { shown, posed, leads } = settle();
    const lead = leads.get(group);
    if (!lead) return false;
    return (
      Math.abs(
        (posed.get(lead.jointId)?.[lead.dof] ?? 0) -
          (shown.get(lead.jointId)?.[lead.dof] ?? 0)
      ) > POSE_VALUE_TOLERANCE
    );
  };
  const joints = new Map(set.joints.map((j) => [j.id, j]));
  for (const joint of set.joints) {
    const posed = values[joint.id];
    if (!posed) continue;
    const dofs = ASSEMBLY_JOINT_DOFS[joint.kind].length;
    for (let dof = 0; dof < dofs && !full; dof += 1) {
      const value = posed[dof];
      if (value === undefined) continue;
      const group = groups.get(`${joint.id}/${dof}`);
      if (group === undefined) {
        key(joint, dof, value);
        continue;
      }
      if (keyedGroups.has(group)) continue;
      keyedGroups.add(group);
      if (!groupMoved(group)) continue;
      const inGroup = (end: AssemblyCouplingEnd) =>
        groups.get(`${end.jointId}/${end.dof}`) === group;
      const target = study.tracks.find(inGroup) ??
        drivers.find(inGroup) ?? { jointId: joint.id, dof };
      const targetJoint = joints.get(target.jointId);
      const targetValue = settle().posed.get(target.jointId)?.[target.dof];
      // The group moved, judged on its driving motion. The keyed motion
      // may be geared far down from it (four stages at 1 : 20 turn 0.1°
      // into 6e-7°), so its own step is not tested again: a second
      // tolerance check here would drop the edit.
      if (targetJoint && targetValue !== undefined)
        key(targetJoint, target.dof, targetValue, true);
    }
    if (full) return { study: null, changed };
  }
  return { study: next, changed };
}

/**
 * A joint's Animate sweep as a study, for a project without studies to
 * play in View mode: its range from the low end to the high one with the
 * same ease, back and forth, so it moves exactly as Animate does. With the
 * assembly given, the range is the one the joint can really travel: its
 * own limits narrowed by the limits of the joints coupled to it.
 */
export function jointSweepStudy(
  joint: AssemblyJoint,
  sweepS: number,
  set?: Pick<AssemblySet, 'joints' | 'couplings'>
): AssemblyMotionStudy | null {
  const limits = set ? coupledJointLimits(set, joint) : joint.limits;
  for (let dof = 0; dof < ASSEMBLY_JOINT_DOFS[joint.kind].length; dof += 1) {
    const range = jointSweepRange({ kind: joint.kind, limits }, dof);
    if (!range || !(sweepS > 0)) continue;
    return {
      id: `sweep:${joint.id}`,
      name: joint.name,
      durationS: sweepS,
      playback: 'ping-pong',
      tracks: [
        {
          jointId: joint.id,
          dof,
          keys: [
            { t: 0, value: range.min, easing: 'linear' },
            { t: sweepS, value: range.max, easing: 'ease' }
          ]
        }
      ]
    };
  }
  return null;
}

/** Index of the key within {@link KEY_TIME_TOLERANCE_S} of `t`, or -1. */
export function keyIndexAt(track: AssemblyTrack, t: number): number {
  return track.keys.findIndex(
    (key) => Math.abs(key.t - t) <= KEY_TIME_TOLERANCE_S
  );
}

/**
 * Sets a key at `t` (clamped into the study): replaces the value of a key
 * within 1 ms (keeping its time and easing), else inserts one in order.
 * Null when the value is unusable, the track is missing or full.
 */
export function setKeyAt(
  study: AssemblyMotionStudy,
  trackIndex: number,
  t: number,
  value: number,
  easing: AssemblyEasing = 'linear'
): AssemblyMotionStudy | null {
  const track = study.tracks[trackIndex];
  if (!track || !finite(value) || !Number.isFinite(t)) return null;
  const at = roundTime(Math.min(study.durationS, Math.max(0, t)));
  const keys = track.keys.map((key) => ({ ...key }));
  const existing = keyIndexAt(track, at);
  if (existing >= 0) {
    (keys[existing] as AssemblyKeyframe).value = value;
    return withTrack(study, trackIndex, keys);
  }
  if (keys.length >= MAX_ASSEMBLY_KEYS) return null;
  keys.push({ t: at, value, easing });
  keys.sort((a, b) => a.t - b.t);
  return withTrack(study, trackIndex, keys);
}

/** The times a key may move between: its neighbours less 1 ms, the study. */
export function keyTimeBounds(
  study: AssemblyMotionStudy,
  trackIndex: number,
  keyIndex: number
): { min: number; max: number } | null {
  const keys = study.tracks[trackIndex]?.keys;
  if (!keys || !keys[keyIndex]) return null;
  const before = keys[keyIndex - 1];
  const after = keys[keyIndex + 1];
  return {
    min: before ? roundTime(before.t + MIN_KEY_GAP_S) : 0,
    max: after ? roundTime(after.t - MIN_KEY_GAP_S) : study.durationS
  };
}

/**
 * Retimes one key, clamped between its neighbours (keys never pass one
 * another) and into the study. Returns the study and the time it landed on.
 */
export function moveKey(
  study: AssemblyMotionStudy,
  trackIndex: number,
  keyIndex: number,
  t: number
): { study: AssemblyMotionStudy; t: number } | null {
  const bounds = keyTimeBounds(study, trackIndex, keyIndex);
  if (!bounds || !Number.isFinite(t) || bounds.min > bounds.max) return null;
  const at = roundTime(Math.min(bounds.max, Math.max(bounds.min, t)));
  const keys = (study.tracks[trackIndex] as AssemblyTrack).keys.map((key) => ({
    ...key
  }));
  (keys[keyIndex] as AssemblyKeyframe).t = at;
  return { study: withTrack(study, trackIndex, keys), t: at };
}

/** Changes a key's value and/or easing. Null on an unusable value. */
export function updateKey(
  study: AssemblyMotionStudy,
  trackIndex: number,
  keyIndex: number,
  patch: { value?: number; easing?: AssemblyEasing }
): AssemblyMotionStudy | null {
  const track = study.tracks[trackIndex];
  const key = track?.keys[keyIndex];
  if (!track || !key) return null;
  if (patch.value !== undefined && !finite(patch.value)) return null;
  const keys = track.keys.map((k, index) =>
    index === keyIndex
      ? {
          ...k,
          ...(patch.value !== undefined ? { value: patch.value } : {}),
          ...(patch.easing ? { easing: patch.easing } : {})
        }
      : { ...k }
  );
  return withTrack(study, trackIndex, keys);
}

/** Removes a key. Null when it is the track's last one (a track keeps one). */
export function deleteKey(
  study: AssemblyMotionStudy,
  trackIndex: number,
  keyIndex: number
): AssemblyMotionStudy | null {
  const track = study.tracks[trackIndex];
  if (!track || !track.keys[keyIndex] || track.keys.length <= 1) return null;
  return withTrack(
    study,
    trackIndex,
    track.keys.filter((_, index) => index !== keyIndex).map((k) => ({ ...k }))
  );
}

/**
 * Adds a track for one joint motion holding a key at 0. Null when the joint
 * or motion does not exist, the motion already has a track, or the study is
 * full.
 */
export function addTrack(
  set: AssemblySet,
  study: AssemblyMotionStudy,
  jointId: string,
  dof: number,
  value: number
): AssemblyMotionStudy | null {
  const joint = set.joints.find((j) => j.id === jointId);
  if (
    !joint ||
    !Number.isInteger(dof) ||
    dof < 0 ||
    dof >= ASSEMBLY_JOINT_DOFS[joint.kind].length ||
    !finite(value) ||
    study.tracks.length >= MAX_ASSEMBLY_TRACKS ||
    study.tracks.some((t) => t.jointId === jointId && t.dof === dof)
  )
    return null;
  const next = cloneStudy(study);
  next.tracks.push({ jointId, dof, keys: [{ t: 0, value, easing: 'linear' }] });
  return next;
}

export function removeTrack(
  study: AssemblyMotionStudy,
  trackIndex: number
): AssemblyMotionStudy | null {
  if (!study.tracks[trackIndex]) return null;
  const next = cloneStudy(study);
  next.tracks.splice(trackIndex, 1);
  return next;
}

/**
 * Changes the duration. Keys past the new end are pulled in to it, packed
 * 1 ms apart from the end backwards so their order stays strictly
 * increasing. Null when the duration is unusable or the keys cannot fit.
 */
export function setStudyDuration(
  study: AssemblyMotionStudy,
  durationS: number
): AssemblyMotionStudy | null {
  if (
    !Number.isFinite(durationS) ||
    durationS <= 0 ||
    durationS > MAX_ASSEMBLY_STUDY_SECONDS
  )
    return null;
  const duration = roundTime(durationS);
  if (duration <= 0) return null;
  const next = cloneStudy(study);
  next.durationS = duration;
  for (const track of next.tracks) {
    let ceiling = duration;
    for (let index = track.keys.length - 1; index >= 0; index -= 1) {
      const key = track.keys[index] as AssemblyKeyframe;
      if (key.t > ceiling) key.t = roundTime(ceiling);
      if (key.t < 0) return null;
      ceiling = key.t - MIN_KEY_GAP_S;
    }
  }
  return next;
}

/** All key times of the study (or of one track), ascending, deduplicated. */
export function studyKeyTimes(
  study: AssemblyMotionStudy,
  trackIndex?: number
): number[] {
  const tracks =
    trackIndex === undefined
      ? study.tracks
      : study.tracks.slice(trackIndex, trackIndex + 1);
  const times = tracks.flatMap((track) => track.keys.map((key) => key.t));
  times.sort((a, b) => a - b);
  return times.filter(
    (t, index) =>
      index === 0 || t - (times[index - 1] as number) > KEY_TIME_TOLERANCE_S
  );
}

/** The first key time after `t` (beyond 1 ms), or null. */
export function nextKeyTime(
  study: AssemblyMotionStudy,
  t: number,
  trackIndex?: number
): number | null {
  return (
    studyKeyTimes(study, trackIndex).find(
      (time) => time > t + KEY_TIME_TOLERANCE_S
    ) ?? null
  );
}

/** The last key time before `t` (beyond 1 ms), or null. */
export function previousKeyTime(
  study: AssemblyMotionStudy,
  t: number,
  trackIndex?: number
): number | null {
  const before = studyKeyTimes(study, trackIndex).filter(
    (time) => time < t - KEY_TIME_TOLERANCE_S
  );
  return before.length > 0 ? (before[before.length - 1] as number) : null;
}

export interface RulerTick {
  t: number;
  /** Set on labelled ticks (whole and half seconds at the finest step). */
  label?: string;
}

const TICK_STEPS = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const COARSEST_STEP = 600;

/**
 * Ruler ticks every 0.25 s, labelled on whole and half seconds. A long
 * study coarsens the step (keeping at most `maxTicks`), labelling every
 * other tick.
 */
export function rulerTicks(durationS: number, maxTicks = 80): RulerTick[] {
  if (!(durationS > 0)) return [];
  const step =
    TICK_STEPS.find((s) => durationS / s + 1 <= maxTicks) ?? COARSEST_STEP;
  const labelEvery = step * 2;
  const ticks: RulerTick[] = [];
  const count = Math.floor(durationS / step + 1e-9);
  for (let index = 0; index <= count; index += 1) {
    const t = roundTime(index * step);
    const ratio = t / labelEvery;
    const labelled = Math.abs(ratio - Math.round(ratio)) < 1e-9;
    ticks.push(labelled ? { t, label: formatTickLabel(t) } : { t });
  }
  return ticks;
}

function formatTickLabel(t: number): string {
  return Number.isInteger(t) ? `${t}s` : `${t.toFixed(1)}s`;
}

/** The study time as the timeline prints it: "0.84". */
export function formatStudyTime(t: number): string {
  return (Math.round(t * 100) / 100).toFixed(2);
}

export function formatDofValue(value: number, unit: AssemblyDofUnit): string {
  const rounded = Math.round(value * 100) / 100;
  const text = Object.is(rounded, -0) ? '0' : String(rounded);
  return unit === 'deg' ? `${text}°` : `${text} mm`;
}

const DOF_NAMES: Readonly<Record<AssemblyJointKind, readonly string[]>> = {
  rigid: [],
  revolute: ['Angle'],
  slider: ['Distance'],
  cylindrical: ['Angle', 'Distance'],
  ball: ['Turn Z', 'Turn Y', 'Turn X'],
  planar: ['Slide X', 'Slide Y', 'Turn']
};

/** "Angle", "Distance"…: one joint motion's name. */
export function dofName(kind: AssemblyJointKind, dof: number): string {
  return DOF_NAMES[kind][dof] ?? `Motion ${dof + 1}`;
}

export function dofUnit(kind: AssemblyJointKind, dof: number): AssemblyDofUnit {
  return ASSEMBLY_JOINT_DOFS[kind][dof] ?? 'mm';
}

/**
 * Joint motions that can take a track, in joint order: those without one
 * that are not coupled to a motion the study already tracks (that track
 * moves them, and would overrule a second).
 */
export function untrackedMotions(
  set: AssemblySet,
  study: AssemblyMotionStudy
): { joint: AssemblyJoint; dof: number }[] {
  const tracked = new Set(study.tracks.map((t) => `${t.jointId}/${t.dof}`));
  const groups = couplingGroupKeys(set);
  const led = new Set<string>();
  for (const key of tracked) {
    const group = groups.get(key);
    if (group !== undefined) led.add(group);
  }
  const result: { joint: AssemblyJoint; dof: number }[] = [];
  for (const joint of set.joints)
    ASSEMBLY_JOINT_DOFS[joint.kind].forEach((_, dof) => {
      const key = `${joint.id}/${dof}`;
      const group = groups.get(key);
      if (!tracked.has(key) && (group === undefined || !led.has(group)))
        result.push({ joint, dof });
    });
  return result;
}

/**
 * The track's value curve as points in a 0–1000 × 0–100 box (time right,
 * value up), for an SVG polyline drawn with `preserveAspectRatio="none"`.
 */
export function trackCurvePoints(
  track: AssemblyTrack,
  durationS: number,
  samples = Math.max(64, track.keys.length * 16)
): string {
  if (!(durationS > 0) || track.keys.length === 0) return '';
  const values = track.keys.map((k) => k.value);
  let low = Math.min(...values);
  let high = Math.max(...values);
  if (high - low < 1e-9) {
    low -= 1;
    high += 1;
  }
  const points: string[] = [];
  const count = Math.min(Math.max(2, samples), 2000);
  for (let index = 0; index <= count; index += 1) {
    const t = (durationS * index) / count;
    const value = evaluateTrack(track, t);
    const x = (1000 * index) / count;
    // Keys' values bound the curve (easing never overshoots); 10% margins.
    const y = 90 - (80 * (value - low)) / (high - low);
    points.push(`${x.toFixed(1)},${y.toFixed(2)}`);
  }
  return points.join(' ');
}

/** Where a key's value sits in the same 0–100 box as its curve. */
export function keyValueY(track: AssemblyTrack, value: number): number {
  const values = track.keys.map((k) => k.value);
  let low = Math.min(...values);
  let high = Math.max(...values);
  if (high - low < 1e-9) {
    low -= 1;
    high += 1;
  }
  return 90 - (80 * (value - low)) / (high - low);
}

/** Why the set would refuse this study, or null when it is valid. */
export function studyError(
  set: AssemblySet,
  study: AssemblyMotionStudy
): string | null {
  const studies = set.studies.some((s) => s.id === study.id)
    ? set.studies.map((s) => (s.id === study.id ? study : s))
    : [...set.studies, study];
  return assemblySetError({ ...set, studies });
}
