/**
 * Turns a GCS solve outcome into the document commands that persist it. Pure
 * so tests can pin the gating and the merge semantics without a kernel; App
 * runs the returned commands through one `executeTransaction`, so N moved
 * objects are one undo step.
 */
import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import {
  findSketch,
  getParameterScope,
  resolveParamValue
} from '@openzcad/document-core';
// Type-only on purpose: a value import would pull the WASM-bearing module
// into the main bundle and fail the build's bundle-size check.
import type { SketchSolveOutcome } from '@openzcad/kernel-adapter/exact';
import { ownEntry } from '@openzcad/shared';
import type {
  ParamValue,
  ProjectDocument,
  SketchId,
  SketchObjectData
} from '@openzcad/shared';

/** Below this, a solved value is "where it already was" — skip the write. */
const APPLY_EPSILON = 1e-9;

/**
 * `updateSketchObject` replaces the object's data wholesale, so writing a
 * solved position turns any expression-driven field into a plain number.
 * Objects the solve did NOT move keep their data byte-for-byte — their
 * expressions survive — and only genuinely moved objects pay that price.
 */
function movedField(
  current: ParamValue,
  solved: number,
  resolve: (value: ParamValue) => number,
  tolerance = APPLY_EPSILON
): boolean {
  const resolved = resolve(current);
  // NaN never compares > epsilon, so an unresolvable current value must be
  // classified explicitly or a broken expression would read as "unmoved".
  return !Number.isFinite(resolved) || Math.abs(resolved - solved) > tolerance;
}

/**
 * An arc angle compared as a direction: the solver reads angles back in
 * atan2's range, so a stored 400° or a 350°→370° arc crossing 0° is the same
 * unmoved arc, and rewriting it would drop its expressions.
 */
function movedAngle(
  current: ParamValue,
  solved: number,
  resolve: (value: ParamValue) => number,
  tolerance = APPLY_EPSILON
): boolean {
  const resolved = resolve(current);
  if (!Number.isFinite(resolved)) return true;
  const turn = ((((resolved - solved) % 360) + 540) % 360) - 180;
  return Math.abs(turn) > tolerance;
}

export {
  movedField as sketchSolveValueMoved,
  movedAngle as sketchSolveAngleMoved
};

/**
 * Commands that write the solved geometry back, one `updateSketchObject`
 * per moved object, spreading over the existing data so `construction` and
 * unrelated fields survive. Empty when the solve did not converge or the
 * kernel rolled back — applying those would burn an undo step and a rebuild
 * to write the geometry that is already there.
 */
