import type { ReactNode } from 'react';
import {
  Axis3d,
  Box,
  Cog,
  Cone,
  Cylinder,
  Drill,
  FlipHorizontal2,
  ImagePlus,
  Move3d,
  PenLine,
  Radius,
  Rotate3d,
  Scaling,
  SquaresIntersect,
  SquaresSubtract,
  SquaresUnite,
  Torus
} from 'lucide-react';
import {
  chamferGlyph,
  circularPatternGlyph,
  draftGlyph,
  extrudeGlyph,
  gearTeethGlyph,
  gridPatternGlyph,
  helicalSweepGlyph,
  linearPatternGlyph,
  loftGlyph,
  planeGlyph,
  revolveGlyph,
  shellGlyph,
  solidOffsetGlyph,
  sphereGlyph,
  splitGlyph,
  sweepGlyph,
  thickenGlyph,
  threadGlyph
} from './toolIcons';
import type { BodyRepresentation } from '@openzcad/shared';
import { platformShortcutLabel } from './platformShortcut';

export type ToolId =
  | 'box'
  | 'cylinder'
  | 'sphere'
  | 'cone'
  | 'torus'
  | 'sketch'
  | 'datum-plane'
  | 'datum-axis'
  | 'reference-image'
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
  | 'axis-rotate'
  | 'mirror'
  | 'split'
  | 'shell'
  | 'solid-offset'
  | 'draft'
  | 'thicken'
  | 'hole'
  | 'gear'
  | 'gear-teeth'
  | 'thread'
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
  /**
   * The tool's default key, if it has one. The user's keymap can replace it,
   * so surfaces read `useKeymap()` rather than this.
   */
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

