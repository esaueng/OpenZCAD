import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import {
  CATEGORY_LABELS,
  searchCommands,
  type CommandContext
} from '../lib/commands';
import { CommandIcon } from './icons';

interface CommandSearchProps {
  ctx: CommandContext;
  onRun(commandId: string): void;
  onClose(): void;
}

/**
 * Keyboard-first command launcher (S / Ctrl+K). Lists every command with its
 * category and shortcut; unavailable commands stay visible with the reason
 * they are disabled so capability is discoverable, not hidden.
 */
export function CommandSearch({ ctx, onRun, onClose }: CommandSearchProps) {
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const results = useMemo(() => searchCommands(query, ctx), [query, ctx]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setHighlighted(0);
  }, [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-highlighted="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  function runHighlighted() {
    const result = results[highlighted];
    if (result?.enabled) {
      onRun(result.command.id);
      onClose();
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="command-search" role="dialog" aria-label="Command search">
        <div className="search-input-row">
          <Search size={14} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            placeholder="Search commands…"
            aria-label="Search commands"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                onClose();
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                setHighlighted((value) => Math.min(value + 1, results.length - 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setHighlighted((value) => Math.max(value - 1, 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                runHighlighted();
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="search-results" role="listbox" ref={listRef}>
          {results.length === 0 && <li className="search-empty">No matching commands.</li>}
          {results.map((result, index) => (
            <li key={result.command.id}>
              <button
                type="button"
                role="option"
                aria-selected={index === highlighted}
                data-highlighted={index === highlighted}
                className={`search-result ${index === highlighted ? 'highlighted' : ''} ${result.enabled ? '' : 'disabled'}`}
                disabled={!result.enabled}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => {
                  onRun(result.command.id);
                  onClose();
                }}
              >
                <span className="search-result-icon">
                  <CommandIcon name={result.command.icon} size={14} />
                </span>
                <span className="search-result-label">{result.command.label}</span>
                <span className="search-result-category">
                  {result.reason ?? CATEGORY_LABELS[result.command.category]}
                </span>
                {result.command.shortcut && <kbd>{result.command.shortcut}</kbd>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
