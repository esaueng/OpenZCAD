import { TOOL_GROUPS, type ToolId } from './tools';

/**
 * The verb rail's fixed composition, and which of its tools act on the
 * current pick.
 *
 * The rail never changes shape with the selection: its buttons and the
 * fold's tiles are one fixed, ordered set so a tool is always in the same
 * place and the hand can learn it. What the selection changes is emphasis
 * only — a tool that does not act on the current kind of pick is dimmed in
 * place (still clickable: launching it arms its own picking), and the
 * context's primary verb is lit.
 *
 * The face and edge verbs that act on the pick itself (Offset Face, Adjust
 * Radius, Edit Fillet…) are not tools; they live on the selection callout
 * and the tool card, so no command appears twice.
 */
export type CommandContextKind =
  'idle' | 'body' | 'bodies' | 'face' | 'edges' | 'region';

export interface CommandRailGroup {
  label: string;
  tools: readonly ToolId[];
}

/**
 * The rail's primary verbs, in a fixed order that follows the common flow:
 * sketch then extrude it, or drop a box or cylinder; finish edges and faces
 * with a fillet or a hole; move bodies and union them. Every other tool is
 * in the fold, in palette order.
 */
export const RAIL_GROUPS: readonly CommandRailGroup[] = [
  { label: 'Sketch', tools: ['sketch', 'extrude'] },
  { label: 'Create', tools: ['box', 'cylinder'] },
  { label: 'Finish', tools: ['fillet', 'hole'] },
  { label: 'Bodies', tools: ['transform', 'union'] }
];

export const RAIL_TOOLS: readonly ToolId[] = RAIL_GROUPS.flatMap(
  (group) => group.tools
);

/**
 * Every tool the rail does not carry, under the palette's own group
 * headings and in palette order. Fixed: the selection never re-sorts it.
 */
export const FOLD_GROUPS: readonly CommandRailGroup[] = TOOL_GROUPS.map(
  (group) => ({
    label: group.label,
    tools: group.tools.filter((tool) => !RAIL_TOOLS.includes(tool))
  })
).filter((group) => group.tools.length > 0);

export interface CommandContext {
  kind: CommandContextKind;
  /** The tool drawn as the context's primary verb, or none. */
  primary: ToolId | null;
  /**
   * The tools that act on this kind of pick; every other tool is dimmed in
   * place. `null` means nothing is picked, so nothing is dimmed: any tool
   * may start from an empty selection and pick its own input.
   */
  applies: ReadonlySet<ToolId> | null;
}

export interface CommandSelection {
  edgeCount: number;
  faceSelected: boolean;
  bodyCount: number;
  regionCount: number;
}

const CONTEXTS: Record<
  CommandContextKind,
  { primary: ToolId | null; applies: readonly ToolId[] | null }
> = {
  idle: { primary: 'sketch', applies: null },
  body: {
    primary: 'transform',
    applies: [
      'transform',
      'scale',
      'mirror',
      'shell',
      'split',
      'solid-offset',
      'linear-pattern',
      'circular-pattern',
      'grid-pattern'
    ]
  },
  bodies: {
    primary: 'union',
    applies: ['union', 'subtract', 'intersect', 'transform', 'mirror']
  },
  face: {
    // The face's own verbs (Offset Face first) are on the selection
    // callout, which already offers the preferred one; the rail lights no
    // second primary beside it.
    primary: null,
    applies: ['sketch', 'hole', 'draft', 'thicken', 'shell']
  },
  edges: { primary: 'fillet', applies: ['fillet', 'chamfer'] },
  region: {
    primary: 'extrude',
    applies: ['extrude', 'revolve', 'sweep', 'loft', 'helical-sweep']
  }
};

export function commandContextKind(
  selection: CommandSelection
): CommandContextKind {
  if (selection.edgeCount > 0) return 'edges';
  if (selection.faceSelected) return 'face';
  if (selection.regionCount > 0) return 'region';
  if (selection.bodyCount > 1) return 'bodies';
  if (selection.bodyCount === 1) return 'body';
  return 'idle';
}

export function commandContextFor(selection: CommandSelection): CommandContext {
  const kind = commandContextKind(selection);
  const { primary, applies } = CONTEXTS[kind];
  return { kind, primary, applies: applies ? new Set(applies) : null };
}

/** Whether a tool acts on the context's pick (drives dimming, not layout). */
export function toolApplies(context: CommandContext, tool: ToolId): boolean {
  return context.applies === null || context.applies.has(tool);
}

/** Every tool the rail does not carry, in the fold's fixed order. */
export function remainingTools(): ToolId[] {
  return FOLD_GROUPS.flatMap((group) => group.tools);
}
