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
  resolve: (value: ParamValue) => number
): boolean {
  const resolved = resolve(current);
  // NaN never compares > epsilon, so an unresolvable current value must be
  // classified explicitly or a broken expression would read as "unmoved".
  return (
    !Number.isFinite(resolved) || Math.abs(resolved - solved) > APPLY_EPSILON
  );
}

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
  outcome: SketchSolveOutcome
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
      return resolveParamValue(value, scope, 'sketch value');
    } catch {
      // An expression that no longer resolves (deleted parameter, typo)
      // compares as NaN, which counts as moved — the solved number is the
      // honest replacement for a broken formula.
      return Number.NaN;
    }
  };
  const commands: AnyCommand[] = [];
  for (const solved of outcome.objects) {
    if (!sketch.objectIds.includes(solved.objectId)) {
      continue;
    }
    const node = document.nodes[solved.objectId];
    if (node?.kind !== 'sketch-object') {
      continue;
    }
    const data = node.data;
    let next: SketchObjectData | null = null;
    if (solved.kind === 'line' && data.objectKind === 'line') {
      if (
        movedField(data.x1, solved.x1, resolve) ||
        movedField(data.y1, solved.y1, resolve) ||
        movedField(data.x2, solved.x2, resolve) ||
        movedField(data.y2, solved.y2, resolve)
      ) {
        next = {
          ...data,
          x1: solved.x1,
          y1: solved.y1,
          x2: solved.x2,
          y2: solved.y2
        };
      }
    } else if (solved.kind === 'circle' && data.objectKind === 'circle') {
      if (
        movedField(data.centerX, solved.centerX, resolve) ||
        movedField(data.centerY, solved.centerY, resolve) ||
        movedField(data.radius, solved.radius, resolve)
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
        movedField(data.centerX, solved.centerX, resolve) ||
        movedField(data.centerY, solved.centerY, resolve) ||
        movedField(data.radius, solved.radius, resolve) ||
        movedField(data.startAngleDeg, solved.startAngleDeg, resolve) ||
        movedField(data.endAngleDeg, solved.endAngleDeg, resolve)
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
    }
    if (next) {
      commands.push(
        commandFactories.updateSketchObject(
          { sketchId, objectId: solved.objectId, data: next },
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
