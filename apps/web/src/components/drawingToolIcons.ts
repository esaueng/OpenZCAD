import {
  Anchor,
  Angle,
  ChartPie,
  CircleDashed,
  Columns3,
  Crosshair,
  Diameter,
  Diff,
  DraftingCompass,
  ImageIcon,
  LocateFixed,
  MessageCircle,
  MoveDiagonal2,
  MoveHorizontal,
  MoveVertical,
  Radius,
  Ruler,
  SeparatorVertical,
  StickyNote,
  Table2,
  TableProperties,
  TriangleRight,
  type LucideIcon
} from 'lucide-react';
import type { AnnotationToolKind } from '../lib/drawing/annotationPicking';

/**
 * Each annotation tool's icon, shared by the drawing toolbar and Draw's
 * compact tool groups (U12 slice 9).
 */
export const ANNOTATION_TOOL_ICONS: Readonly<
  Record<AnnotationToolKind, LucideIcon>
> = {
  horizontal: MoveHorizontal,
  vertical: MoveVertical,
  aligned: MoveDiagonal2,
  distance: Ruler,
  radius: Radius,
  diameter: Diameter,
  angle: Angle,
  'arc-angle': ChartPie,
  'three-point-angle': DraftingCompass,
  chamfer: TriangleRight,
  note: StickyNote,
  'center-mark': Crosshair,
  'intersection-mark': LocateFixed,
  centerline: SeparatorVertical,
  'circle-centerline': CircleDashed,
  balloon: MessageCircle,
  'parts-list': TableProperties,
  'hole-table': Table2,
  image: ImageIcon,
  'datum-feature': Anchor,
  'feature-control-frame': Columns3,
  'general-tolerance': Diff
};
