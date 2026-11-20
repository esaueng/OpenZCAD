import {
  ASSEMBLY_JOINT_DOFS,
  coupledJointLimits,
  jointSweepRange,
  motionStudyDrivers,
  motionStudyValues,
  solveAssembly,
  transformToMatrix4,
  type AssemblyCouplingEnd,
  type AssemblySet,
  type AssemblySweepPosition,
  type AssemblySweepPositionResult,
  type BodyClashVerdict,
  type BodyId,
  type ProjectDocument
} from '@openzcad/shared';
import { assemblyComponentBodies } from './assembly';
import { isLiveAssemblyBody } from './assembly-bom';

/**
 * AS04 interference through motion (no schema change: a read-only query).
 * The exact pairwise check of `assembly-interference.ts`, run at positions
 * along one motion: a joint's Animate sweep (its limits, or a full turn for
 * an unlimited angle) or a motion study's timeline. Only pairs whose
 * relative pose changes along the motion are checked; every other pair is
 * where the static check left it.
 *
 * The motion is sampled, and labelled so: evenly spaced positions, then,
 * wherever a pair's verdict turns between overlap and no overlap, the gap
 * is halved {@link SWEEP_REFINEMENTS} times, so each reported start and end
 * of an overlap is within 1/2^SWEEP_REFINEMENTS of a step of where it
 * turns. An overlap shorter than one step can fall between positions and
 * is not claimed to be absent: a pair is "clear at every position checked",
 * never plain clear.
 */

/** A joint's Animate sweep, or a motion study's timeline. */
export type AssemblySweepSource =
  | { kind: 'joint'; jointId: string; dof: number }
  | { kind: 'study'; studyId: string };

/** Evenly spaced steps along a joint's sweep (37 positions, ends included). */
export const SWEEP_JOINT_STEPS = 36;
/** Steps per second of a motion study, within the bounds below. */
export const SWEEP_STUDY_STEPS_PER_S = 8;
export const SWEEP_MIN_STEPS = 24;
export const SWEEP_MAX_STEPS = 120;
/** Halvings of a step where a pair's verdict turns. */
export const SWEEP_REFINEMENTS = 4;
/** At most this many pair checks in one sweep, refinements included. */
export const MAX_SWEEP_PAIR_CHECKS = 4000;

export interface AssemblySweepPlan {
  source: AssemblySweepSource;
  /** What the positions are measured in: the joint's unit, or seconds. */
  unit: 'deg' | 'mm' | 's';
  from: number;
  to: number;
  /** The evenly spaced positions, `from` and `to` included. */
  positions: number[];
  /** Components with a live body, in display order. */
  components: { componentId: string; bodyId: BodyId }[];
  /** Components with no body to check: listed, never treated as clear. */
  missing: string[];
  /** Pairs (display order, a before b) that move relative to each other. */
  pairs: [string, string][];
  /** Pairs that keep their relative pose: the static check covers them. */
  still: number;
}

function sourceDrivers(
  set: AssemblySet,
  source: AssemblySweepSource
): AssemblyCouplingEnd[] {
  if (source.kind === 'joint')
    return [{ jointId: source.jointId, dof: source.dof }];
  const study = set.studies.find((entry) => entry.id === source.studyId);
  return study ? motionStudyDrivers(study) : [];
}

function sourceValues(
  set: AssemblySet,
  source: AssemblySweepSource,
  at: number
): Map<string, number[]> {
  if (source.kind === 'study') {
    const study = set.studies.find((entry) => entry.id === source.studyId);
    if (!study) throw new Error('That motion study is not in the assembly.');
    return motionStudyValues(set, study, at);
  }
  const values = new Map<string, number[]>();
  for (const joint of set.joints) values.set(joint.id, [...joint.values]);
  const own = values.get(source.jointId);
  if (own) own[source.dof] = at;
  return values;
}

