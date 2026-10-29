import { Ellipsis } from 'lucide-react';
import { Fragment } from 'react';
import {
  ALL_TOOL_GROUPS,
  commandContextFor,
  FOLD_GROUPS,
  RAIL_GROUPS,
  remainingTools,
  toolApplies,
  type CommandSelection
} from '../lib/commandContext';
import type { SelectionCalloutContent } from '../lib/selectionCallout';
import type { LabelSegment } from '../lib/topologyLabels';
import {
  TOOL_META,
  toolDisabledReason,
  toolTitle,
  type ToolAvailability,
  type ToolId
} from '../lib/tools';
import { toolCommandId, useKeymap } from '../lib/keymap';
import { SelectionRail, selectionRailCollapsed } from './SelectionRail';
import { Tooltip } from './Tooltip';

interface CommandCardProps {
  selection: CommandSelection;
  /**
   * What is picked, in words. The rail does not draw it — the bar at the
   * foot of the stage names the pick — but the summary and the clear action
   * stay in the contract so the caller's wiring is unchanged.
   */
  summary: { label: readonly LabelSegment[]; detail?: string } | null;
  /** Clears the selection; absent while nothing is picked. */
  onClear?: (() => void) | undefined;
  /**
   * A pick with verbs of its own: the rail carries them in place of its
   * fixed tools ({@link SelectionRail}). Null while nothing is picked, or
   * while the pick is a History row's (its card names it).
   */
  pick?: SelectionCalloutContent | null;
  /** The pick, counted: "1 face", "8 edges". */
  pickSummary?: string;
  activeTool: ToolId | null;
  availability: ToolAvailability;
  onLaunchTool(tool: ToolId): void;
  /** The "More tools" fold, remembered per device in the panel state. */
  moreOpen: boolean;
  onToggleMore(): void;
}

/**
 * The verb rail: a thin icon column matching the instrument rail on the
 * right. With nothing picked its buttons are one fixed, ordered set of
 * primary verbs, so every tool keeps its place and the hand can learn it;
 * every other tool waits behind the "More tools" button at its foot, which
 * opens a flyout of named tiles under fixed group headings.
 *
 * A pick makes the rail its own: the fixed verbs give way to Deselect all
 * and the pick's verbs, the armed one lit, so what can be done with a face
 * is read where the tools always are rather than on a card of its own.
 * While a handle is dragged the rail keeps only the verb being made. More
 * tools stays at the foot throughout, so no command is ever out of reach.
 * Names and keys ride the tooltips.
 *
 * The fold is closed by default and ⌘K reaches every command by name
 * regardless. Opened, it stays open across picks and reloads, like the
 * drawer.
 */
export function CommandCard({
  selection,
  activeTool,
  availability,
  onLaunchTool,
  moreOpen,
  onToggleMore,
  pick = null,
  pickSummary = ''
}: CommandCardProps) {
  const context = commandContextFor(selection);
  const collapsed = pick !== null && selectionRailCollapsed(pick);
  // With the rail given to a pick, the fold carries every tool, the rail's
  // fixed ones included, so none is out of reach until the pick clears.
  const foldGroups = pick ? ALL_TOOL_GROUPS : FOLD_GROUPS;
  const restCount = pick
    ? foldGroups.reduce((count, group) => count + group.tools.length, 0)
    : remainingTools().length;
  const keymap = useKeymap();
  const button = (tool: ToolId, variant: 'rail' | 'tile') => {
    const meta = TOOL_META[tool];
    const shortcut = keymap.label(toolCommandId(tool));
    const disabledReason = toolDisabledReason(tool, availability);
    const active = activeTool === tool;
    // The primary verb hints at what to do next; once a tool is armed it
    // yields, so the armed tool is the only lit button.
    const primary =
      variant === 'rail' && activeTool === null && context.primary === tool;
    const applies = active || toolApplies(context, tool);
    return (
      <Tooltip
        key={tool}
        label={meta.label}
        shortcut={shortcut}
        description={disabledReason ?? meta.hint}
      >
        <button
          type="button"
          className={`command-${variant}${primary ? ' is-primary' : ''}${active ? ' active' : ''}${applies ? '' : ' is-dim'}`}
          disabled={disabledReason !== null}
          aria-label={toolTitle(tool, availability, shortcut ?? null)}
          aria-pressed={active}
          data-applies={applies ? 'true' : 'false'}
          onClick={() => onLaunchTool(tool)}
        >
          {meta.icon}
          {variant === 'tile' && <span>{meta.label}</span>}
        </button>
      </Tooltip>
    );
  };
  return (
    // A navigation landmark rather than a toolbar, so the tooltips are told
    // it is a rail: they open beside it instead of over the next tool.
    <nav
      className="tool-palette command-rail"
      aria-label="Feature tools"
      data-context={context.kind}
      data-tooltip-rail=""
    >
      {pick ? (
        <SelectionRail content={pick} summary={pickSummary} />
      ) : (
        RAIL_GROUPS.map((group, index) => (
          <Fragment key={group.label}>
            {index > 0 && (
              <span className="command-rail-divider" aria-hidden="true" />
            )}
            <section
              role="group"
              aria-label={group.label}
              className="command-rail-group"
            >
              {group.tools.map((tool) => button(tool, 'rail'))}
            </section>
          </Fragment>
        ))
      )}
      {!collapsed && (
        <span className="command-rail-divider" aria-hidden="true" />
      )}
      {!collapsed && (
        <section
          role="group"
          aria-label="All tools"
          className={`command-more${moreOpen ? ' open' : ''}`}
        >
          <Tooltip
            label={moreOpen ? 'Hide other tools' : 'More tools'}
            description={
              moreOpen
                ? 'Close the list of the other tools'
                : pick
                  ? `All ${restCount} tools, by name`
                  : `The ${restCount} other tools, by name`
            }
          >
            <button
              type="button"
              className={`command-rail command-more-toggle${moreOpen ? ' active' : ''}`}
              aria-expanded={moreOpen}
              aria-label={`More tools (${restCount})`}
              onClick={onToggleMore}
            >
              <Ellipsis size={16} aria-hidden="true" />
            </button>
          </Tooltip>
          {moreOpen && (
            // A flyout beside the rail: help for a rail button next to it
            // drops its description, and a tile's help opens beside the fold
            // rather than over the tiles below it.
            <div
              className="command-flyout"
              data-rail-flyout=""
              data-tooltip-rail="vertical"
            >
              {foldGroups.map((group) => (
                <Fragment key={group.label}>
                  <span className="command-flyout-heading">{group.label}</span>
                  {group.tools.map((tool) => button(tool, 'tile'))}
                </Fragment>
              ))}
            </div>
          )}
        </section>
      )}
    </nav>
  );
}
