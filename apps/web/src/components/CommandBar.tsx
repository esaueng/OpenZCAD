import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  platformShortcutLabel,
  type PlatformShortcutCopy
} from '../lib/platformShortcut';
import {
  sendAssistantPromptFiles,
  sendAssistantPromptKey
} from '../lib/assistant/promptKeys';
import {
  browseCommands,
  loadRecentCommands,
  rankedCommands,
  recordRecentCommand
} from '../lib/commandSearch';
import { ShortcutKeys } from './ShortcutKeys';

const LIST_ID = 'command-palette-list';
const ASK_HINT_ID = 'command-bar-ask-hint';
const optionId = (index: number) => `command-palette-option-${index}`;

/**
 * The grammar: a leading slash means a command. Plain words search the
 * commands too, and with an assistant to answer, Enter asks it instead.
 */
export const COMMAND_PREFIX = '/';

const KEYS_RUN = '↑↓ move · Tab completes · Enter runs · Esc clears';
const KEYS_ASK = '↑ picks a command · Enter asks the assistant · Esc clears';

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
  /**
   * The command does not act on the current pick: an empty search leaves it
   * out and a typed one ranks it lower (`lib/commandSearch.ts`).
   */
  offPick?: boolean;
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
   * prompt line; the commands it names still list above the ask.
   */
  onAsk?(question: string): void;
  /**
   * No model provider answers right now. Plain words are then a command
   * search like the slash, and Enter runs the best match; only a line that
   * matches no command still goes to the assistant, whose built-in recipes
   * need no provider. The bar stops inviting questions the footer would
   * only answer with "Unavailable".
   */
  askUnavailable?: boolean;
  /** The platform's shortcut for the bar: ⌘K or Ctrl+K. */
  /** Null when the user unbound the shortcut. */
  searchKey: PlatformShortcutCopy | null;
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
  /**
   * What is picked, for the empty search's caption: "1 face". The list then
   * holds only the commands that act on it.
   */
  pick?: string | null;
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
 * Typed words search the commands: the list of matches stands on the bar,
 * the highlighted one completes in ghost text, Tab accepts it, arrows move
 * and Enter runs it. With an assistant to answer, plain words are a
 * question as well: the list ends in an "Ask" row, highlighted, so Enter
 * sends them unless an arrow picked a command first. A leading slash is
 * always a command. (Signed out, "fil" and Enter used to do nothing.)
 *
 * Empty, Enter applies the proposal waiting in the stream, `p` previews it
 * and Escape rejects it; Escape otherwise clears the field and hands focus
 * back to where it was in the same press, so the next key ("?" for the
 * shortcuts) reaches the workspace instead of the field.
 */
