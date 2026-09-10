import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  TOOL_GROUPS,
  TOOL_META,
  toolDisabledReason,
  toolTitle,
  type ToolAvailability,
  type ToolGroup,
  type ToolId
} from '../lib/tools';
import { Tooltip } from './Tooltip';

interface ToolBarProps {
  activeTool: ToolId | null;
  availability: ToolAvailability;
  /**
   * Which groups are unfolded. A folded group keeps every tool on one row
   * of icons, so folding trades names for height and never hides a tool.
   */
  openGroups: Record<ToolGroup, boolean>;
  onLaunchTool(tool: ToolId): void;
  onToggleGroup(group: ToolGroup): void;
}

/**
 * The feature tools in the workspace column: five groups in workflow order,
 * each a fold of named tiles — icon, name, shortcut — two across. Names on
 * the tiles rather than in tooltips, because twenty-eight bare glyphs were
 * not learnable; the fold keeps the column's height in the user's hands.
 * The accessible name stays the composed "Box (B) — …" string, which the
 * tooltip repeats, with the reason in place of the hint while a tool cannot
 * run.
 */
export function ToolBar({
  activeTool,
  availability,
  openGroups,
  onLaunchTool,
  onToggleGroup
}: ToolBarProps) {
  const tile = (tool: ToolId, compact: boolean) => {
    const meta = TOOL_META[tool];
    const disabledReason = toolDisabledReason(tool, availability);
    const active = activeTool === tool;
    return (
      <Tooltip
        key={tool}
        label={meta.label}
        shortcut={meta.shortcut}
        description={disabledReason ?? meta.hint}
      >
        <button
          type="button"
          className={`tool-tile${compact ? ' compact' : ''}${active ? ' active' : ''}`}
          disabled={disabledReason !== null}
          aria-label={toolTitle(tool, availability)}
          aria-pressed={active}
          onClick={() => onLaunchTool(tool)}
        >
          {meta.icon}
          {!compact && (
            <span className="tool-tile-label">{meta.short ?? meta.label}</span>
          )}
          {!compact && meta.shortcut && (
            <kbd aria-hidden="true">{meta.shortcut}</kbd>
          )}
        </button>
      </Tooltip>
    );
  };
  return (
    <nav className="tool-palette" aria-label="Feature tools">
      {TOOL_GROUPS.map((group) => {
        const open = openGroups[group.id];
        return (
          <section
            key={group.id}
            role="group"
            aria-label={group.label}
            className={`tool-group${open ? '' : ' folded'}`}
          >
            <div className="tool-group-head">
              <button
                type="button"
                className="tool-group-toggle"
                aria-expanded={open}
                onClick={() => onToggleGroup(group.id)}
              >
                {open ? (
                  <ChevronDown size={12} aria-hidden="true" />
                ) : (
                  <ChevronRight size={12} aria-hidden="true" />
                )}
                <span>{group.label}</span>
              </button>
              {!open && (
                <div className="tool-group-strip">
                  {group.tools.map((tool) => tile(tool, true))}
                </div>
              )}
            </div>
            {open && (
              <div className="tool-tiles">
                {group.tools.map((tool) => tile(tool, false))}
              </div>
            )}
          </section>
        );
      })}
    </nav>
  );
}
