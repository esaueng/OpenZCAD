import type { ReactNode } from 'react';
import {
  Box,
  Combine,
  Cone,
  CopyPlus,
  Cylinder,
  Drill,
  Expand,
  FlipHorizontal2,
  Globe,
  Grid3x3,
  Layers,
  Move3d,
  PanelTopOpen,
  PenLine,
  RotateCw,
  Scaling,
  Scissors,
  Shapes,
  Slice,
  Spline,
  Torus,
  TriangleRight
} from 'lucide-react';

export type ToolId =
  | 'box'
  | 'cylinder'
  | 'sphere'
  | 'cone'
  | 'torus'
  | 'sketch'
  | 'extrude'
  | 'revolve'
  | 'loft'
  | 'sweep'
  | 'helical-sweep'
  | 'union'
  | 'subtract'
  | 'intersect'
  | 'transform'
  | 'scale'
  | 'mirror'
  | 'split'
  | 'shell'
  | 'solid-offset'
  | 'draft'
  | 'thicken'
  | 'hole'
  | 'fillet'
  | 'chamfer'
  | 'linear-pattern'
  | 'circular-pattern'
  | 'grid-pattern';

export type ToolGroup = 'solid' | 'sketch' | 'modify' | 'finish';

export interface ToolMeta {
  label: string;
  icon: ReactNode;
  group: ToolGroup;
  /** Single-key shortcut, if the tool has one. */
  shortcut?: string;
  /** One-line description for tooltips and the command palette. */
  hint: string;
}

export const PRIMITIVE_TOOLS: ToolId[] = [
  'box',
  'cylinder',
  'sphere',
  'cone',
  'torus'
];

const icon = (node: ReactNode) => node;

