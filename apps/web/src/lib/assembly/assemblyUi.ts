import { useSyncExternalStore } from 'react';
import {
  ASSEMBLY_JOINT_DOFS,
  MAX_ASSEMBLY_NAME_LENGTH,
  jointSweepRange,
  type AssemblyDofLimit,
  type AssemblyDofUnit,
  type AssemblyFrameSourceKind,
  type AssemblyJoint,
  type AssemblyJointKind,
  type AssemblyPlayback,
  type AssemblySet,
  type AssemblySolution,
  type AssemblyUnsolvedReason,
  type BodyId
} from '@openzcad/shared';

/**
 * Presentation helpers for the Assemble workspace (AS01/AS02/AS06): names,
 * value formatting and the checks the panels show. Pure, apart from the
 * small Animate preference store at the end.
 */

export interface JointKindMeta {
  label: string;
  /** One line under the type picker's tile. */
  hint: string;
}

export const JOINT_KIND_META: Readonly<
  Record<AssemblyJointKind, JointKindMeta>
> = {
  rigid: { label: 'Rigid', hint: 'Locked together' },
  revolute: { label: 'Revolute', hint: 'Turns about an axis' },
  slider: { label: 'Slider', hint: 'Slides along an axis' },
  cylindrical: { label: 'Cylindrical', hint: 'Turns and slides' },
  ball: { label: 'Ball', hint: 'Turns any way' },
  planar: { label: 'Planar', hint: 'Slides on a plane' }
};

/** What each of a joint's free values is called, in its DOF order. */
const DOF_LABELS: Readonly<Record<AssemblyJointKind, readonly string[]>> = {
  rigid: [],
  revolute: ['Angle'],
  slider: ['Distance'],
  cylindrical: ['Angle', 'Distance'],
  ball: ['Turn Z', 'Turn Y', 'Turn X'],
  planar: ['Slide X', 'Slide Y', 'Angle']
};

export function dofLabel(kind: AssemblyJointKind, dof: number): string {
  return DOF_LABELS[kind][dof] ?? `Value ${dof + 1}`;
}

export function dofCountLabel(count: number): string {
  return `${count} DOF`;
}

export function unitSymbol(unit: AssemblyDofUnit): string {
  return unit === 'deg' ? '°' : 'mm';
}

/** "12.0°", "-4.5 mm": one decimal, never "-0.0". */
export function formatAssemblyValue(
  value: number,
  unit: AssemblyDofUnit
): string {
  const rounded = Math.round(value * 10) / 10;
  const text = (Object.is(rounded, -0) ? 0 : rounded).toFixed(1);
  return unit === 'deg' ? `${text}°` : `${text} mm`;
}

/** A joint's current values on one line; a rigid joint has none to show. */
export function jointValueSummary(
  kind: AssemblyJointKind,
  values: readonly number[]
): string {
  const units = ASSEMBLY_JOINT_DOFS[kind];
  if (units.length === 0) return 'Fixed';
  return units
    .map((unit, index) => formatAssemblyValue(values[index] ?? 0, unit))
    .join(' · ');
}

const ROUND_SOURCES: readonly AssemblyFrameSourceKind[] = [
  'circle',
  'cylinder'
];

/**
 * The joint type the two picks suggest: round onto round turns, flat onto
 * flat locks, a straight edge slides, anything else turns.
 */
export function suggestJointKind(
  moving: AssemblyFrameSourceKind | null | undefined,
  target: AssemblyFrameSourceKind | null | undefined
): AssemblyJointKind {
  if (!moving || !target) return 'revolute';
  if (ROUND_SOURCES.includes(moving) && ROUND_SOURCES.includes(target))
    return 'revolute';
  if (moving === 'plane' && target === 'plane') return 'rigid';
  if (moving === 'line' || target === 'line') return 'slider';
  return 'revolute';
}

export function unsolvedReasonText(reason: AssemblyUnsolvedReason): string {
  return reason === 'loop'
    ? 'Closes a loop, which is not solved yet'
    : 'Both ends are grounded, so it cannot move';
}

/** The DOF chip in the panel header. */
export function assemblyStatusChip(
  set: AssemblySet,
  solution: AssemblySolution
): { label: string; tone: 'ok' | 'warning' } {
  // Plain words, not degrees of freedom: what the user needs to act on.
  if (set.components.length === 0) return { label: 'Empty', tone: 'ok' };
  if (solution.grounded === 0)
    return { label: 'Nothing fixed', tone: 'warning' };
  if (solution.unsolved.size > 0)
    return {
      label: `${solution.unsolved.size} can’t move`,
      tone: 'warning'
    };
  if (set.joints.length === 0) return { label: 'No joints yet', tone: 'ok' };
  return { label: 'Ready', tone: 'ok' };
}