// Every tool has its own glyph: the rail shows the icon alone, and two
// tools sharing one icon read as the same tool. Nor does a tool borrow
// another surface's glyph (the viewer's grid and section, a panel's layers,
// the app's settings, the sketch's spline): see ./toolIcons for the drawn
// ones.
export const TOOL_META: Record<ToolId, ToolMeta> = {
  sketch: {
    label: 'Sketch',
    icon: icon(<PenLine size={16} aria-hidden="true" />),
    group: 'create',
    shortcut: 'S',
    hint: 'Draw a 2D profile on a plane'
  },
  'datum-plane': {
    label: 'Plane',
    icon: planeGlyph,
    group: 'create',
    hint: 'A plane to sketch, split or mirror on'
  },
  'datum-axis': {
    label: 'Axis',
    icon: icon(<Axis3d size={16} aria-hidden="true" />),
    group: 'create',
    hint: 'Axis along an edge, cylinder or two points'
  },
  'reference-image': {
    label: 'Image',
    icon: icon(<ImagePlus size={16} aria-hidden="true" />),
    group: 'create',
    hint: 'A picture to trace over'
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
    icon: sphereGlyph,
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
    icon: extrudeGlyph,
    group: 'from-sketch',
    shortcut: 'E',
    hint: 'Push a sketch into a solid'
  },
  revolve: {
    label: 'Revolve',
    icon: revolveGlyph,
    group: 'from-sketch',
    shortcut: 'R',
    hint: 'Spin a sketch around an axis'
  },
  loft: {
    label: 'Loft',
    icon: loftGlyph,
    group: 'from-sketch',
    hint: 'Blend through two or more profiles'
  },
  sweep: {
    label: 'Sweep',
    icon: sweepGlyph,
    group: 'from-sketch',
    hint: 'Carry a profile along a path'
  },
  'helical-sweep': {
    label: 'Helical sweep',
    short: 'Helical',
    icon: helicalSweepGlyph,
    group: 'from-sketch',
    hint: 'Coil a profile around an axis'
  },
  fillet: {
    label: 'Fillet',
    icon: icon(<Radius size={16} aria-hidden="true" />),
    group: 'edges-faces',
    hint: 'Pick an edge, then set its radius'
  },
  chamfer: {
    label: 'Chamfer',
    icon: chamferGlyph,
    group: 'edges-faces',
    hint: 'Pick an edge, then set its distance'
  },
  hole: {
    label: 'Hole',
    icon: icon(<Drill size={16} aria-hidden="true" />),
    group: 'edges-faces',
    hint: 'Drill a hole into a flat face'
  },
  gear: {
    label: 'Gear',
    icon: icon(<Cog size={16} aria-hidden="true" />),
    group: 'create',
    hint: 'Add a gear, rack or worm'
  },
  'gear-teeth': {
    label: 'Gear teeth',
    icon: gearTeethGlyph,
    group: 'edges-faces',
    hint: 'Cut teeth on a boss or bore'
  },
  thread: {
    label: 'Thread',
    icon: threadGlyph,
    group: 'edges-faces',
    hint: 'Model a screw thread on a boss or in a bore, sized for printing'
  },
  shell: {
    label: 'Shell',
    icon: shellGlyph,
    group: 'edges-faces',
    hint: 'Hollow a body, opening faces'
  },
  draft: {
    label: 'Draft',
    icon: draftGlyph,
    group: 'edges-faces',
    hint: 'Taper faces along a pull direction'
  },
  thicken: {
    label: 'Thicken',
    icon: thickenGlyph,
    group: 'edges-faces',
    hint: 'Turn a face into a solid wall'
  },
  'solid-offset': {
    label: 'Solid offset',
    short: 'Offset',
    icon: solidOffsetGlyph,
    group: 'edges-faces',
    hint: 'Grow a whole body outward'
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
    hint: 'Resize a body uniformly'
  },
  'axis-rotate': {
    label: 'Rotate about axis',
    short: 'Rotate',
    icon: icon(<Rotate3d size={16} aria-hidden="true" />),
    group: 'bodies',
    hint: 'Turn a body about an axis'
  },
  mirror: {
    label: 'Mirror',
    icon: icon(<FlipHorizontal2 size={16} aria-hidden="true" />),
    group: 'bodies',
    hint: 'Reflect a copy of a body'
  },
  split: {
    label: 'Split',
    icon: splitGlyph,
    group: 'bodies',
    hint: 'Cut a body in two along a plane'
  },
  union: {
    label: 'Union',
    icon: icon(<SquaresUnite size={16} aria-hidden="true" />),
    group: 'bodies',
    shortcut: 'U',
    hint: 'Merge bodies into one'
  },
  subtract: {
    label: 'Subtract',
    icon: icon(<SquaresSubtract size={16} aria-hidden="true" />),
    group: 'bodies',
    shortcut: 'X',
    hint: 'Cut bodies out of a base body'
  },
  intersect: {
    label: 'Intersect',
    icon: icon(<SquaresIntersect size={16} aria-hidden="true" />),
    group: 'bodies',
    shortcut: 'I',
    hint: 'Keep only the overlap of bodies'
  },
  'linear-pattern': {
    label: 'Linear pattern',
    short: 'Linear',
    icon: linearPatternGlyph,
    group: 'pattern',
    hint: 'Repeat a body along an axis'
  },
  'circular-pattern': {
    label: 'Circular pattern',
    short: 'Circular',
    icon: circularPatternGlyph,
    group: 'pattern',
    hint: 'Repeat a body around an axis'
  },
  'grid-pattern': {
    label: 'Grid pattern',
    short: 'Grid',
    icon: gridPatternGlyph,
    group: 'pattern',
    hint: 'Repeat a body along two directions'
  }
};

export const TOOL_GROUPS: { id: ToolGroup; label: string; tools: ToolId[] }[] =
  [
    {
      id: 'create',
      label: 'Create',
      tools: [
        'sketch',
        'datum-plane',
        'datum-axis',
        'reference-image',
        ...PRIMITIVE_TOOLS,
        'gear'
      ]
    },
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
        'thread',
        'gear-teeth',
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
        'axis-rotate',
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
  /**
   * The workspace explains `editDisabledReason` in a notice of its own (the
   * live-session one, design review I10). Tools stay greyed, but their rows
   * keep their own descriptions instead of 35 copies of the reason.
   */
  editDisabledExplained?: boolean;
  sketchCount: number;
  /**
   * Sketches with at least one closed region. A sketch that is only an open
   * chain can be moved but not extruded, revolved, lofted or swept; leaving
   * those tiles lit on it hands the user a refusal instead of a hint.
   * Defaults to `sketchCount` for callers that have not analysed profiles.
   */
  closedProfileSketchCount?: number;
  /**
   * Bodies committed to the document. A preview in flight is not one of
   * them: a Fillet tile that lights up on a ghost body refuses the click.
   */
  liveBodyCount: number;
  /** Exact projection matches the visible project/version (not stale). */
  exactGeometryReady: boolean;
  /** An exact edge is picked in the viewport (enables fillet/chamfer). */
  hasEdgeSelected: boolean;
  /**
   * Whether a live body has a cylindrical face for Thread or Gear teeth to
   * pick: false only when every live body's faces are known and none is;
   * undefined while that is not known, which leaves the tools offered.
   */
  hasCylindricalFace?: boolean;
}

