import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  platformShortcutLabel,
  type PlatformShortcutCopy
} from '../lib/platformShortcut';
import { MessageSquare, Search } from 'lucide-react';

const LIST_ID = 'command-palette-list';
const ASK_HINT_ID = 'command-bar-ask-hint';
const optionId = (index: number) => `command-palette-option-${index}`;

export interface PaletteCommand {
  id: string;
  label: string;
  /** Group caption shown right-aligned (e.g. "Tool", "View", "File"). */
  group: string;
  /** Aliases a search matches as strongly as a word inside the label. */
  keywords?: string[];
  shortcut?: string;
  icon?: ReactNode;
  /** Non-null disables the row and explains why. */
  disabledReason?: string | null;
  run(): void;
}

interface CommandBarProps {
  commands: PaletteCommand[];
  /**
   * The bar has focus and its list is up. The host owns it so ⌘K, "/" and
   * Settings can open or close the bar; a click or focus opens it too.
   */
  open: boolean;
  onOpenChange(open: boolean): void;
  /**
   * Sends the typed text to the assistant. Present, the list ends with an
   * Ask row for whatever is typed and Tab turns the whole bar into a
   * question, so search and asking are one entry point.
   */
  onAsk?(question: string): void;
  /** The platform's shortcut for the bar: ⌘K or Ctrl+K. */
  searchKey: PlatformShortcutCopy;
  /**
   * The slot inside the bar, before the shortcut, that the assistant renders
   * its Ask launcher into while the conversation is closed.
   */
  onAssistantSlot?(slot: HTMLElement | null): void;
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
  // Declared on commands long before anything read them: "laser" never
  // found the DXF outline export its keywords name.
  if (
    command.keywords?.some((keyword) => keyword.toLowerCase().startsWith(token))
  ) {
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
 * The search field at the foot of the stage. It is the command palette
 * itself: focusing it (a click, ⌘K or "/") lists every workspace command
 * above the bar, anchored to it rather than over the model in a modal.
 * Type to filter, arrows to move, Enter to run; Tab turns the bar into a
 * question for the assistant, and Escape hands focus back.
 */
export function CommandBar({
  commands,
  open,
  onOpenChange,
  onAsk,
  searchKey,
  onAssistantSlot
}: CommandBarProps) {
  const [query, setQuery] = useState('');
  const [asking, setAsking] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Where focus was before the bar took it, for Escape and for a command
  // that has run: the canvas keeps its keys instead of landing on <body>.
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const askMode = asking && onAsk !== undefined;
  // The host rebuilds the command list every render; only rank it while
  // the list is up.
  const matches = useMemo(
    () => (open ? rankedCommands(commands, query) : []),
    [commands, open, query]
  );
  const question = query.trim();
  const visible = useMemo<PaletteCommand[]>(
    () =>
      onAsk && question
        ? [
            ...matches,
            {
              id: 'ask-assistant',
              label: `Ask the assistant: “${question}”`,
              group: 'Ask',
              icon: <MessageSquare size={14} aria-hidden="true" />,
              run: () => onAsk(question)
            }
          ]
        : matches,
    [matches, onAsk, question]
  );
  // View mode hands the bar no modeling commands, so the examples have to
  // follow — a hint naming tools the list does not contain reads as a bug.
  const examples = commands.some((command) => command.id.startsWith('tool-'))
    ? 'box, extrude, front view, export'
    : 'front view, fit, export';
  const clampedIndex = Math.min(activeIndex, Math.max(visible.length - 1, 0));
  const listShown = open && !askMode;

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    if (open && document.activeElement !== input) {
      input.focus();
    } else if (!open && document.activeElement === input) {
      input.blur();
    }
  }, [open]);

  useEffect(() => {
    if (!listShown) {
      return;
    }
    const row = listRef.current?.querySelector<HTMLElement>(
      `#${optionId(clampedIndex)}`
    );
    row?.scrollIntoView({ block: 'nearest' });
  }, [clampedIndex, listShown]);

  function reset() {
    setQuery('');
    setAsking(false);
    setActiveIndex(0);
  }

  function dismiss() {
    const back = returnFocusRef.current;
    returnFocusRef.current = null;
    reset();
    onOpenChange(false);
    if (back?.isConnected) {
      back.focus({ preventScroll: true });
    }
    if (document.activeElement === inputRef.current) {
      inputRef.current?.blur();
    }
  }

