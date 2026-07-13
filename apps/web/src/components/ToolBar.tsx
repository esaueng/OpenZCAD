import { Fragment } from 'react';
import {
  TOOL_GROUPS,
  TOOL_META,
  toolDisabledReason,
  toolTitle,
  type ToolAvailability,
  type ToolId
} from '../lib/tools';

interface ToolBarProps {
  activeTool: ToolId | null;
  availability: ToolAvailability;
  onLaunchTool(tool: ToolId): void;
}

/**
 * Horizontal ribbon of feature-creation tools, grouped like a conventional
 * CAD toolbar. Every button shows its keyboard shortcut in the tooltip.
 */
export function ToolBar({ activeTool, availability, onLaunchTool }: ToolBarProps) {
  return (
    <nav className="toolbar" aria-label="Feature tools">
      {TOOL_GROUPS.map((group, index) => (
        <Fragment key={group.id}>
          {index > 0 && <div className="toolbar-sep" />}
          <div className="toolbar-group" role="group" aria-label={group.label}>
            {group.tools.map((tool) => {
              const meta = TOOL_META[tool];
              return (
                <button
                  key={tool}
                  type="button"
                  className={`toolbar-button ${activeTool === tool ? 'active' : ''}`}
                  disabled={toolDisabledReason(tool, availability) !== null}
                  title={toolTitle(tool, availability)}
                  aria-pressed={activeTool === tool}
                  onClick={() => onLaunchTool(tool)}
                >
                  {meta.icon}
                  <span>{meta.label}</span>
                </button>
              );
            })}
          </div>
        </Fragment>
      ))}
    </nav>
  );
}
