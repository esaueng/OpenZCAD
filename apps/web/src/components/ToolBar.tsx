import {
  TOOL_GROUPS,
  TOOL_META,
  toolDisabledReason,
  toolTitle,
  type ToolAvailability,
  type ToolId
} from '../lib/tools';
import { Tooltip } from './Tooltip';

interface ToolBarProps {
  activeTool: ToolId | null;
  availability: ToolAvailability;
  onLaunchTool(tool: ToolId): void;
}

/**
 * The feature tools in the workspace column: captioned groups of icon
 * buttons, six across, so all 28 sit above the browser. The tooltip carries
 * the name, shortcut and, for unavailable tools, the reason; the column's
 * header carries the command search.
 */
export function ToolBar({
  activeTool,
  availability,
  onLaunchTool
}: ToolBarProps) {
  return (
    <nav className="tool-palette" aria-label="Feature tools">
      {TOOL_GROUPS.map((group) => (
        <div
          key={group.id}
          role="group"
          aria-label={group.label}
          className="palette-group"
        >
          <div className="palette-group-label" aria-hidden="true">
            {group.label}
          </div>
          <div className="palette-grid">
            {group.tools.map((tool) => {
              const meta = TOOL_META[tool];
              const disabledReason = toolDisabledReason(tool, availability);
              const accessibleName = toolTitle(tool, availability);
              return (
                <Tooltip
                  key={tool}
                  label={meta.label}
                  shortcut={meta.shortcut}
                  description={disabledReason ?? meta.hint}
                >
                  <button
                    type="button"
                    className={`palette-item ${activeTool === tool ? 'active' : ''}`}
                    disabled={disabledReason !== null}
                    aria-label={accessibleName}
                    aria-pressed={activeTool === tool}
                    onClick={() => onLaunchTool(tool)}
                  >
                    {meta.icon}
                  </button>
                </Tooltip>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
