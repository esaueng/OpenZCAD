import { Ellipsis } from 'lucide-react';
import { Fragment } from 'react';
import {
  commandContextFor,
  remainingTools,
  type CommandSelection
} from '../lib/commandContext';
import type { LabelSegment } from '../lib/topologyLabels';
import {
  TOOL_META,
  toolDisabledReason,
  toolTitle,
  type ToolAvailability,
  type ToolId
} from '../lib/tools';
import { Tooltip } from './Tooltip';

interface CommandCardProps {
  selection: CommandSelection;
  /**
   * What is picked, in words. The rail does not draw it — the selection chip
   * in the bottom lane names the pick — but the summary and the clear action
   * stay in the contract so the caller's wiring is unchanged.
   */
  summary: { label: readonly LabelSegment[]; detail?: string } | null;
  /** Clears the selection; absent while nothing is picked. */
  onClear?: (() => void) | undefined;
  activeTool: ToolId | null;
  availability: ToolAvailability;
  onLaunchTool(tool: ToolId): void;
  /** The "More tools" fold, remembered per device in the panel state. */
  moreOpen: boolean;
  onToggleMore(): void;
}

/**
 * The verb rail: the one surface on the left that changes with the
 * selection, drawn as a thin icon column to match the instrument rail on
 * the right. Its buttons are the tools that act on the current kind of
 * pick, in the order they are usually reached for, the context's primary
 * verb lit; every other tool waits behind the "More tools" button at its
 * foot, which opens a flyout of named tiles beside the rail. Names and keys
 * ride the tooltips, and every button keeps the accessible name the
 * palette's tiles always had, so no command is out of reach and none
 * appears twice.
 *
 * The fold is closed by default: the rail is meant to show what fits the
 * pick and nothing else, and ⌘K reaches every command by name regardless.
 * Opened, it stays open across picks and reloads, like the drawer.
 */
export function CommandCard({
  selection,
  activeTool,
  availability,
  onLaunchTool,
  moreOpen,
  onToggleMore
}: CommandCardProps) {
  const context = commandContextFor(selection);
  const rest = remainingTools(context);
  const button = (tool: ToolId, variant: 'rail' | 'tile') => {
    const meta = TOOL_META[tool];
    const disabledReason = toolDisabledReason(tool, availability);
    const active = activeTool === tool;
    const primary = variant === 'rail' && context.primary === tool;
    return (
      <Tooltip
        key={tool}
        label={meta.label}
        shortcut={meta.shortcut}
        description={disabledReason ?? meta.hint}
      >
        <button
          type="button"
          className={`command-${variant}${primary ? ' is-primary' : ''}${active ? ' active' : ''}`}
          disabled={disabledReason !== null}
          aria-label={toolTitle(tool, availability)}
          aria-pressed={active}
          onClick={() => onLaunchTool(tool)}
        >
          {meta.icon}
          {variant === 'tile' && <span>{meta.label}</span>}
        </button>
      </Tooltip>
    );
  };
  return (
    <nav
      className="tool-palette command-rail"
      aria-label="Feature tools"
      data-context={context.kind}
    >
      {context.groups.map((group, index) => (
        <Fragment key={`${context.kind}:${group.label}`}>
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
      ))}
      <span className="command-rail-divider" aria-hidden="true" />
      <section
        role="group"
        aria-label="All tools"
        className={`command-more${moreOpen ? ' open' : ''}`}
      >
        <Tooltip
          label={moreOpen ? 'Hide other tools' : 'More tools'}
          description={
            moreOpen
              ? 'Close the list of tools that do not act on this selection'
              : `The ${rest.length} other tools, by name`
          }
        >
          <button
            type="button"
            className={`command-rail command-more-toggle${moreOpen ? ' active' : ''}`}
            aria-expanded={moreOpen}
            aria-label={`More tools (${rest.length})`}
            onClick={onToggleMore}
          >
            <Ellipsis size={16} aria-hidden="true" />
          </button>
        </Tooltip>
        {moreOpen && (
          <div className="command-flyout">
            {rest.map((tool) => button(tool, 'tile'))}
          </div>
        )}
      </section>
    </nav>
  );
}
