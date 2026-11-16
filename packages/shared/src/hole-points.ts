/**
 * M01 (schema v64): structural checks on a hole drilled at sketch points,
 * shared by document validation, the command layer and the exact build, so
 * none of them accepts a list the others would refuse.
 */
import type { HolePoints } from './index';

/** Most bores one hole feature may drill at sketch points. */
export const MAX_HOLE_POINTS = 100;

/** A point entity id as a hole stores one; it is part of its bores' names. */
const POINT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Why a hole's sketch points cannot be stored, else null: a sketch, and at
 * least one point of it, each named once.
 */
export function holePointsProblem(points: unknown): string | null {
  if (points === undefined) return null;
  if (!points || typeof points !== 'object' || Array.isArray(points)) {
    return 'A hole on sketch points needs its sketch and points.';
  }
  const { sketchId, pointIds } = points as Partial<HolePoints>;
  if (typeof sketchId !== 'string' || sketchId === '') {
    return 'A hole on sketch points needs its sketch.';
  }
  if (
    !Array.isArray(pointIds) ||
    !pointIds.every((id) => typeof id === 'string' && POINT_ID.test(id))
  ) {
    return 'A hole on sketch points lists its points by id.';
  }
  if (pointIds.length === 0) {
    return 'A hole on sketch points needs at least one point.';
  }
  if (new Set(pointIds).size !== pointIds.length) {
    return 'A hole on sketch points names each point once.';
  }
  if (pointIds.length > MAX_HOLE_POINTS) {
    return `A hole may be drilled at most at ${MAX_HOLE_POINTS} sketch points.`;
  }
  return null;
}
