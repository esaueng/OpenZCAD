import type { ReactNode } from 'react';
import {
  Axis3d,
  Box,
  Camera,
  Combine,
  Cone,
  Cylinder,
  Download,
  Eye,
  Focus,
  Globe,
  Grid3x3,
  Keyboard,
  Layers,
  Maximize2,
  MousePointer2,
  Move3d,
  PenLine,
  Redo2,
  RotateCw,
  Save,
  Scissors,
  Search,
  Shapes,
  Square,
  Torus,
  Trash2,
  Undo2,
  Upload
} from 'lucide-react';

const ICONS: Record<string, (size: number) => ReactNode> = {
  Axis3d: (s) => <Axis3d size={s} aria-hidden="true" />,
  Box: (s) => <Box size={s} aria-hidden="true" />,
  Camera: (s) => <Camera size={s} aria-hidden="true" />,
  Combine: (s) => <Combine size={s} aria-hidden="true" />,
  Cone: (s) => <Cone size={s} aria-hidden="true" />,
  Cylinder: (s) => <Cylinder size={s} aria-hidden="true" />,
  Download: (s) => <Download size={s} aria-hidden="true" />,
  Eye: (s) => <Eye size={s} aria-hidden="true" />,
  Focus: (s) => <Focus size={s} aria-hidden="true" />,
  Globe: (s) => <Globe size={s} aria-hidden="true" />,
  Grid3x3: (s) => <Grid3x3 size={s} aria-hidden="true" />,
  Keyboard: (s) => <Keyboard size={s} aria-hidden="true" />,
  Layers: (s) => <Layers size={s} aria-hidden="true" />,
  Maximize2: (s) => <Maximize2 size={s} aria-hidden="true" />,
  MousePointer2: (s) => <MousePointer2 size={s} aria-hidden="true" />,
  Move3d: (s) => <Move3d size={s} aria-hidden="true" />,
  PenLine: (s) => <PenLine size={s} aria-hidden="true" />,
  Redo2: (s) => <Redo2 size={s} aria-hidden="true" />,
  RotateCw: (s) => <RotateCw size={s} aria-hidden="true" />,
  Save: (s) => <Save size={s} aria-hidden="true" />,
  Scissors: (s) => <Scissors size={s} aria-hidden="true" />,
  Search: (s) => <Search size={s} aria-hidden="true" />,
  Shapes: (s) => <Shapes size={s} aria-hidden="true" />,
  Square: (s) => <Square size={s} aria-hidden="true" />,
  Torus: (s) => <Torus size={s} aria-hidden="true" />,
  Trash2: (s) => <Trash2 size={s} aria-hidden="true" />,
  Undo2: (s) => <Undo2 size={s} aria-hidden="true" />,
  Upload: (s) => <Upload size={s} aria-hidden="true" />
};

/** Resolves a registry icon name to a rendered lucide icon. */
export function CommandIcon({ name, size = 14 }: { name: string; size?: number }) {
  const render = ICONS[name] ?? ICONS.Square!;
  return <>{render(size)}</>;
}
