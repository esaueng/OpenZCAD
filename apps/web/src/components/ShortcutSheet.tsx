import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { CATEGORY_LABELS, COMMANDS, type CommandCategory } from '../lib/commands';
import { CommandIcon } from './icons';

/** Searchable keyboard-shortcut reference (opened with ?). */
export function ShortcutSheet({ onClose }: { onClose(): void }) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const byCategory = new Map<CommandCategory, typeof COMMANDS>();
    for (const command of COMMANDS) {
      if (needle && !command.label.toLowerCase().includes(needle)) {
        continue;
      }
      const list = byCategory.get(command.category) ?? [];
      list.push(command);
      byCategory.set(command.category, list);
    }
    return [...byCategory.entries()];
  }, [query]);

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
      <div className="shortcut-sheet" role="dialog" aria-label="Keyboard shortcuts">
        <div className="sheet-header">
          <h2>Keyboard shortcuts</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
        <div className="search-input-row">
          <Search size={13} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            placeholder="Filter…"
            aria-label="Filter shortcuts"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                onClose();
              }
            }}
          />
        </div>
        <div className="sheet-body">
          {groups.map(([category, commands]) => (
            <section key={category} className="sheet-group">
              <h3>{CATEGORY_LABELS[category]}</h3>
              {commands.map((command) => (
                <div key={command.id} className="sheet-row">
                  <span className="sheet-row-icon">
                    <CommandIcon name={command.icon} size={13} />
                  </span>
                  <span className="sheet-row-label">{command.label}</span>
                  {command.shortcut ? <kbd>{command.shortcut}</kbd> : <span className="muted">—</span>}
                </div>
              ))}
            </section>
          ))}
          <section className="sheet-group">
            <h3>During a command</h3>
            <div className="sheet-row">
              <span className="sheet-row-label">Confirm</span>
              <kbd>↵</kbd>
            </div>
            <div className="sheet-row">
              <span className="sheet-row-label">Cancel</span>
              <kbd>Esc</kbd>
            </div>
            <div className="sheet-row">
              <span className="sheet-row-label">Next / previous parameter</span>
              <kbd>Tab / ⇧Tab</kbd>
            </div>
            <div className="sheet-row">
              <span className="sheet-row-label">Increment value (×10 with ⇧)</span>
              <kbd>↑ / ↓</kbd>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
