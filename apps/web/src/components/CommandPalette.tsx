import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { useModalFocus } from '../lib/useModalFocus';

const LIST_ID = 'command-palette-list';
const optionId = (index: number) => `command-palette-option-${index}`;

export interface PaletteCommand {
  id: string;
  label: string;
  /** Group caption shown right-aligned (e.g. "Tool", "View", "File"). */
  group: string;
  /** Additional search terms reserved for command-specific aliases. */
  keywords?: string[];
  shortcut?: string;
  icon?: ReactNode;
  /** Non-null disables the row and explains why. */
  disabledReason?: string | null;
  run(): void;
}

interface CommandPaletteProps {
  commands: PaletteCommand[];
  onClose(): void;
}

function wordStartsWith(value: string, token: string): boolean {
  return value.split(/\s+/).some((word) => word.startsWith(token));
}

function tokenScore(command: PaletteCommand, token: string): number {
  const label = command.label.toLowerCase();
  if (label.startsWith(token)) {
    return 4;
  }
  if (wordStartsWith(label, token)) {
    return 3;
  }
  if (label.includes(token)) {
    return 2;
  }
  return wordStartsWith(command.group.toLowerCase(), token) ? 1 : 0;
}

function rankedCommands(
  commands: PaletteCommand[],
  query: string
): PaletteCommand[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return commands;
  }

  const ranked = commands.flatMap((command, sourceIndex) => {
    const scores = tokens.map((token) => tokenScore(command, token));
    return scores.every((score) => score > 0)
      ? [
          {
            command,
            hasLabelMatch: scores.some((score) => score > 1),
            score: scores.reduce((sum, score) => sum + score, 0),
            sourceIndex
          }
        ]
      : [];
  });
  const hasLabelMatch = ranked.some((entry) => entry.hasLabelMatch);

  return ranked
    .filter((entry) => !hasLabelMatch || entry.hasLabelMatch)
    .sort(
      (left, right) =>
        right.score - left.score || left.sourceIndex - right.sourceIndex
    )
    .map(({ command }) => command);
}

/**
 * Ctrl+K launcher over every workspace command. Type to filter, arrows to
 * move, Enter to run.
 */
export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // The hook moves focus after capturing the opener. React's `autoFocus`
  // happens before effects and would otherwise make the input restore itself
  // after it has already unmounted.
  useModalFocus(dialogRef, { autoFocus: true, initialFocusRef: searchRef });

  const visible = useMemo(
    () => rankedCommands(commands, query),
    [commands, query]
  );
  // View mode hands the palette no modeling commands, so the examples have to
  // follow — a hint naming tools the list does not contain reads as a bug.
  const examples = commands.some((command) => command.id.startsWith('tool-'))
    ? 'box, extrude, front view, export'
    : 'front view, fit, export';
  const clampedIndex = Math.min(activeIndex, Math.max(visible.length - 1, 0));

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    const row = listRef.current?.children[clampedIndex] as
      HTMLElement | undefined;
    row?.scrollIntoView({ block: 'nearest' });
  }, [clampedIndex]);

  function runCommand(command: PaletteCommand | undefined) {
    if (!command || command.disabledReason) {
      return;
    }
    onClose();
    command.run();
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        ref={dialogRef}
      >
        <div className="palette-input-row">
          <Search size={14} aria-hidden="true" />
          <input
            ref={searchRef}
            value={query}
            placeholder={`Type a command… (${examples})`}
            spellCheck={false}
            aria-label="Search commands"
            aria-controls={LIST_ID}
            aria-activedescendant={
              visible.length > 0 ? optionId(clampedIndex) : undefined
            }
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex((index) =>
                  Math.min(index + 1, visible.length - 1)
                );
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex((index) => Math.max(index - 1, 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                runCommand(visible[clampedIndex]);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
              }
            }}
          />
        </div>
        <div className="palette-list" id={LIST_ID} role="listbox" ref={listRef}>
          {visible.length === 0 && (
            <p className="palette-empty">No matching command.</p>
          )}
          {visible.map((command, index) => (
            <button
              key={command.id}
              type="button"
              id={optionId(index)}
              role="option"
              aria-selected={index === clampedIndex}
              aria-disabled={command.disabledReason ? true : undefined}
              // Focus stays in the input; the rows are described through
              // aria-activedescendant instead.
              tabIndex={-1}
              className={`palette-row ${index === clampedIndex ? 'active' : ''} ${
                command.disabledReason ? 'disabled' : ''
              }`}
              title={command.disabledReason ?? undefined}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => runCommand(command)}
            >
              <span className="palette-icon">{command.icon}</span>
              <span className="palette-label">{command.label}</span>
              {command.disabledReason ? (
                <small className="palette-reason">
                  {command.disabledReason}
                </small>
              ) : (
                <small className="palette-group">{command.group}</small>
              )}
              {command.shortcut && <kbd>{command.shortcut}</kbd>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
