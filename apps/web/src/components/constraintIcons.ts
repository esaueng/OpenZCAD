import {
  BetweenHorizontalEnd,
  CircleDot,
  createLucideIcon,
  Equal,
  Lock,
  MoveHorizontal,
  MoveVertical,
  Radius,
  Ruler,
  SplinePointer,
  SquareSplitHorizontal,
  Tangent,
  TriangleRight,
  Unlink
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { SketchConstraintToolKind } from '../lib/interaction/machine';

// Lucide has no drafting marks, and its nearest picks were ambiguous (I44):
// Parallel shared Equal's glyph, Perpendicular drew an angle, and the dashed
// Concentric ring read as Coincident's circle-and-dot at 16px. These are the
// marks the canvas draws beside the geometry: ∥, ⊥ and ◎.
const Parallel = createLucideIcon('SketchParallel', [
  ['path', { d: 'M9 20 13 4', key: 'parallel-a' }],
  ['path', { d: 'M11 20 15 4', key: 'parallel-b' }]
]);
const Perpendicular = createLucideIcon('SketchPerpendicular', [
  ['path', { d: 'M4 20h16', key: 'perpendicular-base' }],
  ['path', { d: 'M12 20V4', key: 'perpendicular-upright' }]
]);
const Concentric = createLucideIcon('SketchConcentric', [
  ['circle', { cx: '12', cy: '12', r: '9', key: 'concentric-outer' }],
  ['circle', { cx: '12', cy: '12', r: '4.5', key: 'concentric-inner' }]
]);

/** The Arc tool's glyph: one arc between its two ends, not a polyline. */
export const ArcGlyph = createLucideIcon('SketchArc', [
  ['path', { d: 'M4 18a9 9 0 0 1 16 0', key: 'arc-curve' }],
  ['circle', { cx: '4', cy: '18', r: '1.5', key: 'arc-start' }],
  ['circle', { cx: '20', cy: '18', r: '1.5', key: 'arc-end' }]
]);

/** One glyph per constraint tool, shared by the rail and the entity editor. */
export const CONSTRAINT_ICONS: Record<SketchConstraintToolKind, LucideIcon> = {
  horizontal: MoveHorizontal,
  vertical: MoveVertical,
  parallel: Parallel,
  perpendicular: Perpendicular,
  equal: Equal,
  tangent: Tangent,
  concentric: Concentric,
  coincident: CircleDot,
  midpoint: BetweenHorizontalEnd,
  radius: Radius,
  distance: Ruler,
  angle: TriangleRight,
  symmetric: SquareSplitHorizontal,
  'point-on-object': SplinePointer,
  lock: Lock,
  disconnect: Unlink
};
