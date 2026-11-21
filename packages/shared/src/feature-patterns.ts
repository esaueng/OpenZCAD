/**
 * M02 (schema v62) pattern rules shared by the document checks, the exact
 * build and the in-place pattern tools, so none of them accepts a copy label
 * or a repeated feature the others would refuse.
 */
import type {
  FeatureData,
  PatternKind,
  PatternPath,
  PatternPoints
} from './index';

/** Most copies a pattern, the original included, may make. */
export const MAX_PATTERN_INSTANCES = 100;

/**
 * The label a pattern gives its copy at `index`: the position along a
 * linear or circular pattern, `column-row` in a grid of `rows` rows. Index 0
 * is the original.
 */
export function patternInstanceLabel(
  kind: PatternKind,
  index: number,
  rows = 1
): string {
  if (kind !== 'grid') return String(index);
  return `${Math.floor(index / rows)}-${index % rows}`;
}

/**
 * The original's label, which no skip list may hold. A `points` pattern's is
 * its reference point's id, so it is the caller's to compare.
 */
export function patternOriginalLabel(kind: PatternKind): string {
  return kind === 'grid' ? '0-0' : '0';
}

/** A sketch entity id as a `points` or `path` pattern stores one. */
const POINT_ID = /^[A-Za-z0-9_-]{1,128}$/;

const LINEAR_LABEL = /^(0|[1-9]\d{0,2})$/;
const GRID_LABEL = /^(0|[1-9]\d{0,2})-(0|[1-9]\d{0,2})$/;

/**
 * Whether `label` is written as a copy of this kind of pattern names it,
 * leaving whether the counts reach it to the build (a count may be an
 * expression). The original is never a copy.
 */
export function isPatternCopyLabel(kind: PatternKind, label: unknown): boolean {
  if (typeof label !== 'string') return false;
  if (kind === 'points') return POINT_ID.test(label);
  if (!(kind === 'grid' ? GRID_LABEL : LINEAR_LABEL).test(label)) return false;
  return label !== patternOriginalLabel(kind);
}

/**
 * Why a skip list cannot be stored on this kind of pattern, else null: each
 * entry a copy's label, once.
 */
export function skippedInstancesProblem(
  kind: PatternKind,
  skipped: unknown
): string | null {
  if (skipped === undefined) return null;
  if (!Array.isArray(skipped) || skipped.length === 0) {
    return 'A pattern lists the copies it skips, or none.';
  }
  const seen = new Set<string>();
  for (const label of skipped) {
    // A points pattern's original is its reference point, checked with it.
    if (kind !== 'points' && label === patternOriginalLabel(kind)) {
      return 'A pattern cannot skip its original.';
    }
    if (!isPatternCopyLabel(kind, label)) {
      return `"${String(label)}" is not a copy of a ${kind} pattern.`;
    }
    if (seen.has(label as string)) {
      return `Copy ${String(label)} is skipped twice.`;
    }
    seen.add(label as string);
  }
  return null;
}

/**
 * Why a `points` pattern's arrangement cannot be stored, else null: it is
 * present exactly on a `points` pattern, names at least one point besides
 * its reference, each once, and skips only its own copies.
 */
export function patternPointsProblem(data: {
  patternKind: PatternKind;
  points?: PatternPoints | undefined;
  skippedInstances?: readonly string[] | undefined;
}): string | null {
  const points = data.points;
  if (data.patternKind !== 'points') {
    return points === undefined
      ? null
      : 'Only a pattern on sketch points names sketch points.';
  }
  if (!points || typeof points !== 'object') {
    return 'A pattern on sketch points needs its sketch and points.';
  }
  if (typeof points.sketchId !== 'string' || points.sketchId === '') {
    return 'A pattern on sketch points needs its sketch.';
  }
  const ids = points.pointIds;
  if (!Array.isArray(ids) || !ids.every((id) => POINT_ID.test(String(id)))) {
    return 'A pattern on sketch points lists its points by id.';
  }
  if (new Set(ids).size !== ids.length) {
    return 'A pattern on sketch points names each point once.';
  }
  if (!ids.includes(points.referencePointId)) {
    return "The point the original stands on must be one of the pattern's points.";
  }
  if (ids.length < 2) {
    return "A pattern on sketch points needs a point besides the original's.";
  }
  if (ids.length > MAX_PATTERN_INSTANCES) {
    return `A pattern may produce at most ${MAX_PATTERN_INSTANCES} copies.`;
  }
  for (const label of data.skippedInstances ?? []) {
    if (label === points.referencePointId) {
      return 'A pattern cannot skip its original.';
    }
    if (!ids.includes(label)) {
      return `Skipped point ${label} is not one of the pattern's points.`;
    }
  }
  return null;
}

