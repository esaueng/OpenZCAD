/**
 * Pure logic behind the sketch rail's constraint tools: what each tool needs
 * picked, and how a completed pick sequence becomes persisted
 * `SketchConstraintData`. No React, no document mutation — App owns the
 * picking flow and command execution, tests own this file.
 */
import type {
  EntityId,
  SketchConstraintData,
  SketchNode,
  SketchObjectData,
  SketchPointRef
} from '@openzcad/shared';
import type { ProjectDocument } from '@openzcad/shared';

/** Stage-1 constraint tools; the schema's remaining kinds arrive in stage 2. */
export type PendingConstraintKind =
  | 'horizontal'
  | 'vertical'
  | 'parallel'
  | 'coincident'
  | 'radius';

export type ConstraintPick =
  | { kind: 'object'; objectId: string }
  | { kind: 'point'; objectId: string; point: 'start' | 'end' | 'center' };

export interface ConstraintToolSpec {
  kind: PendingConstraintKind;
  label: string;
  /** How many picks complete the constraint. */
  picks: 1 | 2;
  /** Whether the tool consumes whole objects or named points. */
  pickKind: 'object' | 'point';
  /** Instruction shown while the tool is armed. */
  hint: string;
}

export const CONSTRAINT_TOOL_SPECS: readonly ConstraintToolSpec[] = [
  {
    kind: 'horizontal',
    label: 'Horizontal',
    picks: 1,
    pickKind: 'object',
    hint: 'Click a line to make it horizontal.'
  },
  {
    kind: 'vertical',
    label: 'Vertical',
    picks: 1,
    pickKind: 'object',
    hint: 'Click a line to make it vertical.'
  },
  {
    kind: 'parallel',
    label: 'Parallel',
    picks: 2,
    pickKind: 'object',
    hint: 'Click two lines to make them parallel.'
  },
  {
    kind: 'coincident',
    label: 'Coincident',
    picks: 2,
    pickKind: 'point',
    hint: 'Click two snap points (endpoints or centers) to join them.'
  },
  {
    kind: 'radius',
    label: 'Radius',
    picks: 1,
    pickKind: 'object',
    hint: 'Click a circle or arc to pin its current radius.'
  }
] as const;

export function constraintToolSpec(
  kind: PendingConstraintKind
): ConstraintToolSpec {
  const spec = CONSTRAINT_TOOL_SPECS.find((entry) => entry.kind === kind);
  if (!spec) {
    throw new Error(`Unknown constraint tool "${kind}".`);
  }
  return spec;
}

function sketchObjectData(
  document: ProjectDocument,
  sketch: SketchNode,
  objectId: string
): SketchObjectData | null {
  if (!sketch.objectIds.includes(objectId as EntityId)) {
    return null;
  }
  const node = document.nodes[objectId as EntityId];
  return node?.kind === 'sketch-object' ? node.data : null;
}

function samePick(a: ConstraintPick, b: ConstraintPick): boolean {
  if (a.kind !== b.kind || a.objectId !== b.objectId) {
    return false;
  }
  return a.kind === 'object' || a.point === (b as { point: string }).point;
}

export type BuildConstraintResult =
  | { data: SketchConstraintData }
  | { error: string };

/**
 * Validate one pick against the armed tool, before it is accepted into the
 * pending sequence. Returns the refusal to show, or null when the pick is
 * legal. Duplicate picks are refused here so a double-click cannot complete
 * a two-pick tool against a single entity.
 */
export function refusePick(
  document: ProjectDocument,
  sketch: SketchNode,
  kind: PendingConstraintKind,
  existing: readonly ConstraintPick[],
  pick: ConstraintPick
): string | null {
  const spec = constraintToolSpec(kind);
  if (pick.kind !== spec.pickKind) {
    return spec.pickKind === 'point'
      ? 'Pick a snap point (endpoint or center), not a whole object.'
      : 'Pick an object, not a point.';
  }
  if (existing.some((entry) => samePick(entry, pick))) {
    return 'That pick is already part of this constraint.';
  }
  const data = sketchObjectData(document, sketch, pick.objectId);
  if (!data) {
    return 'That object is not part of this sketch.';
  }
  switch (kind) {
    case 'horizontal':
    case 'vertical':
    case 'parallel':
      return data.objectKind === 'line'
        ? null
        : 'This constraint applies to lines.';
    case 'radius':
      return data.objectKind === 'circle' || data.objectKind === 'arc'
        ? null
        : 'A radius constraint applies to circles and arcs.';
    case 'coincident': {
      if (data.objectKind === 'line' || data.objectKind === 'arc') {
        return null;
      }
      if (data.objectKind === 'circle') {
        return pick.kind === 'point' && pick.point === 'center'
          ? null
          : 'A circle joins by its center.';
      }
      return 'Coincident applies to line and arc points and circle centers.';
    }
  }
}

