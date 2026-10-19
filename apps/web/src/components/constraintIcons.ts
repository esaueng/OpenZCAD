import {
  Angle,
  BetweenHorizontalEnd,
  CircleDot,
  CircleDotDashed,
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

/** One glyph per constraint tool, shared by the rail and the entity editor. */
export const CONSTRAINT_ICONS: Record<SketchConstraintToolKind, LucideIcon> = {
  horizontal: MoveHorizontal,
  vertical: MoveVertical,
  parallel: Equal,
  perpendicular: Angle,
  equal: Equal,
  tangent: Tangent,
  concentric: CircleDotDashed,
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
