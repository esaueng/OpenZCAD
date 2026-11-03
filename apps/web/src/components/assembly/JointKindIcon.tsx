import {
  Cylinder,
  Grid2x2,
  Lock,
  MoveVertical,
  Orbit,
  RotateCw,
  type LucideIcon
} from 'lucide-react';
import type { AssemblyJointKind } from '@openzcad/shared';

const ICONS: Readonly<Record<AssemblyJointKind, LucideIcon>> = {
  rigid: Lock,
  revolute: RotateCw,
  slider: MoveVertical,
  cylindrical: Cylinder,
  ball: Orbit,
  planar: Grid2x2
};

/** A joint type's glyph, the same in the panel, the Inspector and the tool. */
export function JointKindIcon({
  kind,
  size = 13
}: {
  kind: AssemblyJointKind;
  size?: number;
}) {
  const Icon = ICONS[kind];
  return <Icon className="assembly-row-icon" size={size} aria-hidden="true" />;
}
