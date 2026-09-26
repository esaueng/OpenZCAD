import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  platformShortcutLabel,
  type PlatformShortcutCopy
} from '../lib/platformShortcut';
import {
  sendAssistantPromptFiles,
  sendAssistantPromptKey
} from '../lib/assistant/promptKeys';

const LIST_ID = 'command-palette-list';
const optionId = (index: number) => `command-palette-option-${index}`;

/** The grammar: a leading slash means a command, anything else is an ask. */
export const COMMAND_PREFIX = '/';

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
   * The bar has focus. The host owns it so ⌘K, "/" and Settings can take or
   * drop focus; a click or focus opens it too.
   */
  open: boolean;
  onOpenChange(open: boolean): void;
  /**
   * Sends the typed text to the assistant. Present, anything typed without
   * the slash is a question that Enter sends, so search and asking are one
   * prompt line.
   */
  onAsk?(question: string): void;
  /** The platform's shortcut for the bar: ⌘K or Ctrl+K. */
  searchKey: PlatformShortcutCopy;
  /** The assistant is answering: the prompt's glyph turns while it does. */
  busy?: boolean;
  /** A reply landed while the conversation was tucked away. */
  unread?: boolean;
  /**
   * What an ask can see, for the placeholder: "12 selected edges". The
   * conversation reports it, since it owns the selection summary.
   */
  context?: string | null;
  /**
   * Words put into the field from outside: a suggestion the conversation
   * offers, or a question it could not take yet. A fresh id sets the field
   * and focuses it, even to the same words twice.
   */
  draft?: { id: number; text: string } | null;
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
 * The rest of the highlighted command's name, when what is typed is its
 * start: "/cy" shows "linder" after it, and Tab accepts.
 */
function completionOf(typed: string, command: PaletteCommand | undefined) {
  if (!command || typed.length === 0) {
    return '';
  }
  const label = command.label;
  return label.toLowerCase().startsWith(typed.toLowerCase())
    ? label.slice(typed.length)
    : '';
}

/**
 * The prompt line at the foot of the stage, the one text field on it.
 *
 * Plain words are a question for the assistant, and Enter sends them. A
 * leading slash is a command: the list of matches stands on the bar, the
 * highlighted one completes in ghost text, Tab accepts it, arrows move and
 * Enter runs it. Empty, Enter applies the proposal waiting in the stream, `p`
 * previews it and Escape rejects it; Escape otherwise clears the field, then
 * hands focus back to where it was.
 */
