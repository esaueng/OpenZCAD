/**
 * M02 (schema v62) pattern rules shared by the document checks, the exact
 * build and the in-place pattern tools, so none of them accepts a copy label
 * or a repeated feature the others would refuse.
 */
import type { FeatureData, PatternKind } from './index';

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

/** The original's label, which no skip list may hold. */
export function patternOriginalLabel(kind: PatternKind): string {
  return kind === 'grid' ? '0-0' : '0';
}

const LINEAR_LABEL = /^(0|[1-9]\d{0,2})$/;
const GRID_LABEL = /^(0|[1-9]\d{0,2})-(0|[1-9]\d{0,2})$/;

/**
 * Whether `label` is written as a copy of this kind of pattern names it,
 * leaving whether the counts reach it to the build (a count may be an
 * expression). The original is never a copy.
 */
export function isPatternCopyLabel(kind: PatternKind, label: unknown): boolean {
  if (typeof label !== 'string') return false;
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
    if (label === patternOriginalLabel(kind)) {
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
 * Whether a feature is one a feature pattern repeats: a hole, or an extrude
 * that adds to or cuts its target body.
 */
export function isPatternableFeature(data: FeatureData): boolean {
  if (data.featureKind === 'hole') return true;
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
  if (isPatternableFeature(data)) return null;
  return `${name} is not a hole, boss or cut, so a feature pattern cannot repeat it.`;
}
