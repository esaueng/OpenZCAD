import { useState } from 'react';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import {
  CATEGORY_LABELS,
  PALETTE_GROUPS,
  contextualCommands,
  getCommand,
  type CommandContext,
  type CommandSpec
} from '../lib/commands';
import { CommandIcon } from './icons';

interface ToolPaletteProps {
  ctx: CommandContext;
  /** Session kind → active command id mapping supplied by App. */
  activeCommandId: string | null;
  onRun(commandId: string): void;
}

const COLLAPSE_KEY = 'ozc.palette.collapsed';

function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

function ToolButton({
  command,
  ctx,
  active,
  onRun
}: {
  command: CommandSpec;
  ctx: CommandContext;
  active: boolean;
  onRun(commandId: string): void;
}) {
  const enabled = command.isEnabled(ctx);
  const reason = enabled ? null : command.disabledReason(ctx);
  return (
    <button
      type="button"
      className={`palette-tool ${active ? 'active' : ''}`}
      disabled={!enabled}
      title={reason ?? command.hint}
      aria-label={command.label}
      aria-pressed={active}
      onClick={() => onRun(command.id)}
    >
      <span className="palette-tool-icon">
        <CommandIcon name={command.icon} size={14} />
      </span>
      <span className="palette-tool-label">{command.label}</span>
      {command.shortcut && <kbd className="palette-kbd">{command.shortcut}</kbd>}
    </button>
  );
}

/**
 * Vertical, grouped tool palette. A contextual group at the top reprioritizes
 * commands for the current selection; the static groups below keep every
 * command reachable regardless of context.
 */
export function ToolPalette({ ctx, activeCommandId, onRun }: ToolPaletteProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const contextual = contextualCommands(ctx);

  function toggleGroup(category: string) {
    setCollapsed((current) => {
      const next = { ...current, [category]: !current[category] };
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        // localStorage unavailable (private mode); collapse state is per-session.
      }
      return next;
    });
  }

  return (
    <nav className="tool-palette" aria-label="Modeling tools">
      {contextual.length > 0 && (
        <section className="palette-group contextual">
          <h3 className="palette-group-title">
            <Sparkles size={11} aria-hidden="true" />
            For selection
          </h3>
          <div className="palette-group-body">
            {contextual.map((command) => (
              <ToolButton
                key={`ctx-${command.id}`}
                command={command}
                ctx={ctx}
                active={activeCommandId === command.id}
                onRun={onRun}
              />
            ))}
          </div>
        </section>
      )}
      {PALETTE_GROUPS.map((group) => {
        const isCollapsed = collapsed[group.category] ?? false;
        return (
          <section key={group.category} className="palette-group">
            <button
              type="button"
              className="palette-group-title"
              aria-expanded={!isCollapsed}
              onClick={() => toggleGroup(group.category)}
            >
              {isCollapsed ? (
                <ChevronRight size={11} aria-hidden="true" />
              ) : (
                <ChevronDown size={11} aria-hidden="true" />
              )}
              {CATEGORY_LABELS[group.category]}
            </button>
            {!isCollapsed && (
              <div className="palette-group-body">
                {group.commandIds.map((id) => {
                  const command = getCommand(id);
                  return command ? (
                    <ToolButton
                      key={id}
                      command={command}
                      ctx={ctx}
                      active={activeCommandId === id}
                      onRun={onRun}
                    />
                  ) : null;
                })}
              </div>
            )}
          </section>
        );
      })}
    </nav>
  );
}
