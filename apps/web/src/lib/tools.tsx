import type { ReactNode } from 'react';
import {
  ArrowUpFromLine,
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
  Orbit,
  PanelTopOpen,
  PenLine,
  Pyramid,
  Radius,
  RotateCw,
  Scaling,
  Scissors,
  Shapes,
  Slice,
  Spline,
  SquareStack,
  Tornado,
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

/**
 * The five groups of the feature tools, in workflow order: make something,
 * turn a sketch into a solid, finish its edges and faces, work on whole
 * bodies, repeat. Each group is a fold in the workspace column.
 */
export type ToolGroup =
  'create' | 'from-sketch' | 'edges-faces' | 'bodies' | 'pattern';

export interface ToolMeta {
  label: string;
  /**
   * The name on the tool's tile, where the group header already carries
   * the context: "Linear" under Pattern says what "Linear pattern" says in
   * the command search. Absent means the label is short enough as it is.
   */
  short?: string;
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

// Every tool has its own glyph: the tile shows a name beside it, but a
// folded group shows the icon alone, and two tools sharing one icon read as
// the same tool.
export const TOOL_META: Record<ToolId, ToolMeta> = {
  sketch: {
    label: 'Sketch',
    icon: icon(<PenLine size={16} aria-hidden="true" />),
    group: 'create',
    shortcut: 'S',
    hint: 'Draw a 2D profile on a plane'
  },
  box: {
    label: 'Box',
    icon: icon(<Box size={16} aria-hidden="true" />),
    group: 'create',
    shortcut: 'B',
    hint: 'Rectangular solid'
  },
  cylinder: {
    label: 'Cylinder',
    icon: icon(<Cylinder size={16} aria-hidden="true" />),
    group: 'create',
    shortcut: 'C',
    hint: 'Circular solid'
  },
  sphere: {
    label: 'Sphere',
    icon: icon(<Globe size={16} aria-hidden="true" />),
    group: 'create',
    hint: 'Ball solid'
  },
  cone: {
    label: 'Cone',
    icon: icon(<Cone size={16} aria-hidden="true" />),
    group: 'create',
    hint: 'Tapered solid'
  },
  torus: {
    label: 'Torus',
    icon: icon(<Torus size={16} aria-hidden="true" />),
    group: 'create',
    hint: 'Ring solid'
  },
  extrude: {
    label: 'Extrude',
    icon: icon(<ArrowUpFromLine size={16} aria-hidden="true" />),
    group: 'from-sketch',
    shortcut: 'E',
    hint: 'Push a sketch into a solid'
  },
  revolve: {
    label: 'Revolve',
    icon: icon(<RotateCw size={16} aria-hidden="true" />),
    group: 'from-sketch',
    shortcut: 'R',
    hint: 'Spin a sketch around an axis'
  },
  loft: {
    label: 'Loft',
    icon: icon(<Layers size={16} aria-hidden="true" />),
    group: 'from-sketch',
    hint: 'Blend through two or more closed sketch profiles'
  },
  sweep: {
    label: 'Sweep',
    icon: icon(<Spline size={16} aria-hidden="true" />),
    group: 'from-sketch',
    hint: 'Carry a closed profile along a sketch path'
  },
  'helical-sweep': {
    label: 'Helical sweep',
    short: 'Helical',
    icon: icon(<Tornado size={16} aria-hidden="true" />),
    group: 'from-sketch',
    hint: 'Carry a closed profile around a parametric helix'
  },
  fillet: {
    label: 'Fillet',
    icon: icon(<Radius size={16} aria-hidden="true" />),
    group: 'edges-faces',
    hint: 'Pick an edge, then set its radius'
  },
  chamfer: {
    label: 'Chamfer',
    icon: icon(<TriangleRight size={16} aria-hidden="true" />),
    group: 'edges-faces',
    hint: 'Pick an edge, then set its distance'
  },
  hole: {
    label: 'Hole',
    icon: icon(<Drill size={16} aria-hidden="true" />),
    group: 'edges-faces',
    hint: 'Drill a simple, counterbore, or countersink hole into a face'
  },
  shell: {
    label: 'Shell',
    icon: icon(<PanelTopOpen size={16} aria-hidden="true" />),
    group: 'edges-faces',
    hint: 'Open selected faces and add an inward wall thickness'
  },
  draft: {
    label: 'Draft',
    icon: icon(<Pyramid size={16} aria-hidden="true" />),
    group: 'edges-faces',
    hint: 'Taper selected faces along a pull direction'
  },
  thicken: {
    label: 'Thicken',
    icon: icon(<SquareStack size={16} aria-hidden="true" />),
    group: 'edges-faces',
    hint: 'Turn one exact face into a solid wall'
  },
  'solid-offset': {
    label: 'Solid offset',
    short: 'Offset',
    icon: icon(<Expand size={16} aria-hidden="true" />),
    group: 'edges-faces',
    hint: 'Offset every face outward with sharp joins'
  },
  transform: {
    label: 'Move',
    icon: icon(<Move3d size={16} aria-hidden="true" />),
    group: 'bodies',
    shortcut: 'M',
    hint: 'Translate or rotate a body'
  },
  scale: {
    label: 'Scale',
    icon: icon(<Scaling size={16} aria-hidden="true" />),
    group: 'bodies',
    hint: 'Uniformly resize a body about the origin'
  },
  mirror: {
    label: 'Mirror',
    icon: icon(<FlipHorizontal2 size={16} aria-hidden="true" />),
    group: 'bodies',
    hint: 'Create a separate reflected copy of a body'
  },
  split: {
    label: 'Split',
    icon: icon(<Slice size={16} aria-hidden="true" />),
    group: 'bodies',
    hint: 'Cut a body into two along a plane'
  },
  union: {
    label: 'Union',
    icon: icon(<Combine size={16} aria-hidden="true" />),
    group: 'bodies',
    shortcut: 'U',
    hint: 'Merge bodies into one'
  },
  subtract: {
    label: 'Subtract',
    icon: icon(<Scissors size={16} aria-hidden="true" />),
    group: 'bodies',
    shortcut: 'X',
    hint: 'Cut bodies out of a base body'
  },
  intersect: {
    label: 'Intersect',
    icon: icon(<Shapes size={16} aria-hidden="true" />),
    group: 'bodies',
    shortcut: 'I',
    hint: 'Keep only the overlap of bodies'
  },
  'linear-pattern': {
    label: 'Linear pattern',
    short: 'Linear',
    icon: icon(<CopyPlus size={16} aria-hidden="true" />),
    group: 'pattern',
    hint: 'Repeat a body along an axis'
  },
  'circular-pattern': {
    label: 'Circular pattern',
    short: 'Circular',
    icon: icon(<Orbit size={16} aria-hidden="true" />),
    group: 'pattern',
    hint: 'Repeat a body around an axis'
  },
  'grid-pattern': {
    label: 'Grid pattern',
    short: 'Grid',
    icon: icon(<Grid3x3 size={16} aria-hidden="true" />),
    group: 'pattern',
    hint: 'Repeat a body along two directions'
  }
};

export const TOOL_GROUPS: { id: ToolGroup; label: string; tools: ToolId[] }[] =
  [
    { id: 'create', label: 'Create', tools: ['sketch', ...PRIMITIVE_TOOLS] },
    {
      id: 'from-sketch',
      label: 'From sketch',
      tools: ['extrude', 'revolve', 'loft', 'sweep', 'helical-sweep']
    },
    {
      id: 'edges-faces',
      label: 'Edges & faces',
      tools: [
        'fillet',
        'chamfer',
        'hole',
        'shell',
        'draft',
        'thicken',
        'solid-offset'
      ]
    },
    {
      id: 'bodies',
      label: 'Bodies',
      tools: [
        'transform',
        'scale',
        'mirror',
        'split',
        'union',
        'subtract',
        'intersect'
      ]
    },
    {
      id: 'pattern',
      label: 'Pattern',
      tools: ['linear-pattern', 'circular-pattern', 'grid-pattern']
    }
  ];

/** Every group id, in the order the palette shows them. */
export const TOOL_GROUP_IDS: readonly ToolGroup[] = TOOL_GROUPS.map(
  (group) => group.id
);

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