/** Every component's pose at position `at` of the motion. */
export function assemblySweepPoses(
  set: AssemblySet,
  source: AssemblySweepSource,
  at: number
): Map<string, number[]> {
  const solution = solveAssembly(
    set,
    sourceValues(set, source, at),
    sourceDrivers(set, source)
  );
  const out = new Map<string, number[]>();
  for (const [componentId, pose] of solution.poses)
    out.set(componentId, transformToMatrix4(pose));
  return out;
}

/**
 * The transient values that pose a position, as the motion's own player
 * does: a joint sweep overrides only the swept joint (its mates follow it
 * through the coupling drivers), a study every joint its timeline sets.
 */
export function assemblySweepOverrides(
  set: AssemblySet,
  source: AssemblySweepSource,
  at: number
): { overrides: Map<string, number[]>; drivers: AssemblyCouplingEnd[] } {
  const values = sourceValues(set, source, at);
  return {
    overrides:
      source.kind === 'joint'
        ? new Map([[source.jointId, values.get(source.jointId) ?? []]])
        : values,
    drivers: sourceDrivers(set, source)
  };
}

/** b's pose seen from a: a⁻¹ · b, for rigid column-major matrices. */
function relative(a: readonly number[], b: readonly number[]): number[] {
  // The inverse of a rigid [R t] is [Rᵀ −Rᵀt].
  const out = new Array<number>(16).fill(0);
  const inv = new Array<number>(16).fill(0);
  for (let r = 0; r < 3; r += 1)
    for (let c = 0; c < 3; c += 1) inv[c * 4 + r] = a[r * 4 + c]!;
  for (let r = 0; r < 3; r += 1)
    inv[12 + r] = -(
      inv[r]! * a[12]! +
      inv[4 + r]! * a[13]! +
      inv[8 + r]! * a[14]!
    );
  inv[15] = 1;
  for (let c = 0; c < 4; c += 1)
    for (let r = 0; r < 4; r += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += inv[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = sum;
    }
  return out;
}

/**
 * The sweep a source asks for, or the reason it cannot be swept: an
 * unknown joint or study, a rigid joint, an unlimited slide, an empty
 * study, or a motion that moves no pair of parts relative to each other.
 */
export function planAssemblySweep(
  document: ProjectDocument,
  source: AssemblySweepSource,
  isLive: (bodyId: BodyId) => boolean = (bodyId) =>
    isLiveAssemblyBody(document, bodyId)
): { ok: true; plan: AssemblySweepPlan } | { ok: false; reason: string } {
  const set = document.assembly;
  if (!set || set.components.length < 2)
    return {
      ok: false,
      reason: 'Add a second part to check for interference.'
    };
  let unit: AssemblySweepPlan['unit'];
  let from: number;
  let to: number;
  let steps: number;
  if (source.kind === 'joint') {
    const joint = set.joints.find((entry) => entry.id === source.jointId);
    if (!joint)
      return { ok: false, reason: 'That joint is not in the assembly.' };
    const dofUnit = ASSEMBLY_JOINT_DOFS[joint.kind][source.dof];
    if (!dofUnit)
      return { ok: false, reason: `${joint.name} has no motion to sweep.` };
    // As Animate sweeps it: a coupled joint only as far as its mates allow.
    const range = jointSweepRange(
      { kind: joint.kind, limits: coupledJointLimits(set, joint) },
      source.dof
    );
    if (!range)
      return {
        ok: false,
        reason: `Set limits on ${joint.name} to give it a range to sweep.`
      };
    unit = dofUnit;
    from = range.min;
    to = range.max;
    steps = SWEEP_JOINT_STEPS;
  } else {
    const study = set.studies.find((entry) => entry.id === source.studyId);
    if (!study)
      return { ok: false, reason: 'That motion study is not in the assembly.' };
    if (!(study.durationS > 0) || study.tracks.length === 0)
      return { ok: false, reason: `${study.name} has no motion to sweep.` };
    unit = 's';
    from = 0;
    to = study.durationS;
    steps = Math.min(
      SWEEP_MAX_STEPS,
      Math.max(SWEEP_MIN_STEPS, Math.ceil(to * SWEEP_STUDY_STEPS_PER_S))
    );
  }
  const positions = Array.from(
    { length: steps + 1 },
    (_, index) => from + ((to - from) * index) / steps
  );
  positions[steps] = to;
  const bodies = assemblyComponentBodies(document, isLive);
  const components: AssemblySweepPlan['components'] = [];
  const missing: string[] = [];
  for (const component of set.components) {
    const bodyId = bodies.get(component.id);
    if (bodyId) components.push({ componentId: component.id, bodyId });
    else missing.push(component.id);
  }
  const poses = positions.map((at) => assemblySweepPoses(set, source, at));
  const pairs: [string, string][] = [];
  let still = 0;
  for (let i = 0; i < components.length; i += 1)
    for (let j = i + 1; j < components.length; j += 1) {
      const a = components[i]!.componentId;
      const b = components[j]!.componentId;
      const first = poses[0]!;
      if (!first.has(a) || !first.has(b)) continue;
      const base = relative(first.get(a)!, first.get(b)!);
      const moves = poses.some((pose) => {
        const rel = relative(pose.get(a)!, pose.get(b)!);
        return rel.some((value, index) => {
          const scale = index >= 12 ? Math.max(1, Math.abs(base[index]!)) : 1;
          return Math.abs(value - base[index]!) > 1e-9 * scale;
        });
      });
      if (moves) pairs.push([a, b]);
      else still += 1;
    }
  if (pairs.length === 0)
    return {
      ok: false,
      reason: 'This motion moves no part relative to another.'
    };
  if (pairs.length * positions.length > MAX_SWEEP_PAIR_CHECKS)
    return {
      ok: false,
      reason: `This motion moves ${pairs.length} pairs of parts: too many to check at ${positions.length} positions.`
    };
  return {
    ok: true,
    plan: {
      source,
      unit,
      from,
      to,
      positions,
      components,
      missing,
      pairs,
      still
    }
  };
}

/** The worker's input for positions `at`, each checking `pairs`. */
export function assemblySweepPositions(
  document: ProjectDocument,
  plan: AssemblySweepPlan,
  asks: readonly { at: number; pairs: readonly [string, string][] }[]
): AssemblySweepPosition[] {
  const set = document.assembly!;
  return asks.map(({ at, pairs }) => {
    const poses = assemblySweepPoses(set, plan.source, at);
    const named = new Set(pairs.flat());
    const matrices: Record<string, number[]> = {};
    for (const id of named) {
      const pose = poses.get(id);
      if (pose) matrices[id] = pose;
    }
    return { at, matrices, pairs: pairs.map(([a, b]) => [a, b]) };
  });
}

const overlaps = (verdict: BodyClashVerdict) => verdict.kind === 'interference';

const pairKey = (a: string, b: string) => `${a}\u0000${b}`;

/**
 * Where to check next: the midpoint of every gap between neighbouring
 * positions across which some pair turns between overlap and no overlap
 * (an unknown position decides nothing either way), with the pairs that
 * turn there. Empty when no verdict turns.
 */
export function assemblySweepRefinements(
  results: readonly AssemblySweepPositionResult[]
): { at: number; pairs: [string, string][] }[] {
  const byPair = new Map<
    string,
    {
      a: string;
      b: string;
      checks: { at: number; verdict: BodyClashVerdict }[];
    }
  >();
  for (const result of results)
    for (const pair of result.pairs) {
      const key = pairKey(pair.a, pair.b);
      const entry = byPair.get(key) ?? { a: pair.a, b: pair.b, checks: [] };
      entry.checks.push({ at: result.at, verdict: pair.verdict });
      byPair.set(key, entry);
    }
  const asks = new Map<number, [string, string][]>();
  const ask = (at: number, a: string, b: string) => {
    const pairs = asks.get(at) ?? [];
    if (!pairs.some(([x, y]) => x === a && y === b)) pairs.push([a, b]);
    asks.set(at, pairs);
  };
  for (const { a, b, checks } of byPair.values()) {
    checks.sort((p, q) => p.at - q.at);
    const decided = checks.filter((check) => check.verdict.kind !== 'unknown');
    for (let i = 0; i + 1 < decided.length; i += 1) {
      const p = decided[i]!;
      const q = decided[i + 1]!;
      if (overlaps(p.verdict) === overlaps(q.verdict)) continue;
      // Every gap between the two, undecided positions included, is
      // halved: an unknown midpoint never stops the turn being narrowed.
      const span = checks.filter(
        (check) => check.at >= p.at && check.at <= q.at
      );
      for (let k = 0; k + 1 < span.length; k += 1)
        ask((span[k]!.at + span[k + 1]!.at) / 2, a, b);
    }
  }
  return [...asks]
    .sort(([p], [q]) => p - q)
    .map(([at, pairs]) => ({ at, pairs }));
}

/** One moving pair's verdict along the motion. */
export interface AssemblySweptPair {
  a: string;
  b: string;
  /**
   * The stretches it overlaps, as the first and last positions found
   * overlapping; the turn lies within `resolution` beyond each end (or at
   * the motion's own end).
   */
  overlaps: {
    from: number;
    to: number;
    /**
     * How far before `from` and after `to` the turn can lie: the gap to the
     * nearest position decided not to overlap (0 at the motion's own end).
     * Wider than the report's resolution only where undecided positions
     * sit between.
     */
    fromWithin: number;
    toWithin: number;
  }[];
  /**
   * The position of the largest measured overlap (the first unmeasured one
   * when none is measured), with its verdict and witnesses.
   */
  worst: { at: number; verdict: BodyClashVerdict } | null;
  /** Positions the kernel could not decide: never read as clear. */
  unknownAt: number[];
  /** The smallest certified gap at a position without overlap, if any. */
  closest: { at: number; distance: number } | null;
  /** Touching (contact without overlap) somewhere along the motion. */
  touches: boolean;
}

export interface AssemblySweepReport {
  /** Spacing of the even positions, in the plan's unit. */
  step: number;
  /** How near each reported turn is: `step / 2^SWEEP_REFINEMENTS` or finer. */
  resolution: number;
  checked: number;
  pairs: AssemblySweptPair[];
  missing: string[];
  still: number;
}

/** The plan's positions and refinements, summed up per pair. */
export function summarizeAssemblySweep(
  plan: AssemblySweepPlan,
  results: readonly AssemblySweepPositionResult[],
  /** Components the worker found no exact geometry for. */
  workerMissing: readonly string[] = []
): AssemblySweepReport {
  const step =
    plan.positions.length > 1
      ? (plan.to - plan.from) / (plan.positions.length - 1)
      : 0;
  const byPair = new Map<string, { at: number; verdict: BodyClashVerdict }[]>();
  for (const result of results)
    for (const pair of result.pairs) {
      const key = pairKey(pair.a, pair.b);
      const list = byPair.get(key) ?? [];
      list.push({ at: result.at, verdict: pair.verdict });
      byPair.set(key, list);
    }
  const missing = new Set([...plan.missing, ...workerMissing]);
  const pairs: AssemblySweptPair[] = [];
  for (const [a, b] of plan.pairs) {
    // A pair with a part that has no geometry was not checked at all: it is
    // reported through `missing`, never as a pair clear along the motion.
    if (missing.has(a) || missing.has(b)) continue;
    const list = (byPair.get(pairKey(a, b)) ?? []).sort((p, q) => p.at - q.at);
    const stretches: AssemblySweptPair['overlaps'] = [];
    let open: AssemblySweptPair['overlaps'][number] | null = null;
    let worst: AssemblySweptPair['worst'] = null;
    let worstVolume = -1;
    const unknownAt: number[] = [];
    let closest: AssemblySweptPair['closest'] = null;
    let touches = false;
    for (const { at, verdict } of list) {
      if (verdict.kind === 'interference') {
        if (open) open.to = at;
        else {
          open = { from: at, to: at, fromWithin: 0, toWithin: 0 };
          stretches.push(open);
        }
        const volume = verdict.volume ?? -0.5;
        if (worst === null || volume > worstVolume) {
          worst = { at, verdict };
          worstVolume = volume;
        }
        continue;
      }
      // An unknown position neither ends nor continues a stretch.
      if (verdict.kind === 'unknown') {
        unknownAt.push(at);
        continue;
      }
      open = null;
      if (verdict.touching === true) touches = true;
      if (
        verdict.distance !== null &&
        (closest === null || verdict.distance < closest.distance)
      )
        closest = { at, distance: verdict.distance };
    }
    // How near each turn is known: the gap to the nearest position decided
    // to be free of overlap on that side (none: the motion's own end).
    const free = list
      .filter(({ verdict }) => verdict.kind === 'clear')
      .map(({ at }) => at);
    for (const stretch of stretches) {
      const before = free.filter((at) => at < stretch.from);
      const after = free.filter((at) => at > stretch.to);
      stretch.fromWithin =
        before.length > 0 ? stretch.from - Math.max(...before) : 0;
      stretch.toWithin = after.length > 0 ? Math.min(...after) - stretch.to : 0;
    }
    pairs.push({
      a,
      b,
      overlaps: stretches,
      worst,
      unknownAt,
      closest,
      touches
    });
  }
  const atAll = new Set(results.map((result) => result.at));
  return {
    step,
    resolution: step / 2 ** SWEEP_REFINEMENTS,
    checked: atAll.size,
    pairs,
    missing: [...missing],
    still: plan.still
  };
}

/**
 * The order to show a sweep's pairs in: overlapping first (largest measured
 * overlap first), then pairs with unknown positions, then touching, then
 * the rest in display order. Stable.
 */
export function sortSweptPairs(
  pairs: readonly AssemblySweptPair[]
): AssemblySweptPair[] {
  const rank = (pair: AssemblySweptPair) =>
    pair.overlaps.length > 0
      ? 0
      : pair.unknownAt.length > 0
        ? 1
        : pair.touches
          ? 2
          : 3;
  const volume = (pair: AssemblySweptPair) =>
    pair.worst?.verdict.kind === 'interference'
      ? (pair.worst.verdict.volume ?? -1)
      : -1;
  return pairs
    .map((pair, index) => ({ pair, index }))
    .sort(
      (p, q) =>
        rank(p.pair) - rank(q.pair) ||
        volume(q.pair) - volume(p.pair) ||
        p.index - q.index
    )
    .map(({ pair }) => pair);
}

/** Checks positions in the geometry worker (`assemblyInterferenceSweep`). */
export type AssemblySweepCheck = (
  document: ProjectDocument,
  components: AssemblySweepPlan['components'],
  positions: AssemblySweepPosition[]
) => Promise<{ positions: AssemblySweepPositionResult[]; missing: string[] }>;

/**
 * Runs a planned sweep: every pair at the even positions, then
 * {@link SWEEP_REFINEMENTS} rounds halving each gap where a pair's verdict
 * turns, each round one worker request.
 */
export async function runAssemblySweep(
  document: ProjectDocument,
  plan: AssemblySweepPlan,
  check: AssemblySweepCheck
): Promise<AssemblySweepReport> {
  const first = await check(
    document,
    plan.components,
    assemblySweepPositions(
      document,
      plan,
      plan.positions.map((at) => ({ at, pairs: plan.pairs }))
    )
  );
  const results = [...first.positions];
  const missing = new Set(first.missing);
  for (let round = 0; round < SWEEP_REFINEMENTS; round += 1) {
    const asks = assemblySweepRefinements(results);
    if (asks.length === 0) break;
    const next = await check(
      document,
      plan.components,
      assemblySweepPositions(document, plan, asks)
    );
    results.push(...next.positions);
    for (const id of next.missing) missing.add(id);
  }
  return summarizeAssemblySweep(plan, results, [...missing]);
}
