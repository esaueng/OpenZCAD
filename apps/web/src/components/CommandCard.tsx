import {
  Box,
  Boxes,
  ChevronRight,
  MousePointer2,
  Shapes,
  Slash,
  Square,
  X
} from 'lucide-react';
import type { ReactNode } from 'react';
import {
  commandContextFor,
  remainingTools,
  type CommandContextKind,
  type CommandSelection
} from '../lib/commandContext';
import type { LabelSegment } from '../lib/topologyLabels';
import { LabelSegments } from './LabelSegments';
import {
  TOOL_META,
  toolDisabledReason,
  toolTitle,
  type ToolAvailability,
  type ToolId
} from '../lib/tools';
import { Tooltip } from './Tooltip';

const CONTEXT_ICON: Record<CommandContextKind, ReactNode> = {
  idle: <MousePointer2 size={16} aria-hidden="true" />,
  body: <Box size={16} aria-hidden="true" />,
  bodies: <Boxes size={16} aria-hidden="true" />,
  face: <Square size={16} aria-hidden="true" />,
  edges: <Slash size={16} aria-hidden="true" />,
  region: <Shapes size={16} aria-hidden="true" />
};

interface CommandCardProps {
  selection: CommandSelection;
  /** What is picked, in words: the selection summary's own label. */
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
 * The one surface on the left that changes with the selection. Its header
 * names the pick; its rows are the tools that act on that kind of pick, with
 * the context's primary verb marked; every other tool waits behind the "More
 * tools" fold at the foot, by the same accessible name the palette's tiles
 * always had, so no command is ever out of reach and none appears twice.
 *
 * The fold is closed by default: the card is meant to show what fits the
 * pick and nothing else, and ⌘K reaches every command by name regardless.
 * Opened, it stays open across picks and reloads, like the drawer.
 */
export function CommandCard({
  selection,
  summary,
  onClear,
  activeTool,
  availability,
  onLaunchTool,
  moreOpen: showAll,
  onToggleMore
}: CommandCardProps) {
  const context = commandContextFor(selection);
  const rest = remainingTools(context);
  const button = (tool: ToolId, variant: 'row' | 'icon') => {
    const meta = TOOL_META[tool];
    const disabledReason = toolDisabledReason(tool, availability);
    const active = activeTool === tool;
    const primary = variant === 'row' && context.primary === tool;
    return (
      <Tooltip
        key={tool}
        label={meta.label}
        shortcut={meta.shortcut}
        description={disabledReason ?? meta.hint}
      >
        <button
          type="button"
          className={`command-${variant}${primary ? ' primary' : ''}${active ? ' active' : ''}`}
          disabled={disabledReason !== null}
          aria-label={toolTitle(tool, availability)}
          aria-pressed={active}
          onClick={() => onLaunchTool(tool)}
        >
          {meta.icon}
          {variant === 'row' && (
            <span className="command-row-label">{meta.label}</span>
          )}
          {variant === 'row' && meta.shortcut && (
            <kbd aria-hidden="true">{meta.shortcut}</kbd>
          )}
        </button>
      </Tooltip>
    );
  };
  const title: ReactNode = summary ? (
    <LabelSegments segments={summary.label} />
  ) : context.kind === 'region' ? (
    `${selection.regionCount} sketch ${selection.regionCount === 1 ? 'region' : 'regions'}`
  ) : (
    'Nothing selected'
  );
  const detail =
    summary?.detail ??
    (context.kind === 'idle' ? 'Pick a face, edge or body' : undefined);
  return (
    <nav
      className="tool-palette command-card"
      aria-label="Feature tools"
      data-context={context.kind}
    >
      <div className="command-card-head">
        <span className="command-card-icon">{CONTEXT_ICON[context.kind]}</span>
        <span className="command-card-title">
          <strong>{title}</strong>
          {detail && <small>{detail}</small>}
        </span>
        {onClear && (
          <button
            type="button"
            className="command-card-clear"
            aria-label="Clear selection (Esc)"
            title="Clear selection (Esc)"
            onClick={onClear}
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      {context.groups.map((group) => (
        <section
          key={`${context.kind}:${group.label}`}
          role="group"
          aria-label={group.label}
          className="command-group is-contextual"
        >
          <span className="command-group-label">{group.label}</span>
          {group.tools.map((tool) => button(tool, 'row'))}
        </section>
      ))}
      <section
        role="group"
        aria-label="All tools"
        className={`command-group command-more${showAll ? ' open' : ''}`}
      >
        <button
          type="button"
          className="command-more-toggle"
          aria-expanded={showAll}
          title={
            showAll
              ? 'Hide the tools that do not act on this selection'
              : `Show the ${rest.length} other tools`
          }
          onClick={onToggleMore}
        >
          <ChevronRight size={12} aria-hidden="true" />
          <span>{showAll ? 'All tools' : 'More tools'}</span>
          <small className="command-more-count">{rest.length}</small>
        </button>
        {showAll && (
          <div className="command-grid">
            {rest.map((tool) => button(tool, 'icon'))}
          </div>
        )}
      </section>
    </nav>
  );
}
