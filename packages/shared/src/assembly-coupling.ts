import {
  ASSEMBLY_JOINT_DOFS,
  MAX_ASSEMBLY_MAGNITUDE,
  MIN_ASSEMBLY_COUPLING_RATIO,
  couplingEndKey,
  type AssemblyCoupling,
  type AssemblyCouplingEnd,
  type AssemblyDofLimit,
  type AssemblyJoint,
  type AssemblySet
} from './assembly';

/**
 * Joint couplings (AS02 gear coupling, schema v55): joint values that move
 * together. Each coupling is one linear relation between two joint values,
 * `driven = ratio × driver + offset`, and the stored couplings never form a
 * loop, so every group of coupled motions has exactly one free value and
 * every member is a linear function of it. Solving is therefore exact and
 * needs no iteration:
 *
 * 1. the member that was moved (else the group's first) gives that value;
 * 2. it is clamped into the range every member's limits allow, so a driven
 *    joint's limit stops its driver;
 * 3. every member is written from it.
 *
 * Pure over joint values: no frames or poses, so the kinematics solve reads
 * it before placing anything.
 */

export interface AssemblyCouplingMember extends AssemblyCouplingEnd {
  /** This motion's value is `scale × lead + shift`, lead the group's first. */
  scale: number;
  shift: number;
}

export interface AssemblyCouplingGroup {
  /** In the order the couplings reach them; the first leads by default. */
  members: AssemblyCouplingMember[];
  /** The couplings that link them, in stored order. */
  couplingIds: string[];
}

/** Relative slack for "the same ratio" and for limits that only just meet. */
const COUPLING_TOLERANCE = 1e-9;

function near(a: number, b: number): boolean {
  return (
    Math.abs(a - b) <=
    COUPLING_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b))
  );
}

function usableEnd(
  end: AssemblyCouplingEnd,
  joints: ReadonlyMap<string, AssemblyJoint>
): boolean {
  const joint = joints.get(end.jointId);
  return (
    !!joint &&
    Number.isInteger(end.dof) &&
    end.dof >= 0 &&
    end.dof < ASSEMBLY_JOINT_DOFS[joint.kind].length
  );
}

function usableRatio(ratio: number): boolean {
  return (
    Number.isFinite(ratio) &&
    Math.abs(ratio) >= MIN_ASSEMBLY_COUPLING_RATIO &&
    Math.abs(ratio) <= MAX_ASSEMBLY_MAGNITUDE
  );
}

/**
 * The groups of motions the couplings tie together. A coupling that names a
 * missing motion, has no usable ratio, or would close a loop is left out
 * (validation refuses to store one; a solve must still never hang on it).
 */
