import { Fragment } from 'react';
import { Search } from 'lucide-react';
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
  onOpenSearch(): void;
}

/**
 * Floating vertical tool palette over the viewport's left edge. Every tool
 * shows its icon, label, and single-key shortcut; groups are separated by
 * thin rules and unavailable tools stay visible with the reason in their
 * tooltip. Command search sits pinned at the top.
 */
export function ToolBar({
  activeTool,
  availability,
  onLaunchTool,
  onOpenSearch
}: ToolBarProps) {
  return (
    <nav className="tool-palette" aria-label="Feature tools">
      <button
        type="button"
        className="palette-item palette-search"
        title="Search commands (Ctrl+K)"
        onClick={onOpenSearch}
      >
        <Search size={15} aria-hidden="true" />
        <span className="palette-label">Search</span>
        <kbd>⌘K</kbd>
      </button>
      {TOOL_GROUPS.map((group) => (
        <Fragment key={group.id}>
          <div className="palette-sep" />
          <div role="group" aria-label={group.label} className="palette-group">
            {group.tools.map((tool) => {
              const meta = TOOL_META[tool];
              return (
                <button
                  key={tool}
                  type="button"
                  className={`palette-item ${activeTool === tool ? 'active' : ''}`}
                  disabled={toolDisabledReason(tool, availability) !== null}
                  title={toolTitle(tool, availability)}
                  aria-label={toolTitle(tool, availability)}
                  aria-pressed={activeTool === tool}
                  onClick={() => onLaunchTool(tool)}
                >
                  {meta.icon}
                  <span className="palette-label">{meta.label}</span>
                  {meta.shortcut && <kbd>{meta.shortcut}</kbd>}
                </button>
              );
            })}
          </div>
        </Fragment>
      ))}
    </nav>
  );
}
