import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

export type StatusTone = 'ready' | 'warning' | 'running';

interface StatusLogEntry {
  id: number;
  message: string;
  detail?: string;
  timestamp: number;
  tone: StatusTone;
}

interface StatusActivityLogProps {
  id: string;
  open: boolean;
  status: string;
  detail?: string;
  tone: StatusTone;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose(restoreFocus: boolean): void;
}

const statusTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});

// Status ticks arrive from every hover prompt, save, and rebuild for the life
// of the session; without a bound a day-long session accumulates thousands of
// entries and every append reallocates the array.
const MAX_STATUS_LOG_ENTRIES = 200;

export function StatusActivityLog({
  id,
  open,
  status,
  detail,
  tone,
  triggerRef,
  onClose
}: StatusActivityLogProps) {
  const nextEntryIdRef = useRef(1);
  const previousStatusRef = useRef({ status, detail, tone });
  const panelRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const [entries, setEntries] = useState<StatusLogEntry[]>(() => [
    {
      id: 0,
      message: status,
      ...(detail ? { detail } : {}),
      timestamp: Date.now(),
      tone
    }
  ]);

  useEffect(() => {
    const previous = previousStatusRef.current;
    if (
      previous.status === status &&
      previous.detail === detail &&
      previous.tone === tone
    ) {
      return;
    }
    previousStatusRef.current = { status, detail, tone };
    setEntries((current) =>
      [
        ...current,
        {
          id: nextEntryIdRef.current++,
          message: status,
          ...(detail ? { detail } : {}),
          timestamp: Date.now(),
          tone
        }
      ].slice(-MAX_STATUS_LOG_ENTRIES)
    );
  }, [detail, status, tone]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !panelRef.current?.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
        onClose(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      // The workspace has its own Escape ladder. This overlay must consume
      // the key before it can also cancel a modeling action behind the log.
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose(true);
    };

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    window.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      window.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [onClose, open, triggerRef]);

  useEffect(() => {
    if (open && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [entries, open]);

  if (!open) {
    return null;
  }

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
            {nextEntryIdRef.current > MAX_STATUS_LOG_ENTRIES ? 'latest ' : ''}
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