export function couplingGroups(
  set: Pick<AssemblySet, 'joints' | 'couplings'>
): AssemblyCouplingGroup[] {
  const couplings = set.couplings;
  if (!couplings || couplings.length === 0) return [];
  const joints = new Map(set.joints.map((j) => [j.id, j]));
  interface Edge {
    to: string;
    end: AssemblyCouplingEnd;
    scale: number;
    shift: number;
    couplingId: string;
  }
  const edges = new Map<string, Edge[]>();
  const root = new Map<string, string>();
  const find = (key: string): string => {
    let at = key;
    for (;;) {
      const next = root.get(at);
      if (next === undefined || next === at) break;
      at = next;
    }
    root.set(key, at);
    return at;
  };
  const link = (from: string, edge: Edge) => {
    const list = edges.get(from) ?? [];
    list.push(edge);
    edges.set(from, list);
  };
  const order: string[] = [];
  const ends = new Map<string, AssemblyCouplingEnd>();
  for (const coupling of couplings) {
    const { driver, driven, ratio, offset } = coupling;
    if (
      !usableEnd(driver, joints) ||
      !usableEnd(driven, joints) ||
      driver.jointId === driven.jointId ||
      !usableRatio(ratio) ||
      !Number.isFinite(offset)
    )
      continue;
    const a = couplingEndKey(driver);
    const b = couplingEndKey(driven);
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) continue;
    root.set(ra, rb);
    for (const [key, end] of [
      [a, driver],
      [b, driven]
    ] as const)
      if (!ends.has(key)) {
        ends.set(key, end);
        order.push(key);
      }
    // driven = ratio·driver + offset, and back: driver = (driven − offset)/ratio.
    link(a, {
      to: b,
      end: driven,
      scale: ratio,
      shift: offset,
      couplingId: coupling.id
    });
    link(b, {
      to: a,
      end: driver,
      scale: 1 / ratio,
      shift: -offset / ratio,
      couplingId: coupling.id
    });
  }
  const groups: AssemblyCouplingGroup[] = [];
  const placed = new Set<string>();
  for (const start of order) {
    if (placed.has(start)) continue;
    const first = ends.get(start) as AssemblyCouplingEnd;
    const members: AssemblyCouplingMember[] = [
      { jointId: first.jointId, dof: first.dof, scale: 1, shift: 0 }
    ];
    const used = new Set<string>();
    placed.add(start);
    for (let index = 0; index < members.length; index += 1) {
      const from = members[index] as AssemblyCouplingMember;
      for (const edge of edges.get(couplingEndKey(from)) ?? []) {
        used.add(edge.couplingId);
        if (placed.has(edge.to)) continue;
        placed.add(edge.to);
        members.push({
          jointId: edge.end.jointId,
          dof: edge.end.dof,
          scale: edge.scale * from.scale,
          shift: edge.scale * from.shift + edge.shift
        });
      }
    }
    groups.push({
      members,
      couplingIds: couplings.filter((c) => used.has(c.id)).map((c) => c.id)
    });
  }
  return groups;
}

function clampInto(
  value: number,
  limit: AssemblyDofLimit | null | undefined
): number {
  return limit ? Math.min(limit.max, Math.max(limit.min, value)) : value;
}

/**
 * The lead values every member's limits allow. `feasible` is false when the
 * limits leave the group no shared position at all.
 */
function groupRange(
  group: AssemblyCouplingGroup,
  joints: ReadonlyMap<string, AssemblyJoint>
): { lo: number; hi: number; feasible: boolean } {
  let lo = -Infinity;
  let hi = Infinity;
  for (const member of group.members) {
    const limit = joints.get(member.jointId)?.limits[member.dof];
    if (!limit) continue;
    const a = (limit.min - member.shift) / member.scale;
    const b = (limit.max - member.shift) / member.scale;
    lo = Math.max(lo, Math.min(a, b));
    hi = Math.min(hi, Math.max(a, b));
  }
  if (lo > hi && near(lo, hi)) {
    // Limits that meet at one point, a rounding apart.
    const mid = (lo + hi) / 2;
    return { lo: mid, hi: mid, feasible: true };
  }
  return { lo, hi, feasible: lo <= hi };
}

/**
 * Every joint's values with its limits and the couplings applied.
 * `overrides` are candidate values (a drag, a playback frame, a pose being
 * saved); joints without one keep their stored values. In each coupled
 * group the first member whose candidate differs from its stored value
 * leads and the rest follow it; when none differs the group's first member
 * leads with its stored value, so a saved pose always reads the same way.
 */
export function coupledJointValues(
  set: Pick<AssemblySet, 'joints' | 'couplings'>,
  overrides?: ReadonlyMap<string, readonly number[]>
): Map<string, number[]> {
  const values = new Map<string, number[]>();
  for (const joint of set.joints) {
    const raw = overrides?.get(joint.id) ?? joint.values;
    values.set(
      joint.id,
      ASSEMBLY_JOINT_DOFS[joint.kind].map((_, index) => {
        const value = raw[index];
        return clampInto(
          typeof value === 'number' && Number.isFinite(value) ? value : 0,
          joint.limits[index]
        );
      })
    );
  }
  if (!set.couplings || set.couplings.length === 0) return values;
  const joints = new Map(set.joints.map((j) => [j.id, j]));
  const at = (member: AssemblyCouplingEnd): number =>
    (values.get(member.jointId) as number[])[member.dof] as number;
  for (const group of couplingGroups(set)) {
    const first = group.members[0];
    if (!first) continue;
    const lead =
      group.members.find(
        (member) =>
          overrides?.has(member.jointId) === true &&
          at(member) !== joints.get(member.jointId)?.values[member.dof]
      ) ?? first;
    const leadValue = at(lead);
    const wanted = (leadValue - lead.shift) / lead.scale;
    const range = groupRange(group, joints);
    const x = range.feasible
      ? Math.min(range.hi, Math.max(range.lo, wanted))
      : wanted;
    for (const member of group.members) {
      const joint = joints.get(member.jointId) as AssemblyJoint;
      // The leader keeps its exact value unless a limit moved the group;
      // every value still ends inside its own limit (a rounding at most
      // when the limits agree; the limit wins when they cannot).
      const value =
        member === lead && x === wanted
          ? leadValue
          : member.scale * x + member.shift;
      (values.get(member.jointId) as number[])[member.dof] = clampInto(
        value,
        joint.limits[member.dof]
      );
    }
  }
  return values;
}

