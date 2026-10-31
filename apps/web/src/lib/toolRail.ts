import { RAIL_TOOLS, toolApplies, type CommandContext } from './commandContext';
import {
  TOOL_GROUPS,
  TOOL_META,
  toolDisabledReason,
  type ToolAvailability,
  type ToolId
} from './tools';

/**
 * The verb rail as the user arranges it: the tools they pinned, in their
 * order, then a few suggestions for what they are doing now.
 *
 * Pins are the hand's: they never move or vanish with the selection, so a
 * learned position stays learned. A pinned tool that does not act on the
 * pick is dimmed in place, as before. Suggestions are the rail's: they sit
 * under the pins, change with the pick and the document, and are dragged
 * up into the pins to keep.
 */

/** The rail a new device starts with: the fixed verbs it always had. */
export const DEFAULT_PINNED_TOOLS: readonly ToolId[] = RAIL_TOOLS;

/** How many launched tools are remembered to rank suggestions by. */
export const MAX_RECENT_TOOLS = 6;

/** How many suggestions the rail carries under the pins. */
export const MAX_SUGGESTED_TOOLS = 3;

/**
 * Which tools the "More tools" drawer lists. `fits` keeps what can run now
 * and acts on the pick; `all` lists every tool, the rest greyed or dimmed.
 */
export type ToolDrawerFilter = 'fits' | 'all';

/**
 * How the drawer opens: `simple` is a short list of the tools that fit now,
 * icon and name; `advanced` adds the search, the fits/all switch, shortcuts
 * and the pins, as a sheet the stage's height.
 */
export type ToolDrawerView = 'simple' | 'advanced';

/** The MIME type a dragged tool carries between the drawer and the rail. */
export const TOOL_DRAG_TYPE = 'application/x-openzcad-tool';

export function isToolId(value: unknown): value is ToolId {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(TOOL_META, value)
  );
}

/**
 * A stored tool list, cleaned: known ids only, each once, in stored order.
 * Anything that is not a list at all reads as absent (null).
 */
export function normalizeToolList(value: unknown): ToolId[] | null {
  if (!Array.isArray(value)) return null;
  const tools: ToolId[] = [];
  for (const entry of value) {
    if (isToolId(entry) && !tools.includes(entry)) tools.push(entry);
  }
  return tools;
}

/**
 * Pins `tool` at `index` (the end when omitted). A tool already pinned moves
 * there instead; the index counts positions in the list without it.
 */
export function pinTool(
  pins: readonly ToolId[],
  tool: ToolId,
  index: number = pins.length
): ToolId[] {
  const rest = pins.filter((pinned) => pinned !== tool);
  const at = Math.max(0, Math.min(index, rest.length));
  return [...rest.slice(0, at), tool, ...rest.slice(at)];
}

export function unpinTool(pins: readonly ToolId[], tool: ToolId): ToolId[] {
  return pins.filter((pinned) => pinned !== tool);
}

/** Moves a pinned tool one place up (-1) or down (+1); unchanged at an end. */
export function shiftPinnedTool(
  pins: readonly ToolId[],
  tool: ToolId,
  delta: -1 | 1
): ToolId[] {
  const from = pins.indexOf(tool);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= pins.length) return [...pins];
  return pinTool(pins, tool, to);
}

/** Puts a launched tool at the head of the recent list. */
export function recordRecentTool(
  recent: readonly ToolId[],
  tool: ToolId
): ToolId[] {
  return [tool, ...recent.filter((entry) => entry !== tool)].slice(
    0,
    MAX_RECENT_TOOLS
  );
}

/**
 * The rail's section a tool sits in, which names its group and draws the
 * dividers: Sketch (a sketch and what is made from one), Create, Finish
 * (edges and faces), Bodies (and their patterns). The default pins fall in
 * the rail's four original groups this way.
 */