export function CommandBar({
  commands,
  open,
  onOpenChange,
  onAsk,
  askUnavailable = false,
  searchKey,
  busy = false,
  unread = false,
  context = null,
  draft = null,
  pick = null
}: CommandBarProps) {
  const [query, setQuery] = useState('');
  // Null is the default row: the ask row when there is one, else the best
  // match.
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  // Most recent first; read once, then kept in step with what runs here.
  const [recentIds, setRecentIds] = useState(loadRecentCommands);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Where focus was before the bar took it, for Escape and for a command
  // that has run: the canvas keeps its keys instead of landing on <body>.
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const canAsk = Boolean(onAsk) && !askUnavailable;
  const slashMode = query.startsWith(COMMAND_PREFIX);
  const question = slashMode ? '' : query.trim();
  // Plain words search as the slash does. Without an assistant they are
  // only a search, so the bar reads as one (the glyph turns, the stream
  // steps aside) exactly as it does for "/".
  const searching = slashMode || question.length > 0;
  const commandMode = slashMode || (question.length > 0 && !canAsk);
  const prefix = slashMode ? COMMAND_PREFIX : '';
  const typed = query.slice(prefix.length);
  // The host rebuilds the command list every render; only rank it while
  // the list is up.
  const browsing = typed.trim().length === 0;
  const entries = useMemo(() => {
    if (!open || !searching) {
      return [];
    }
    return browsing
      ? browseCommands(commands, recentIds)
      : rankedCommands(commands, typed, recentIds).map((command) => ({
          command,
          recent: false
        }));
  }, [browsing, commands, open, recentIds, searching, typed]);
  const matches = useMemo(
    () => entries.map((entry) => entry.command),
    [entries]
  );
  const hasMatches = matches.length > 0;
  // A question that names commands lists them above an "Ask" row; one that
  // names none keeps the hint alone, so a sentence does not cover the
  // stream with an empty list.
  const askRow = canAsk && question.length > 0 && hasMatches;
  const rowCount = matches.length + (askRow ? 1 : 0);
  const askIndex = askRow ? matches.length : -1;
  const clampedIndex = Math.min(
    activeIndex ?? (askRow ? askIndex : 0),
    Math.max(rowCount - 1, 0)
  );
  const activeCommand =
    clampedIndex === askIndex ? undefined : matches[clampedIndex];
  const listShown = open && (commandMode || askRow);
  const hasRows = rowCount > 0;
  // Words matching no command list nothing, so "fil" looked like a search
  // that found nothing. Say what Enter will do with them, and where the
  // commands are.
  const askHintShown = open && canAsk && question.length > 0 && !askRow;
  const completion = listShown ? completionOf(typed, activeCommand) : '';

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
    setActiveIndex(null);
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
    setActiveIndex(null);
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
    setRecentIds(recordRecentCommand(command.id));
    command.run();
  }

  function ask() {
    if (!onAsk || !question) {
      return;
    }
    dismiss();
    onAsk(question);
  }

  function placeholder(): string {
    if (!canAsk) {
      return 'Search commands';
    }
    if (context) {
      return `Ask about ${context}…`;
    }
    return 'Search commands or ask about the model';
  }

  const empty = query.length === 0;

  return (
    // Marked for the stream's click-off check (ASSISTANT_PROMPT_SELECTOR).
    <div className="command-bar-row" data-assistant-prompt="">
      <div
        className={`command-bar${open ? ' open' : ''}${
          commandMode ? ' command' : ''
        }${listShown ? ' listing' : ''}${busy ? ' busy' : ''}${
          unread ? ' unread' : ''
        }`}
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
            {/* Outside the listbox, whose children may only be options, and
                mounted with the list so the message lands in a live region
                that already exists. */}
            <p
              className={hasRows ? 'visually-hidden' : 'palette-empty'}
              role="status"
            >
              {hasRows
                ? ''
                : browsing
                  ? 'Nothing runs here now. Type to search every command.'
                  : 'No matching command.'}
            </p>
            {hasRows && (
              <div
                className="palette-list"
                id={LIST_ID}
                role="listbox"
                aria-label="Commands"
                ref={listRef}
              >
                {entries.map(({ command, recent }, index) => (
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
                    // Movement, not entry: the list opens over the viewport
                    // where the pointer rests, and the row that appeared under
                    // a still pointer took the highlight from the keyboard.
                    onMouseMove={() => {
                      if (index !== clampedIndex) {
                        setActiveIndex(index);
                      }
                    }}
                    onClick={() => runCommand(command)}
                  >
                    <span className="palette-icon">{command.icon}</span>
                    <span className="palette-label">{command.label}</span>
                    {command.disabledReason ? (
                      <small className="palette-reason">
                        {command.disabledReason}
                      </small>
                    ) : (
                      <small className="palette-group">
                        {recent ? 'Recent' : command.group}
                      </small>
                    )}
                    {command.shortcut && (
                      <kbd>
                        <ShortcutKeys
                          label={platformShortcutLabel(command.shortcut)}
                        />
                      </kbd>
                    )}
                  </button>
                ))}
                {askRow && (
                  // Last, beside the field the words were typed in, and
                  // highlighted until an arrow picks a command above it.
                  <button
                    type="button"
                    id={optionId(askIndex)}
                    role="option"
                    aria-selected={clampedIndex === askIndex}
                    tabIndex={-1}
                    className={`palette-row palette-ask ${
                      clampedIndex === askIndex ? 'active' : ''
                    }`}
                    onMouseMove={() => {
                      if (clampedIndex !== askIndex) {
                        setActiveIndex(askIndex);
                      }
                    }}
                    onClick={ask}
                  >
                    <span className="palette-icon" />
                    <span className="palette-label">Ask “{question}”</span>
                    <small className="palette-group">Assistant</small>
                  </button>
                )}
              </div>
            )}
            {hasRows && (
              <p className="command-bar-keys" aria-hidden="true">
                {clampedIndex === askIndex
                  ? KEYS_ASK
                  : browsing && pick
                    ? `For ${pick} · type to search all · ${KEYS_RUN}`
                    : KEYS_RUN}
              </p>
            )}
          </div>
        )}
        {askHintShown && (
          <div
            className="command-bar-float command-bar-ask"
            onMouseDown={(event) => event.preventDefault()}
          >
            <p className="command-bar-keys" id={ASK_HINT_ID}>
              Enter asks the assistant · type / for commands
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
            // ARIA names the modifiers Meta and Control.
            aria-keyshortcuts={searchKey?.accessible
              .replace('Cmd', 'Meta')
              .replace('Ctrl', 'Control')}
            aria-autocomplete="list"
            aria-expanded={listShown && hasRows}
            aria-describedby={askHintShown ? ASK_HINT_ID : undefined}
            aria-controls={listShown && hasRows ? LIST_ID : undefined}
            aria-activedescendant={
              listShown && hasRows ? optionId(clampedIndex) : undefined
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
            onChange={(event) => {
              // With the text, in one render: a highlight kept from the
              // last query must not pick the row Enter acts on.
              setQuery(event.target.value);
              setActiveIndex(null);
            }}
            onPaste={(event) => {
              // A pasted screenshot or drawing attaches to the next ask;
              // pasted text is typed as usual.
              const files = Array.from(event.clipboardData?.files ?? []);
              if (files.length > 0 && sendAssistantPromptFiles(files)) {
                event.preventDefault();
              }
            }}
            onKeyDown={(event) => {
              // An input method's keys are its own: the Enter that commits a
              // composed word must not also run the command it now matches,
              // nor its Escape drop the field.
              if (event.nativeEvent.isComposing || event.keyCode === 229) {
                return;
              }
              const meta = event.metaKey || event.ctrlKey;
              if (event.key === 'Escape') {
                event.preventDefault();
                // One press leaves. Clearing the text but keeping the focus
                // made the next "?" type into the field rather than open the
                // shortcuts. Only an empty field offers the press to the
                // stream first, whose proposal it rejects and nothing else.
                if (!empty || !sendAssistantPromptKey('reject')) {
                  dismiss();
                }
              } else if (meta && event.key === 'ArrowUp') {
                event.preventDefault();
                sendAssistantPromptKey('history');
              } else if (event.key === 'Tab' && !event.shiftKey && completion) {
                // Shift+Tab still leaves the field, so Tab never traps focus.
                event.preventDefault();
                // The command's own spelling, not the typed case, and the
                // slash only if one was typed.
                const completed = activeCommand!;
                setQuery(`${prefix}${completed.label}`);
                setActiveIndex(
                  rankedCommands(
                    commands,
                    completed.label,
                    recentIds
                  ).findIndex((command) => command.id === completed.id)
                );
              } else if (listShown && hasRows && event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex(Math.min(clampedIndex + 1, rowCount - 1));
              } else if (listShown && hasRows && event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex(Math.max(clampedIndex - 1, 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                if (activeCommand) {
                  runCommand(activeCommand);
                } else if (question) {
                  // The ask row; or, with no provider, words that matched no
                  // command, which only the built-in recipes may still take.
                  ask();
                } else if (!searching) {
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
        {searchKey && (
          <kbd>
            <ShortcutKeys label={searchKey.glyph} />
          </kbd>
        )}
      </div>
    </div>
  );
}