/**
 * The range one joint motion can actually travel: its own limit narrowed by
 * the limits of every motion coupled to it. Null when nothing bounds it.
 */
export function coupledDofLimit(
  set: Pick<AssemblySet, 'joints' | 'couplings'>,
  jointId: string,
  dof: number
): AssemblyDofLimit | null {
  const joints = new Map(set.joints.map((j) => [j.id, j]));
  const own = joints.get(jointId)?.limits[dof] ?? null;
  for (const group of couplingGroups(set)) {
    const member = group.members.find(
      (m) => m.jointId === jointId && m.dof === dof
    );
    if (!member) continue;
    const range = groupRange(group, joints);
    if (!range.feasible || !Number.isFinite(range.lo)) return own;
    const a = member.scale * range.lo + member.shift;
    const b = member.scale * range.hi + member.shift;
    return {
      min: clampInto(Math.min(a, b), own),
      max: clampInto(Math.max(a, b), own)
    };
  }
  return own;
}

/** A joint's limits as {@link coupledDofLimit} narrows them. */
export function coupledJointLimits(
  set: Pick<AssemblySet, 'joints' | 'couplings'>,
  joint: Pick<AssemblyJoint, 'id' | 'kind' | 'limits'>
): (AssemblyDofLimit | null)[] {
  if (!set.couplings || set.couplings.length === 0) return joint.limits;
  return ASSEMBLY_JOINT_DOFS[joint.kind].map((_, dof) =>
    coupledDofLimit(set, joint.id, dof)
  );
}

/** The couplings one joint takes part in. */
export function couplingsOfJoint(
  set: Pick<AssemblySet, 'couplings'>,
  jointId: string
): AssemblyCoupling[] {
  return (set.couplings ?? []).filter(
    (c) => c.driver.jointId === jointId || c.driven.jointId === jointId
  );
}

/** The offset that keeps both joints where they are now at this ratio. */
export function couplingOffsetAtPose(
  set: Pick<AssemblySet, 'joints'>,
  coupling: Pick<AssemblyCoupling, 'driver' | 'driven' | 'ratio'>
): number {
  const value = (end: AssemblyCouplingEnd) =>
    set.joints.find((j) => j.id === end.jointId)?.values[end.dof] ?? 0;
  return value(coupling.driven) - coupling.ratio * value(coupling.driver);
}

// ── Editing checks ──────────────────────────────────────────────────────

export type AssemblyCouplingRefusalCode =
  /** An end names a joint the assembly does not have. */
  | 'coupling:unknown-joint'
  /** Both ends are the same joint. */
  | 'coupling:self'
  /** A rigid joint, or a motion the joint does not have. */
  | 'coupling:no-motion'
  /** The joint closes a loop or joins two fixed parts, so it never moves. */
  | 'coupling:joint-not-solved'
  /** Zero, not finite, or out of range. */
  | 'coupling:ratio'
  /** The two motions already move together at this very ratio. */
  | 'coupling:redundant'
  /** They are already linked at another ratio: this would lock them. */
  | 'coupling:conflict'
  /** Their limits leave no position both can reach. */
  | 'coupling:limits';

export interface AssemblyCouplingRefusal {
  code: AssemblyCouplingRefusalCode;
  message: string;
}