export function railSection(tool: ToolId): string {
  if (tool === 'sketch') return 'Sketch';
  switch (TOOL_META[tool].group) {
    case 'from-sketch':
      return 'Sketch';
    case 'create':
      return 'Create';
    case 'edges-faces':
      return 'Finish';
    case 'bodies':
    case 'pattern':
      return 'Bodies';
  }
}

export interface RailSection {
  label: string;
  tools: ToolId[];
}

/** The pins in order, split where the section changes. */
export function railSections(pins: readonly ToolId[]): RailSection[] {
  const sections: RailSection[] = [];
  for (const tool of pins) {
    const label = railSection(tool);
    const last = sections.at(-1);
    if (last && last.label === label) last.tools.push(tool);
    else sections.push({ label, tools: [tool] });
  }
  return sections;
}

/** Whether a tool can run now and acts on the pick: what `fits` keeps. */
export function toolFits(
  context: CommandContext,
  availability: ToolAvailability,
  tool: ToolId
): boolean {
  return (
    toolDisabledReason(tool, availability) === null &&
    toolApplies(context, tool)
  );
}

/**
 * What the document is ready for with nothing picked, most telling first: a
 * closed profile wants a solid made from it, two bodies a boolean, one body
 * its edges finished, and an empty document something to start from.
 */
function idleCandidates(availability: ToolAvailability): ToolId[] {
  const closed =
    availability.closedProfileSketchCount ?? availability.sketchCount;
  const bodies = availability.liveBodyCount;
  const tools: ToolId[] = [];
  if (closed > 0) tools.push('extrude', 'revolve');
  if (bodies >= 2) tools.push('union', 'subtract');
  if (bodies >= 1) tools.push('fillet', 'hole', 'chamfer', 'shell');
  if (bodies === 0 && availability.sketchCount === 0) {
    tools.push('sketch', 'box', 'cylinder', 'sphere');
  }
  return tools;
}

/**
 * The tools the rail suggests under the pins: ones that can run now and act
 * on the pick, that are not pinned already, the recently used first.
 * With nothing picked they follow what the document is ready for; with a
 * pick, the pick's own tools in their usual order.
 */
export function suggestedTools(
  context: CommandContext,
  availability: ToolAvailability,
  pins: readonly ToolId[],
  recent: readonly ToolId[] = [],
  limit: number = MAX_SUGGESTED_TOOLS
): ToolId[] {
  const base =
    context.applies === null
      ? idleCandidates(availability)
      : [...(context.primary ? [context.primary] : []), ...context.applies];
  // The recent tools lead only where they fit what is picked; with nothing
  // picked any of them may, the way the hand last reached for it.
  const ranked = [
    ...recent.filter((tool) => context.applies === null || base.includes(tool)),
    ...base
  ];
  const out: ToolId[] = [];
  for (const tool of ranked) {
    if (out.length >= limit) break;
    if (out.includes(tool) || pins.includes(tool)) continue;
    if (!toolFits(context, availability, tool)) continue;
    out.push(tool);
  }
  return out;
}

export interface DrawerGroup {
  label: string;
  tools: ToolId[];
}

/**
 * The drawer's groups for a filter and a search: every tool by default, in
 * palette order under the palette's headings; `fits` keeps the ones that can
 * run now on the pick; a query matches label, group and hint, and lists
 * matches whatever the filter says. The armed tool is always listed, so its
 * lit row says what is running. Empty groups drop out.
 */
export function drawerGroups(
  context: CommandContext,
  availability: ToolAvailability,
  filter: ToolDrawerFilter,
  query = '',
  armed: ToolId | null = null
): DrawerGroup[] {
  const needle = query.trim().toLowerCase();
  return TOOL_GROUPS.map((group) => ({
    label: group.label,
    tools: group.tools.filter((tool) => {
      if (needle) {
        const meta = TOOL_META[tool];
        return [meta.label, meta.short ?? '', group.label, meta.hint].some(
          (text) => text.toLowerCase().includes(needle)
        );
      }
      return (
        filter === 'all' ||
        tool === armed ||
        toolFits(context, availability, tool)
      );
    })
  })).filter((group) => group.tools.length > 0);
}