export function CommandBar({
  commands,
  open,
  onOpenChange,
  onAsk,
  searchKey,
  busy = false,
  unread = false,
  context = null,
  draft = null
}: CommandBarProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Where focus was before the bar took it, for Escape and for a command
  // that has run: the canvas keeps its keys instead of landing on <body>.
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const commandMode = query.startsWith(COMMAND_PREFIX);
  const typed = commandMode ? query.slice(COMMAND_PREFIX.length) : '';
  // The host rebuilds the command list every render; only rank it while
  // the list is up.
  const matches = useMemo(
    () => (open && commandMode ? rankedCommands(commands, typed) : []),
    [commands, open, commandMode, typed]
  );
  const question = commandMode ? '' : query.trim();
  const clampedIndex = Math.min(activeIndex, Math.max(matches.length - 1, 0));
  const listShown = open && commandMode;
  const completion = listShown
    ? completionOf(typed, matches[clampedIndex])
    : '';

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

  const handledDraftId = useRef<number | null>(null);
  useEffect(() => {
    if (!draft || handledDraftId.current === draft.id) {
      return;
    }
    handledDraftId.current = draft.id;
    setQuery(draft.text);
    onOpenChange(true);
    const input = inputRef.current;
    if (input) {
      input.focus();
      // Focus alone keeps the caret where it last was; a suggestion is
      // edited from its end.
      const end = draft.text.length;
      requestAnimationFrame(() => input.setSelectionRange(end, end));
    }
    // Only a new draft id writes the field; onOpenChange is stable enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

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
    if (!onAsk) {
      return 'Type / for a command';
    }
    if (context) {
      return `Ask about ${context}…`;
    }
    return 'Ask about the model, or / for a command';
  }

  const empty = query.length === 0;

  return (
    <div className="command-bar-row">
      <div
        className={`command-bar${open ? ' open' : ''}${
          commandMode ? ' command' : ''
        }${busy ? ' busy' : ''}${unread ? ' unread' : ''}`}
        onMouseDown={(event) => {
          // The glyph and the key badge are part of the field: a press on
          // them focuses it rather than whatever lies behind.
          const target = event.target as HTMLElement;
          if (!target.closest('button, input, .command-bar-float')) {
            event.preventDefault();
            inputRef.current?.focus();
          }
        }}
      >
        {listShown && (
          <div
            className="command-bar-float"
            // Rows are pressed with the mouse while focus stays in the field.
            onMouseDown={(event) => event.preventDefault()}
          >
            <div
              className="palette-list"
              id={LIST_ID}
              role="listbox"
              aria-label="Commands"
              ref={listRef}
            >
              {matches.length === 0 && (
                <p className="palette-empty">No matching command.</p>
              )}
              {matches.map((command, index) => (
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
              ↑↓ move · Tab completes · Enter runs · Esc clears
            </p>
          </div>
        )}
        <span className="command-bar-lead" aria-hidden="true">
          {/* The chevron as a two-line sketch with its three points, so the
              assistant's working state can redraw it point by point. */}
          <svg
            className="command-bar-glyph"
            viewBox="0 0 16 16"
            width="16"
            height="16"
          >
            <line
              className="command-bar-stroke command-bar-stroke-in"
              pathLength={100}
              x1="6"
              y1="4"
              x2="10"
              y2="8"
            />
            <line
              className="command-bar-stroke command-bar-stroke-out"
              pathLength={100}
              x1="10"
              y1="8"
              x2="6"
              y2="12"
            />
            <rect
              className="command-bar-point command-bar-point-start"
              x="5"
              y="3"
              width="2"
              height="2"
            />
            <rect
              className="command-bar-point command-bar-point-tip"
              x="9"
              y="7"
              width="2"
              height="2"
            />
            <rect
              className="command-bar-point command-bar-point-end"
              x="5"
              y="11"
              width="2"
              height="2"
            />
          </svg>
        </span>
        <span className="command-bar-field">
          {completion && (
            // The ghost sits under the field in the same type: the typed
            // text is invisible so the completion lands after it.
            <span className="command-bar-ghost" aria-hidden="true">
              <span className="command-bar-ghost-typed">{query}</span>
              {completion}
            </span>
          )}
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
              listShown && matches.length > 0
                ? optionId(clampedIndex)
                : undefined
            }
            onFocus={(event) => {
              const from = event.relatedTarget;
              returnFocusRef.current =
                from instanceof HTMLElement ? from : null;
              if (!open) {
                onOpenChange(true);
              }
            }}
            onBlur={() => {
              reset();
              onOpenChange(false);
            }}
            onChange={(event) => setQuery(event.target.value)}
            onPaste={(event) => {
              // A pasted screenshot or drawing attaches to the next ask;
              // pasted text is typed as usual.
              const files = Array.from(event.clipboardData?.files ?? []);
              if (files.length > 0 && sendAssistantPromptFiles(files)) {
                event.preventDefault();
              }
            }}
            onKeyDown={(event) => {
              const meta = event.metaKey || event.ctrlKey;
              if (event.key === 'Escape') {
                event.preventDefault();
                if (!empty) {
                  reset();
                } else if (!sendAssistantPromptKey('reject')) {
                  dismiss();
                }
              } else if (meta && event.key === 'ArrowUp') {
                event.preventDefault();
                sendAssistantPromptKey('history');
              } else if (event.key === 'Tab' && !event.shiftKey && completion) {
                // Shift+Tab still leaves the field, so Tab never traps focus.
                event.preventDefault();
                // The command's own spelling, not the typed case.
                setQuery(`${COMMAND_PREFIX}${matches[clampedIndex]!.label}`);
              } else if (listShown && event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex((index) =>
                  Math.min(index + 1, matches.length - 1)
                );
              } else if (listShown && event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex((index) => Math.max(index - 1, 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                if (commandMode) {
                  runCommand(matches[clampedIndex]);
                } else if (question) {
                  if (onAsk) {
                    dismiss();
                    onAsk(question);
                  }
                } else {
                  sendAssistantPromptKey('apply');
                }
              } else if (empty && event.key === 'p' && !meta) {
                if (sendAssistantPromptKey('preview')) {
                  event.preventDefault();
                }
              }
            }}
          />
        </span>
        <kbd>{searchKey.glyph}</kbd>
      </div>
    </div>
  );
}
