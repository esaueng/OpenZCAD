import { RAIL_TOOLS, type CommandContext } from './commandContext';
import { suggestedTools } from './toolRail';
import {
  TOOL_GROUPS,
  TOOL_META,
  toolDisabledReason,
  type ToolAvailability,
  type ToolId
} from './tools';

/**
 * The compact workspace's Build tray (U12 slice 4; plan in
 * `docs/plans/compact-mobile-workspace-plan-2026-11-26.md`): what its row
 * shows at rest, what a running tool's step chip says, and the All tools
 * sheet's sections. Pure, so the rules are testable without a DOM.
 */

/** How many suggested tools the tray shows at rest, beside All tools. */
export const TRAY_TOOL_LIMIT = 4;

/**
 * The one word a tool carries under its icon in the All tools grid. Most
 * tools already have one (`short`, else a one-word label); the two whose
 * names are two words get a word of their own here, so the regular tiles
 * keep theirs.
 */
const ONE_WORD: Partial<Record<ToolId, string>> = {
  'datum-csys': 'Frame',
  'gear-teeth': 'Teeth'
};

export function compactToolLabel(tool: ToolId): string {
  const meta = TOOL_META[tool];
  return ONE_WORD[tool] ?? meta.short ?? meta.label;
}

/**
 * The tools the tray suggests at rest: what the pick (or, with nothing
 * picked, the document) is ready for, the recently used first, as the verb
 * rail suggests them; topped up from the rail's fixed verbs that can run,
 * so the row is never empty while there is something to start.
 */
export function trayTools(
  context: CommandContext,
  availability: ToolAvailability,
  recent: readonly ToolId[] = [],
  limit: number = TRAY_TOOL_LIMIT
): ToolId[] {
  const tools = suggestedTools(context, availability, [], recent, limit);
  for (const tool of RAIL_TOOLS) {
    if (tools.length >= limit) break;
    if (tools.includes(tool)) continue;
    if (toolDisabledReason(tool, availability) !== null) continue;
    if (context.applies !== null && !context.applies.has(tool)) continue;
    tools.push(tool);
  }
  return tools;
}

export interface AllToolsSection {
  id: string;
  label: string;
  tools: readonly ToolId[];
}

/**
 * The All tools sheet's sections: the pinned or recent row first, then the
 * five groups in palette order. A search keeps the tools whose name, short
 * name, group or hint matches, and drops the leading row (its tools are in
 * their groups too) and every group left empty.
 */
export function allToolsSections(
  query: string,
  lead: { label: string; tools: readonly ToolId[] } | null
): AllToolsSection[] {
  const needle = query.trim().toLowerCase();
  const groups = TOOL_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    tools: group.tools.filter((tool) => {
      if (!needle) return true;
      const meta = TOOL_META[tool];
      return [
        meta.label,
        meta.short ?? '',
        compactToolLabel(tool),
        group.label,
        meta.hint
      ].some((text) => text.toLowerCase().includes(needle));
    })
  })).filter((group) => group.tools.length > 0);
  if (needle || !lead || lead.tools.length === 0) return groups;
  return [{ id: 'lead', label: lead.label, tools: lead.tools }, ...groups];
}

/**
 * The leading row of the All tools sheet: the recently launched tools, or
 * the pinned ones while nothing has been launched on this device.
 */
export function allToolsLead(
  recent: readonly ToolId[],
  pinned: readonly ToolId[]
): { label: string; tools: readonly ToolId[] } | null {
  if (recent.length > 0) return { label: 'Recent', tools: recent };
  if (pinned.length > 0) return { label: 'Pinned', tools: pinned };
  return null;
}

/** The longest step chip, in characters: one short line in the tray. */
const STEP_MAX_CHARS = 18;

const LEADING_VERBS = new Set([
  'pick',
  'click',
  'tap',
  'drag',
  'choose',
  'select',
  'draw',
  'type',
  'place',
  'set',
  'move',
  'open',
  'add',
  'turn'
]);

const FILLER = new Set(['the', 'a', 'an', 'where', 'goes', 'it', 'its']);

/** Where a hint's noun phrase ends: its next clause or instruction. */
const CLAUSE_BREAK =
  /\s*(?:[·:,;—(]|\s(?:to|or|and|then|first|either|instead|on|in|from|with)\b)/i;

/**
 * A running tool's state in one or two words, or null while its own step
 * is the thing to say: what the command bar's state pill says, shortened.
 */
export function trayState(state: {
  locked?: boolean;
  queued?: boolean;
  refused?: boolean;
  building?: boolean;
}): string | null {
  if (state.locked || state.queued) return 'Applying';
  if (state.refused) return 'Needs attention';
  if (state.building) return 'Checking';
  return null;
}

/**
 * A running tool's current step as a short chip ("Profile", "Axis",
 * "2 edges") from the hint the command bar shows in full: the noun phrase
 * after its leading verb, up to its next clause, without articles. The
 * full hint stays the bar's status for assistive technology.
 */
export function trayStep(hint: string): string {
  const text = hint.replace(/\s+/g, ' ').trim();
  if (text === '') return 'Pick';
  const words = text.split(' ');
  const first = words[0]!.toLowerCase();
  const rest = LEADING_VERBS.has(first) ? words.slice(1).join(' ') : text;
  const phrase = rest.split(CLAUSE_BREAK)[0] ?? rest;
  const kept = phrase
    .split(' ')
    .filter((word) => word !== '' && !FILLER.has(word.toLowerCase()))
    .slice(0, 2);
  if (kept.length === 0) {
    return LEADING_VERBS.has(first) ? capitalise(first) : 'Adjust';
  }
  let step = kept.join(' ');
  if (step.length > STEP_MAX_CHARS) step = kept[0]!;
  if (step.length > STEP_MAX_CHARS)
    step = `${step.slice(0, STEP_MAX_CHARS - 1)}…`;
  return capitalise(step);
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The spline being placed, as the compact status line says it (U12): how
 * many points are down and what a finger does next, or why a finish was
 * refused. A finger has no Enter: ✓ in the tray finishes the spline once it
 * can, and a tap on the first point closes it.
 */
export function compactSplineStatus(progress: {
  points: number;
  canFinish: boolean;
  refusal?: string;
}): string {
  if (progress.refusal) return `${progress.refusal}.`;
  const count = `${progress.points} ${progress.points === 1 ? 'point' : 'points'}`;
  return progress.canFinish
    ? `Spline · ${count} · ✓ finishes, the first point closes it`
    : `Spline · ${count} · tap the next point`;
}