  function runCommand(command: PaletteCommand | undefined) {
    if (!command || command.disabledReason) {
      return;
    }
    dismiss();
    command.run();
  }

  function placeholder(): string {
    if (askMode) {
      return 'Ask the assistant…';
    }
    if (open) {
      return onAsk
        ? `Type a command or a question… (${examples})`
        : `Type a command… (${examples})`;
    }
    return onAsk ? 'Search commands or ask the assistant' : 'Search commands';
  }

  return (
    <div className="command-bar-row">
      <div
        className={`command-bar${open ? ' open' : ''}${askMode ? ' asking' : ''}`}
        onMouseDown={(event) => {
          // The icon, the chip and the key glyph are part of the field: a
          // press on them focuses it rather than whatever lies behind.
          const target = event.target as HTMLElement;
          if (!target.closest('button, input, .command-bar-float')) {
            event.preventDefault();
            inputRef.current?.focus();
          }
        }}
      >
        {open && (
          <div
            className="command-bar-float"
            // Rows are pressed with the mouse while focus stays in the field.
            onMouseDown={(event) => event.preventDefault()}
          >
            {askMode ? (
              <p className="command-bar-keys" id={ASK_HINT_ID}>
                Enter sends this to the assistant · Tab goes back to commands
              </p>
            ) : (
              <>
                <div
                  className="palette-list"
                  id={LIST_ID}
                  role="listbox"
                  aria-label="Commands"
                  ref={listRef}
                >
                  {matches.length === 0 && (
                    <p className="palette-empty">
                      {onAsk && question
                        ? 'No matching command. Enter asks the assistant.'
                        : 'No matching command.'}
                    </p>
                  )}
                  {visible.map((command, index) => (
                    <button
                      key={command.id}
                      type="button"
                      id={optionId(index)}
                      role="option"
                      aria-selected={index === clampedIndex}
                      aria-disabled={command.disabledReason ? true : undefined}
                      // Focus stays in the field; the rows are described
                      // through aria-activedescendant instead.
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
                      {command.shortcut && (
                        <kbd>{platformShortcutLabel(command.shortcut)}</kbd>
                      )}
                    </button>
                  ))}
                </div>
                <p className="command-bar-keys" aria-hidden="true">
                  ↑↓ move · Enter runs
                  {onAsk ? ' · Tab asks the assistant' : ''} · Esc closes
                </p>
              </>
            )}
          </div>
        )}
        <span className="command-bar-lead" aria-hidden="true">
          {askMode ? <MessageSquare size={15} /> : <Search size={15} />}
        </span>
        <input
          ref={inputRef}
          className="command-bar-input"
          value={query}
          placeholder={placeholder()}
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-label="Search commands"
          aria-keyshortcuts={searchKey.accessible.replace('Cmd', 'Meta')}
          aria-autocomplete="list"
          aria-expanded={listShown}
          aria-controls={listShown ? LIST_ID : undefined}
          aria-activedescendant={
            listShown && visible.length > 0 ? optionId(clampedIndex) : undefined
          }
          aria-describedby={askMode ? ASK_HINT_ID : undefined}
          onFocus={(event) => {
            const from = event.relatedTarget;
            returnFocusRef.current = from instanceof HTMLElement ? from : null;
            if (!open) {
              onOpenChange(true);
            }
          }}
          onBlur={() => {
            reset();
            onOpenChange(false);
          }}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              dismiss();
            } else if (event.key === 'Tab' && !event.shiftKey && onAsk) {
              // Shift+Tab still leaves the field, so Tab never traps focus.
              event.preventDefault();
              setAsking((current) => !current);
            } else if (askMode) {
              if (event.key === 'Enter') {
                event.preventDefault();
                if (question) {
                  dismiss();
                  onAsk?.(question);
                }
              }
            } else if (event.key === 'ArrowDown') {
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
            }
          }}
        />
        {askMode && <span className="command-bar-mode">Ask</span>}
        <div className="command-bar-slot" ref={onAssistantSlot} />
        <kbd>{searchKey.glyph}</kbd>
      </div>
    </div>
  );
}