/**
 * Whether a live (not consumed, not hidden) body has a cylindrical face:
 * true as soon as one does, false only when every live body's faces are all
 * known and none is, undefined otherwise (topology not built yet).
 */
export function liveCylindricalFace(
  bodies: Readonly<
    Record<string, Pick<BodyRepresentation, 'bodyId' | 'consumed' | 'topology'>>
  > | null,
  hidden: ReadonlySet<string>
): boolean | undefined {
  if (!bodies) return undefined;
  let known = true;
  for (const body of Object.values(bodies)) {
    if (body.consumed || hidden.has(body.bodyId)) continue;
    const faces = body.topology?.faces;
    if (!faces) {
      known = false;
      continue;
    }
    for (const face of faces) {
      const surface = face.geometry?.surfaceType.toLowerCase();
      if (surface === 'cylinder') return true;
      if (surface === undefined) known = false;
    }
  }
  return known ? false : undefined;
}

/**
 * What a tool's row or tooltip says: why it cannot run, or its own hint
 * while the workspace explains a shared lock elsewhere.
 */
export function toolDescription(
  tool: ToolId,
  avail: ToolAvailability,
  hint: string
): string {
  const reason = toolDisabledReason(tool, avail);
  return reason === null ||
    (avail.editDisabledExplained && reason === avail.editDisabledReason)
    ? hint
    : reason;
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
      tool === 'hole' ||
      tool === 'thread' ||
      tool === 'gear-teeth') &&
    !avail.exactGeometryReady
  ) {
    return 'Waiting for exact geometry';
  }
  const closedProfiles = avail.closedProfileSketchCount ?? avail.sketchCount;
  if ((tool === 'extrude' || tool === 'revolve') && closedProfiles === 0) {
    return avail.sketchCount === 0
      ? 'Create a sketch first'
      : 'Close a sketch profile first';
  }
  if (tool === 'loft' && closedProfiles < 2) {
    return 'Create at least two closed sketch profiles';
  }
  if ((tool === 'sweep' || tool === 'helical-sweep') && closedProfiles === 0) {
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
      tool === 'axis-rotate' ||
      tool === 'mirror' ||
      tool === 'split' ||
      tool === 'shell' ||
      tool === 'solid-offset' ||
      tool === 'draft' ||
      tool === 'thicken' ||
      tool === 'hole' ||
      tool === 'thread' ||
      tool === 'gear-teeth') &&
    avail.liveBodyCount < 1
  ) {
    return 'Needs a body';
  }
  if ((tool === 'fillet' || tool === 'chamfer') && avail.liveBodyCount < 1) {
    return 'Needs a body';
  }
  // A box-only model offered both, and neither could succeed: each waits on
  // a pick that is not there to make.
  if (
    (tool === 'thread' || tool === 'gear-teeth') &&
    avail.hasCylindricalFace === false
  ) {
    return 'Needs a cylindrical face';
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

/**
 * Tooltip text: label, shortcut, and either the hint or the disabled reason.
 * The shortcut is the live keymap's (`useKeymap`), null when unbound; the
 * default stands in for callers with no keymap to hand.
 */
export function toolTitle(
  tool: ToolId,
  avail: ToolAvailability,
  shortcut: string | null = TOOL_META[tool].shortcut ?? null
): string {
  const meta = TOOL_META[tool];
  const key = shortcut ? ` (${platformShortcutLabel(shortcut)})` : '';
  const reason = toolDisabledReason(tool, avail);
  return `${meta.label}${key} — ${reason ?? meta.hint}`;
}