/** Components whose body (and every body made from it) is gone. */
export function missingBodyComponents(
  set: AssemblySet,
  bodyByComponent: ReadonlyMap<string, BodyId | null>
): string[] {
  return set.components
    .filter((c) => bodyByComponent.get(c.id) === null)
    .map((c) => c.id);
}

/** The joint value an Animate sweep drives: the first one with a range. */
export function sweepDof(
  joint: Pick<AssemblyJoint, 'kind' | 'limits'>
): number | null {
  const count = ASSEMBLY_JOINT_DOFS[joint.kind].length;
  for (let dof = 0; dof < count; dof += 1)
    if (jointSweepRange(joint, dof)) return dof;
  return null;
}

/** Why a joint cannot be animated, or null when it can. */
export function sweepUnavailableReason(
  joint: Pick<AssemblyJoint, 'kind' | 'limits'>
): string | null {
  if (ASSEMBLY_JOINT_DOFS[joint.kind].length === 0)
    return 'A rigid joint has no motion to play.';
  if (sweepDof(joint) === null)
    return 'Set limits on this slide to give it a range to play.';
  return null;
}

/** A starting limit for a value that has none: around where it is now. */
export function defaultLimit(
  unit: AssemblyDofUnit,
  value: number
): AssemblyDofLimit {
  const [min, max] = unit === 'deg' ? [-90, 90] : [0, 100];
  return { min: Math.min(min, value), max: Math.max(max, value) };
}

/** The slider's travel: the limit, else a turn either way or ±100 mm. */
export function sliderRange(
  unit: AssemblyDofUnit,
  limit: AssemblyDofLimit | null | undefined,
  value: number
): AssemblyDofLimit {
  if (limit && limit.max > limit.min) return limit;
  if (unit === 'deg')
    return { min: Math.min(-180, value), max: Math.max(180, value) };
  return { min: Math.min(-100, value - 100), max: Math.max(100, value + 100) };
}

/** A stored name: trimmed and within the schema's length. */
export function assemblyName(name: string, fallback: string): string {
  const trimmed = name.trim().slice(0, MAX_ASSEMBLY_NAME_LENGTH).trim();
  return trimmed || fallback;
}

/** "Position 1", "Position 2"…: the next unused position name. */
export function nextPositionName(set: AssemblySet | undefined): string {
  const names = new Set((set?.positions ?? []).map((p) => p.name));
  for (let n = 1; ; n += 1)
    if (!names.has(`Position ${n}`)) return `Position ${n}`;
}

// ── Animate preferences ─────────────────────────────────────────────────
//
// How the Inspector's Animate controls play a joint, shared with the
// panel's small play buttons and the Space key so all three play the same
// way. Per session only: a preference, not document content.

export interface AnimatePrefs {
  mode: AssemblyPlayback;
  sweepS: number;
}

export const ANIMATE_MODES: readonly {
  mode: AssemblyPlayback;
  label: string;
}[] = [
  { mode: 'once', label: 'Once' },
  { mode: 'loop', label: 'Loop' },
  { mode: 'ping-pong', label: 'Back and forth' }
];

export const ANIMATE_SPEEDS: readonly { sweepS: number; label: string }[] = [
  { sweepS: 3, label: '3 s' },
  { sweepS: 1.5, label: '1.5 s' },
  { sweepS: 0.75, label: '0.75 s' },
  { sweepS: 0.4, label: '0.4 s' }
];

let animatePrefs: AnimatePrefs = { mode: 'ping-pong', sweepS: 1.5 };
const animateListeners = new Set<() => void>();

export function getAnimatePrefs(): AnimatePrefs {
  return animatePrefs;
}

export function setAnimatePrefs(partial: Partial<AnimatePrefs>): void {
  animatePrefs = { ...animatePrefs, ...partial };
  for (const listener of animateListeners) listener();
}

export function useAnimatePrefs(): AnimatePrefs {
  return useSyncExternalStore(
    (listener) => {
      animateListeners.add(listener);
      return () => animateListeners.delete(listener);
    },
    () => animatePrefs,
    () => animatePrefs
  );
}
