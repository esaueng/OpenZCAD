import { useEffect, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { StatusLogEntry } from './StatusActivityLog';

interface StatusActivityLogPanelProps {
  id: string;
  entries: readonly StatusLogEntry[];
  /** Older entries were dropped to keep the log bounded. */
  truncated: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose(restoreFocus: boolean): void;
}

const statusTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});

/**
 * The activity log's panel. The log itself (StatusActivityLog) records every
 * message from the moment the workspace opens and stays on the entry chunk;
 * this, drawn only when someone opens it, loads on demand.
 */
export function StatusActivityLogPanel({
  id,
  entries,
  truncated,
  triggerRef,
  onClose
}: StatusActivityLogPanelProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !panelRef.current?.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
        onClose(false);
      }
    };

    // Escape is the always-loaded StatusActivityLog's: it has to work
    // before this chunk arrives.
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () =>
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [onClose, triggerRef]);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [entries]);

  return createPortal(
    <section
      ref={panelRef}
      id={id}
      className="status-log-panel"
      role="region"
      aria-label="Activity log"
    >
      <header className="status-log-header">
        <div>
          <strong>Activity log</strong>
          <span>
            {truncated ? 'latest ' : ''}
            {entries.length} {entries.length === 1 ? 'entry' : 'entries'} this
            session
          </span>
        </div>
        <button
          type="button"
          className="status-log-close"
          onClick={() => onClose(true)}
        >
          Close
        </button>
      </header>
      <ol ref={listRef} className="status-log-list">
        {entries.map((entry, index) => {
          const isCurrent = index === entries.length - 1;
          const date = new Date(entry.timestamp);
          return (
            <li
              key={entry.id}
              className={`status-log-entry${isCurrent ? ' current' : ''}`}
              aria-current={isCurrent ? 'true' : undefined}
            >
              <i className={entry.tone} aria-hidden="true" />
              <time dateTime={date.toISOString()}>
                {statusTimeFormatter.format(date)}
              </time>
              <span className="status-log-copy">
                <span>{entry.message}</span>
                {entry.detail ? (
                  <span className="status-log-detail">{entry.detail}</span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
    </section>,
    document.body
  );
}
