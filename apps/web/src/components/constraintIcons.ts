import {
  Angle,
  BetweenHorizontalEnd,
  CircleDot,
  CircleDotDashed,
  Equal,
  MoveHorizontal,
  MoveVertical,
  Radius,
  Ruler,
  Tangent,
  TriangleRight
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
  angle: TriangleRight
};