export function solvedSketchCommands(
  document: ProjectDocument,
  sketchId: SketchId,
  outcome: SketchSolveOutcome,
  tolerance = APPLY_EPSILON,
  /**
   * F06: marks each write as the parameter re-solve's, so history admits it
   * into a Tweak entry beside the value edit. Only `parameterResolve` sets it.
   */
  derivedFrom?: 'parameter-resolve'
): AnyCommand[] {
  if (!outcome.converged || outcome.rolledBack) {
    return [];
  }
  const sketch = findSketch(document, sketchId);
  if (!sketch) {
    return [];
  }
  const { scope } = getParameterScope(document);
  const resolve = (value: ParamValue) => {
    try {
      return resolveParamValue(value, scope, 'sketch value', document.units);
    } catch {
      // An expression that no longer resolves (deleted parameter, typo)
      // compares as NaN, which counts as moved — the solved number is the
      // honest replacement for a broken formula.
      return Number.NaN;
    }
  };
  const fieldMoved = (current: ParamValue, solved: number) =>
    movedField(current, solved, resolve, tolerance);
  const angleMoved = (current: ParamValue, solved: number) =>
    movedAngle(current, solved, resolve, tolerance);
  const commands: AnyCommand[] = [];
  for (const solved of outcome.objects) {
    if (!sketch.objectIds.includes(solved.objectId)) {
      continue;
    }
    const node = ownEntry(document.nodes, solved.objectId);
    if (node?.kind !== 'sketch-object') {
      continue;
    }
    const data = node.data;
    let next: SketchObjectData | null = null;
    if (solved.kind === 'line' && data.objectKind === 'line') {
      if (
        fieldMoved(data.x1, solved.x1) ||
        fieldMoved(data.y1, solved.y1) ||
        fieldMoved(data.x2, solved.x2) ||
        fieldMoved(data.y2, solved.y2)
      ) {
        next = {
          ...data,
          x1: solved.x1,
          y1: solved.y1,
          x2: solved.x2,
          y2: solved.y2
        };
      }
    } else if (solved.kind === 'point' && data.objectKind === 'point') {
      if (fieldMoved(data.x, solved.x) || fieldMoved(data.y, solved.y)) {
        next = { ...data, x: solved.x, y: solved.y };
      }
    } else if (solved.kind === 'circle' && data.objectKind === 'circle') {
      if (
        fieldMoved(data.centerX, solved.centerX) ||
        fieldMoved(data.centerY, solved.centerY) ||
        fieldMoved(data.radius, solved.radius)
      ) {
        next = {
          ...data,
          centerX: solved.centerX,
          centerY: solved.centerY,
          radius: solved.radius
        };
      }
    } else if (solved.kind === 'arc' && data.objectKind === 'arc') {
      if (
        fieldMoved(data.centerX, solved.centerX) ||
        fieldMoved(data.centerY, solved.centerY) ||
        fieldMoved(data.radius, solved.radius) ||
        angleMoved(data.startAngleDeg, solved.startAngleDeg) ||
        angleMoved(data.endAngleDeg, solved.endAngleDeg)
      ) {
        next = {
          ...data,
          centerX: solved.centerX,
          centerY: solved.centerY,
          radius: solved.radius,
          startAngleDeg: solved.startAngleDeg,
          endAngleDeg: solved.endAngleDeg
        };
      }
    } else if (solved.kind === 'ellipse' && data.objectKind === 'ellipse') {
      if (
        fieldMoved(data.centerX, solved.centerX) ||
        fieldMoved(data.centerY, solved.centerY) ||
        fieldMoved(data.radiusX, solved.radiusX) ||
        fieldMoved(data.radiusY, solved.radiusY) ||
        fieldMoved(data.rotationDeg, solved.rotationDeg)
      ) {
        // An elliptical arc keeps its parameter range: the solver held it
        // as its carrier ellipse.
        next = {
          ...data,
          centerX: solved.centerX,
          centerY: solved.centerY,
          radiusX: solved.radiusX,
          radiusY: solved.radiusY,
          rotationDeg: solved.rotationDeg
        };
      }
    } else if (solved.kind === 'spline' && data.objectKind === 'spline') {
      // Per point: a point the solve left alone keeps its expressions.
      let moved = false;
      const points = data.points.map((point, index) => {
        const at = solved.points[index];
        if (!at || (!fieldMoved(point.x, at.x) && !fieldMoved(point.y, at.y))) {
          return point;
        }
        moved = true;
        return { x: at.x, y: at.y };
      });
      if (moved) {
        next = { ...data, points };
      }
    }
    if (next) {
      commands.push(
        commandFactories.updateSketchObject(
          {
            sketchId,
            objectId: solved.objectId,
            data: next,
            ...(derivedFrom ? { derivedFrom } : {})
          },
          'Solve sketch'
        )
      );
    }
  }
  return commands;
}

/** The rail pill's text for one outcome. */
export function solveStatusLabel(outcome: SketchSolveOutcome): string {
  switch (outcome.classification) {
    case 'solved':
      return 'Fully constrained';
    case 'underConstrained':
      return `${outcome.dof.dof} DOF remaining`;
    case 'redundant':
      return 'Over-constrained';
    case 'unsatisfied':
      return 'Constraints conflict';
  }
}