/**
 * Why a `path` pattern's path cannot be stored, else null: it is present
 * exactly on a `path` pattern and names its sketch and at least one curve,
 * each once. Whether the curves are lines and arcs that join is the
 * sketch's to say, at the pattern's history position.
 */
export function patternPathProblem(data: {
  patternKind: PatternKind;
  path?: PatternPath | undefined;
}): string | null {
  const path = data.path;
  if (data.patternKind !== 'path') {
    return path === undefined
      ? null
      : 'Only a pattern along a path names a sketch path.';
  }
  if (!path || typeof path !== 'object') {
    return 'A pattern along a path needs its sketch and curves.';
  }
  if (typeof path.sketchId !== 'string' || path.sketchId === '') {
    return 'A pattern along a path needs its sketch.';
  }
  const ids = path.entityIds;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    !ids.every((id) => POINT_ID.test(String(id)))
  ) {
    return 'A pattern along a path lists its curves by id.';
  }
  if (new Set(ids).size !== ids.length) {
    return 'A pattern along a path names each curve once.';
  }
  if (path.reversed !== undefined && path.reversed !== true) {
    return 'A path is reversed or not; store true or leave it out.';
  }
  if (path.orientation !== undefined && path.orientation !== 'tangent') {
    return `"${String(path.orientation)}" is not a path pattern orientation.`;
  }
  return null;
}

/**
 * Whether a feature is one a feature pattern repeats: a hole, an extrude
 * that adds to or cuts its target body, (M02) a fillet or chamfer, which
 * each copy takes where it holds the edges the original rounded, or a wrap,
 * whose material each copy embosses or engraves where it lands.
 */
export function isPatternableFeature(data: FeatureData): boolean {
  if (
    data.featureKind === 'hole' ||
    data.featureKind === 'fillet' ||
    data.featureKind === 'chamfer' ||
    data.featureKind === 'wrap'
  )
    return true;
  return (
    data.featureKind === 'extrude' &&
    (data.operation === 'add' || data.operation === 'cut') &&
    data.targetBodyId !== undefined
  );
}

/** Why a feature cannot be repeated by a feature pattern, else null. */
export function patternSourceProblem(
  data: FeatureData,
  name: string
): string | null {
  if (data.featureKind === 'extrude' && data.endCondition === 'to-face') {
    return `${name} extrudes to a face, which a pattern cannot repeat yet; give it a distance or Through all.`;
  }
  // A copy's edge may run the other way, or meet its faces the other way
  // round, so a blend that differs end to end or face to face could land
  // reversed on it (review): only the even ones repeat.
  // Two distances are checked once resolved, where equal ones repeat.
  if (data.featureKind === 'chamfer' && data.angleDeg !== undefined) {
    return `${name} sets its faces back unevenly, and a copy's faces can meet its edge the other way round, so a pattern repeats only an equal-distance chamfer; chamfer the copies' edges directly.`;
  }
  if (
    data.featureKind === 'fillet' &&
    (data.endRadius !== undefined || data.radiusLaw !== undefined)
  ) {
    return `${name} changes its radius along the edge, and a copy's edge can run the other way, so a pattern repeats only a constant-radius fillet; fillet the copies' edges directly.`;
  }
  if (isPatternableFeature(data)) return null;
  return `${name} is not a hole, boss, cut, fillet, chamfer or wrap, so a feature pattern cannot repeat it.`;
}
