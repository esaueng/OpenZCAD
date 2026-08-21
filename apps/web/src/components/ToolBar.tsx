import { PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
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
  /** Collapsed to a single handle, so the viewport's left edge is usable. */
  open: boolean;
  onOpenChange(open: boolean): void;
}

/**
 * Floating tool palette over the viewport's left edge. Each group is a
 * captioned grid of icon buttons so all 28 tools fit above the fold; the
 * tooltip carries the name, shortcut, and — for unavailable tools, which
 * stay visible — the reason. Command search sits pinned at the top.
 */
export function ToolBar({
  activeTool,
  availability,
  onLaunchTool,
  onOpenSearch,
  open,
  onOpenChange
}: ToolBarProps) {
  if (!open) {
    return (
      <button
        type="button"
        className="palette-handle"
        title="Show tools"
        aria-label="Show tools"
        aria-expanded={false}
        onClick={() => onOpenChange(true)}
      >
        <PanelLeftOpen size={15} aria-hidden="true" />
      </button>
    );
  }
  return (
    <nav className="tool-palette" aria-label="Feature tools">
      <div className="palette-head">
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
        <button
          type="button"
          className="palette-collapse"
          title="Hide tools"
          aria-label="Hide tools"
          aria-expanded
          onClick={() => onOpenChange(false)}
        >
          <PanelLeftClose size={14} aria-hidden="true" />
        </button>
      </div>
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
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