/**
 * Turn a completed pick sequence into constraint data. Assumes each pick
 * already passed {@link refusePick}; re-validates the count and the one rule
 * that spans picks. A radius constraint pins the object's CURRENT radius
 * value verbatim — an expression stays an expression.
 */
export function buildConstraint(
  document: ProjectDocument,
  sketch: SketchNode,
  kind: PendingConstraintKind,
  picks: readonly ConstraintPick[]
): BuildConstraintResult {
  const spec = constraintToolSpec(kind);
  if (picks.length !== spec.picks) {
    return { error: `${spec.label} needs ${spec.picks} pick(s).` };
  }
  switch (kind) {
    case 'horizontal':
    case 'vertical': {
      const pick = picks[0]!;
      return {
        data: { constraintKind: kind, objectId: pick.objectId as EntityId }
      };
    }
    case 'parallel': {
      const a = picks[0]!;
      const b = picks[1]!;
      return {
        data: {
          constraintKind: 'parallel',
          a: a.objectId as EntityId,
          b: b.objectId as EntityId
        }
      };
    }
    case 'coincident': {
      const a = picks[0]!;
      const b = picks[1]!;
      if (a.kind !== 'point' || b.kind !== 'point') {
        return { error: 'Coincident needs two snap points.' };
      }
      const refA: SketchPointRef = {
        objectId: a.objectId as EntityId,
        point: a.point
      };
      const refB: SketchPointRef = {
        objectId: b.objectId as EntityId,
        point: b.point
      };
      return { data: { constraintKind: 'coincident', a: refA, b: refB } };
    }
    case 'radius': {
      const pick = picks[0]!;
      const data = sketchObjectData(document, sketch, pick.objectId);
      if (!data || (data.objectKind !== 'circle' && data.objectKind !== 'arc')) {
        return { error: 'A radius constraint applies to circles and arcs.' };
      }
      return {
        data: {
          constraintKind: 'radius',
          objectId: pick.objectId as EntityId,
          value: data.radius
        }
      };
    }
  }
}

/** Compact one-line description for the constraint list. */
export function describeConstraint(
  data: SketchConstraintData,
  nameOf: (objectId: EntityId) => string
): string {
  switch (data.constraintKind) {
    case 'horizontal':
    case 'vertical':
      return `${data.constraintKind === 'horizontal' ? 'Horizontal' : 'Vertical'} · ${nameOf(data.objectId)}`;
    case 'parallel':
      return `Parallel · ${nameOf(data.a)} ∥ ${nameOf(data.b)}`;
    case 'perpendicular':
      return `Perpendicular · ${nameOf(data.a)} ⊥ ${nameOf(data.b)}`;
    case 'equal':
      return `Equal · ${nameOf(data.a)} = ${nameOf(data.b)}`;
    case 'concentric':
      return `Concentric · ${nameOf(data.a)} ◎ ${nameOf(data.b)}`;
    case 'coincident':
      return `Coincident · ${nameOf(data.a.objectId)}.${data.a.point} = ${nameOf(data.b.objectId)}.${data.b.point}`;
    case 'midpoint':
      return `Midpoint · ${nameOf(data.point.objectId)}.${data.point.point} on ${nameOf(data.line)}`;
    case 'distance':
      return `Distance ${String(data.value)} · ${nameOf(data.a.objectId)}.${data.a.point} ↔ ${nameOf(data.b.objectId)}.${data.b.point}`;
    case 'radius':
      return `Radius ${String(data.value)} · ${nameOf(data.objectId)}`;
    case 'angle':
      return `Angle ${String(data.valueDeg)}° · ${nameOf(data.a)} ∠ ${nameOf(data.b)}`;
  }
}