export const TOOL_META: Record<ToolId, ToolMeta> = {
  box: {
    label: 'Box',
    icon: icon(<Box size={16} aria-hidden="true" />),
    group: 'solid',
    shortcut: 'B',
    hint: 'Rectangular solid'
  },
  cylinder: {
    label: 'Cylinder',
    icon: icon(<Cylinder size={16} aria-hidden="true" />),
    group: 'solid',
    shortcut: 'C',
    hint: 'Circular solid'
  },
  sphere: {
    label: 'Sphere',
    icon: icon(<Globe size={16} aria-hidden="true" />),
    group: 'solid',
    hint: 'Ball solid'
  },
  cone: {
    label: 'Cone',
    icon: icon(<Cone size={16} aria-hidden="true" />),
    group: 'solid',
    hint: 'Tapered solid'
  },
  torus: {
    label: 'Torus',
    icon: icon(<Torus size={16} aria-hidden="true" />),
    group: 'solid',
    hint: 'Ring solid'
  },
  sketch: {
    label: 'Sketch',
    icon: icon(<PenLine size={16} aria-hidden="true" />),
    group: 'sketch',
    shortcut: 'S',
    hint: 'Draw a 2D profile on a plane'
  },
  extrude: {
    label: 'Extrude',
    icon: icon(<Layers size={16} aria-hidden="true" />),
    group: 'sketch',
    shortcut: 'E',
    hint: 'Push a sketch into a solid'
  },
  revolve: {
    label: 'Revolve',
    icon: icon(<RotateCw size={16} aria-hidden="true" />),
    group: 'sketch',
    shortcut: 'R',
    hint: 'Spin a sketch around an axis'
  },
  loft: {
    label: 'Loft',
    icon: icon(<Layers size={16} aria-hidden="true" />),
    group: 'sketch',
    hint: 'Blend through two or more closed sketch profiles'
  },
  sweep: {
    label: 'Sweep',
    icon: icon(<Spline size={16} aria-hidden="true" />),
    group: 'sketch',
    hint: 'Carry a closed profile along a sketch path'
  },
  'helical-sweep': {
    label: 'Helical sweep',
    icon: icon(<RotateCw size={16} aria-hidden="true" />),
    group: 'sketch',
    hint: 'Carry a closed profile around a parametric helix'
  },
  union: {
    label: 'Union',
    icon: icon(<Combine size={16} aria-hidden="true" />),
    group: 'modify',
    shortcut: 'U',
    hint: 'Merge bodies into one'
  },
  subtract: {
    label: 'Subtract',
    icon: icon(<Scissors size={16} aria-hidden="true" />),
    group: 'modify',
    shortcut: 'X',
    hint: 'Cut bodies out of a base body'
  },
  intersect: {
    label: 'Intersect',
    icon: icon(<Shapes size={16} aria-hidden="true" />),
    group: 'modify',
    shortcut: 'I',
    hint: 'Keep only the overlap of bodies'
  },
  transform: {
    label: 'Move',
    icon: icon(<Move3d size={16} aria-hidden="true" />),
    group: 'modify',
    shortcut: 'M',
    hint: 'Translate or rotate a body'
  },
  scale: {
    label: 'Scale',
    icon: icon(<Scaling size={16} aria-hidden="true" />),
    group: 'modify',
    hint: 'Uniformly resize a body about the origin'
  },
  mirror: {
    label: 'Mirror',
    icon: icon(<FlipHorizontal2 size={16} aria-hidden="true" />),
    group: 'modify',
    hint: 'Create a separate reflected copy of a body'
  },
  split: {
    label: 'Split',
    icon: icon(<Slice size={16} aria-hidden="true" />),
    group: 'modify',
    hint: 'Cut a body into two along a plane'
  },
  shell: {
    label: 'Shell',
    icon: icon(<PanelTopOpen size={16} aria-hidden="true" />),
    group: 'finish',
    hint: 'Open selected faces and add an inward wall thickness'
  },
  'solid-offset': {
    label: 'Solid offset',
    icon: icon(<Expand size={16} aria-hidden="true" />),
    group: 'finish',
    hint: 'Offset every face outward with sharp joins'
  },
  draft: {
    label: 'Draft',
    icon: icon(<TriangleRight size={16} aria-hidden="true" />),
    group: 'finish',
    hint: 'Taper selected faces along a pull direction'
  },
  thicken: {
    label: 'Thicken',
    icon: icon(<PanelTopOpen size={16} aria-hidden="true" />),
    group: 'finish',
    hint: 'Turn one exact face into a solid wall'
  },
  hole: {
    label: 'Hole',
    icon: icon(<Drill size={16} aria-hidden="true" />),
    group: 'finish',
    hint: 'Drill a simple, counterbore, or countersink hole into a face'
  },
  fillet: {
    label: 'Fillet',
    icon: icon(<Spline size={16} aria-hidden="true" />),
    group: 'finish',
    hint: 'Pick an edge, then set its radius'
  },
  chamfer: {
    label: 'Chamfer',
    icon: icon(<TriangleRight size={16} aria-hidden="true" />),
    group: 'finish',
    hint: 'Pick an edge, then set its distance'
  },
  'linear-pattern': {
    label: 'Linear pattern',
    icon: icon(<CopyPlus size={16} aria-hidden="true" />),
    group: 'finish',
    hint: 'Repeat a body along an axis'
  },
  'circular-pattern': {
    label: 'Circular pattern',
    icon: icon(<RotateCw size={16} aria-hidden="true" />),
    group: 'finish',
    hint: 'Repeat a body around an axis'
  },
  'grid-pattern': {
    label: 'Grid pattern',
    icon: icon(<Grid3x3 size={16} aria-hidden="true" />),
    group: 'finish',
    hint: 'Repeat a body along two directions'
  }
};

