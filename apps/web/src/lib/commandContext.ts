import { TOOL_GROUPS, type ToolId } from './tools';

/**
 * What the command card offers for the current selection.
 *
 * The card answers one question: what can I do with what I picked? Each
 * context lists the tools that act on that kind of pick, in the order they
 * are usually reached for, with at most one primary tool. Every other tool
 * stays one click away in the card's "All tools" grid, so a context never
 * hides a command; it only decides which ones get a named row.
 *
 * The face and edge verbs that act on the pick itself (Offset Face, Adjust
 * Radius, Edit Fillet…) are not tools and live in the floating tool card;
 * this list is tools only, so no command appears twice.
 */
export type CommandContextKind =
  'idle' | 'body' | 'bodies' | 'face' | 'edges' | 'region';

export interface CommandContextGroup {
  label: string;
  tools: readonly ToolId[];
}

export interface CommandContext {
  kind: CommandContextKind;
  /** The tool drawn as the context's primary verb, or none. */
  primary: ToolId | null;
  groups: readonly CommandContextGroup[];
}

export interface CommandSelection {
  edgeCount: number;
  faceSelected: boolean;
  bodyCount: number;
  regionCount: number;
}

const CONTEXTS: Record<CommandContextKind, Omit<CommandContext, 'kind'>> = {
  idle: {
    primary: 'sketch',
    groups: [
      {
        label: 'Start',
        tools: ['sketch', 'box', 'cylinder', 'sphere', 'cone', 'torus']
      }
    ]
  },
  body: {
    primary: 'transform',
    groups: [
      { label: 'Transform', tools: ['transform', 'scale', 'mirror'] },
      { label: 'Modify', tools: ['shell', 'split', 'solid-offset'] },
      {
        label: 'Pattern',
        tools: ['linear-pattern', 'circular-pattern', 'grid-pattern']
      }
    ]
  },
  bodies: {
    primary: 'union',
    groups: [
      { label: 'Combine', tools: ['union', 'subtract', 'intersect'] },
      { label: 'Transform', tools: ['transform', 'mirror'] }
    ]
  },
  face: {
    // The face's own verbs (Offset Face first) are in the tool card, which
    // already marks the preferred one; the card adds the feature tools that
    // start from a face.
    primary: null,
    groups: [{ label: 'From this face', tools: ['hole', 'draft', 'thicken'] }]
  },
  edges: {
    primary: 'fillet',
    groups: [{ label: 'Round off', tools: ['fillet', 'chamfer'] }]
  },
  region: {
    primary: 'extrude',
    groups: [
      {
        label: 'From sketch',
        tools: ['extrude', 'revolve', 'sweep', 'loft', 'helical-sweep']
      }
    ]
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
  return { kind, ...CONTEXTS[kind] };
}

/** Every tool the context did not give a row, in palette order. */
export function remainingTools(context: CommandContext): ToolId[] {
  const listed = new Set(context.groups.flatMap((group) => group.tools));
  return TOOL_GROUPS.flatMap((group) => group.tools).filter(
    (tool) => !listed.has(tool)
  );
}