/** A coupling being added; without an offset it holds the current pose. */
export type AssemblyCouplingDraft = Pick<
  AssemblyCoupling,
  'driver' | 'driven' | 'ratio'
> & { offset?: number };

/** The group whose limits cannot all be met, as its first coupling's id. */
export function couplingLimitsConflict(
  set: Pick<AssemblySet, 'joints' | 'couplings'>
): string | null {
  const joints = new Map(set.joints.map((j) => [j.id, j]));
  for (const group of couplingGroups(set))
    if (!groupRange(group, joints).feasible) return group.couplingIds[0] ?? '';
  return null;
}

/**
 * Why a coupling cannot be added, or null when it can. `unsolved` is the
 * solve's map of joints that never move (a loop-closing joint, or one
 * between two fixed parts).
 */
export function couplingAddError(
  set: Pick<AssemblySet, 'joints' | 'couplings'>,
  draft: AssemblyCouplingDraft,
  unsolved?: ReadonlyMap<string, unknown>
): AssemblyCouplingRefusal | null {
  const refuse = (
    code: AssemblyCouplingRefusalCode,
    message: string
  ): AssemblyCouplingRefusal => ({ code, message });
  const joints = new Map(set.joints.map((j) => [j.id, j]));
  const driver = joints.get(draft.driver.jointId);
  const driven = joints.get(draft.driven.jointId);
  if (!driver || !driven)
    return refuse(
      'coupling:unknown-joint',
      'Both ends of a coupling must be joints of this assembly.'
    );
  if (driver.id === driven.id)
    return refuse(
      'coupling:self',
      `${driver.name} cannot be coupled to itself; a coupling needs two different joints.`
    );
  for (const [joint, end] of [
    [driver, draft.driver],
    [driven, draft.driven]
  ] as const) {
    if (ASSEMBLY_JOINT_DOFS[joint.kind].length === 0)
      return refuse(
        'coupling:no-motion',
        `${joint.name} is a rigid joint: it has no motion to couple.`
      );
    if (!usableEnd(end, joints))
      return refuse(
        'coupling:no-motion',
        `${joint.name} does not have that motion.`
      );
    if (unsolved?.has(joint.id))
      return refuse(
        'coupling:joint-not-solved',
        `${joint.name} cannot move (it closes a loop or joins two fixed parts), so it cannot be coupled.`
      );
  }
  if (!usableRatio(draft.ratio))
    return refuse(
      'coupling:ratio',
      'A coupling needs a ratio that is a number and not zero.'
    );
  if (draft.offset !== undefined && !Number.isFinite(draft.offset))
    return refuse(
      'coupling:ratio',
      'A coupling needs an offset that is a number.'
    );

  // Already linked through other couplings: one more is a loop.
  const a = couplingEndKey(draft.driver);
  const b = couplingEndKey(draft.driven);
  for (const group of couplingGroups(set)) {
    const from = group.members.find((m) => couplingEndKey(m) === a);
    const to = group.members.find((m) => couplingEndKey(m) === b);
    if (!from || !to) continue;
    // driven = (to.scale/from.scale)·driver + to.shift − that·from.shift.
    const ratio = to.scale / from.scale;
    const offset = to.shift - ratio * from.shift;
    const same =
      near(ratio, draft.ratio) &&
      (draft.offset === undefined || near(offset, draft.offset));
    return same
      ? refuse(
          'coupling:redundant',
          `${driver.name} and ${driven.name} already move together at that ratio.`
        )
      : refuse(
          'coupling:conflict',
          `${driver.name} and ${driven.name} are already coupled at another ratio or phase; a second coupling would lock them.`
        );
  }

  const offset = draft.offset ?? couplingOffsetAtPose(set, draft);
  const trial = {
    joints: set.joints,
    couplings: [
      ...(set.couplings ?? []),
      { id: '\u0000trial', name: 'trial', ...draft, offset }
    ]
  };
  if (couplingLimitsConflict(trial) !== null)
    return refuse(
      'coupling:limits',
      `The limits of ${driver.name} and ${driven.name} leave no position both can reach at that ratio.`
    );
  return null;
}