export const TOOL_GROUPS: { id: ToolGroup; label: string; tools: ToolId[] }[] =
  [
    { id: 'solid', label: 'Solids', tools: PRIMITIVE_TOOLS },
    {
      id: 'sketch',
      label: 'Sketch',
      tools: ['sketch', 'extrude', 'revolve', 'loft', 'sweep', 'helical-sweep']
    },
    {
      id: 'modify',
      label: 'Modify',
      tools: [
        'union',
        'subtract',
        'intersect',
        'transform',
        'scale',
        'mirror',
        'split'
      ]
    },
    {
      id: 'finish',
      label: 'Finish & repeat',
      tools: [
        'shell',
        'solid-offset',
        'draft',
        'thicken',
        'hole',
        'fillet',
        'chamfer',
        'linear-pattern',
        'circular-pattern',
        'grid-pattern'
      ]
    }
  ];

export interface ToolAvailability {
  /** Central collaboration/lease refusal applied to every mutating tool. */
  editDisabledReason?: string | null;
  sketchCount: number;
  liveBodyCount: number;
  /** Exact projection matches the visible project/version (not stale). */
  exactGeometryReady: boolean;
  /** An exact edge is picked in the viewport (enables fillet/chamfer). */
  hasEdgeSelected: boolean;
}

/** Why a tool cannot run right now, or null when it can. */
export function toolDisabledReason(
  tool: ToolId,
  avail: ToolAvailability
): string | null {
  if (avail.editDisabledReason) {
    return avail.editDisabledReason;
  }
  if ((tool === 'fillet' || tool === 'chamfer') && !avail.exactGeometryReady) {
    return 'Waiting for exact geometry';
  }
  if (
    (tool === 'mirror' ||
      tool === 'split' ||
      tool === 'shell' ||
      tool === 'solid-offset' ||
      tool === 'draft' ||
      tool === 'thicken' ||
      tool === 'hole') &&
    !avail.exactGeometryReady
  ) {
    return 'Waiting for exact geometry';
  }
  if ((tool === 'extrude' || tool === 'revolve') && avail.sketchCount === 0) {
    return 'Create a sketch first';
  }
  if (tool === 'loft' && avail.sketchCount < 2) {
    return 'Create at least two closed sketch profiles';
  }
  if (
    (tool === 'sweep' || tool === 'helical-sweep') &&
    avail.sketchCount === 0
  ) {
    return 'Create a closed sketch profile first';
  }
  if (
    (tool === 'union' || tool === 'subtract' || tool === 'intersect') &&
    avail.liveBodyCount < 2
  ) {
    return 'Needs at least two bodies';
  }
  if (
    tool === 'transform' &&
    avail.liveBodyCount < 1 &&
    avail.sketchCount < 1
  ) {
    return 'Needs a body or a sketch';
  }
  if (
    (tool === 'scale' ||
      tool === 'mirror' ||
      tool === 'split' ||
      tool === 'shell' ||
      tool === 'solid-offset' ||
      tool === 'draft' ||
      tool === 'thicken' ||
      tool === 'hole') &&
    avail.liveBodyCount < 1
  ) {
    return 'Needs a body';
  }
  if ((tool === 'fillet' || tool === 'chamfer') && avail.liveBodyCount < 1) {
    return 'Needs a body';
  }
  if (
    (tool === 'linear-pattern' ||
      tool === 'circular-pattern' ||
      tool === 'grid-pattern') &&
    avail.liveBodyCount < 1
  ) {
    return 'Needs a body';
  }
  return null;
}

/** Tooltip text: label, shortcut, and either the hint or the disabled reason. */
export function toolTitle(tool: ToolId, avail: ToolAvailability): string {
  const meta = TOOL_META[tool];
  const key = meta.shortcut ? ` (${meta.shortcut})` : '';
  const reason = toolDisabledReason(tool, avail);
  return `${meta.label}${key} — ${reason ?? meta.hint}`;
}

export const SHORTCUT_TO_TOOL: Record<string, ToolId> = Object.fromEntries(
  (Object.entries(TOOL_META) as [ToolId, ToolMeta][])
    .filter(([, meta]) => meta.shortcut)
    .map(([tool, meta]) => [meta.shortcut!.toLowerCase(), tool])
);
