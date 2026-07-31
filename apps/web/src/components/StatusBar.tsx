import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  SELECTION_FILTERS,
  SELECTION_FILTER_LABELS,
  type SelectionFilter
} from '@openzcad/viewport';

type StatusTone = 'ready' | 'warning' | 'running';

interface StatusLogEntry {
  id: number;
  message: string;
  timestamp: number;
  tone: StatusTone;
}

const statusTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});

interface StatusBarProps {
  status: string;
  tone: StatusTone;
  /** Context-sensitive next-step hint, e.g. shortcuts for the selection. */
  hint: string | null;
  projectName: string | null;
  bodyCount: number;
  featureCount: number;
  warningCount: number;
  documentVersion: number | null;
  units: string;
  /** What picking is currently narrowed to, however that was decided. */
  selectionFilter: SelectionFilter;
  /** True while the active tool is choosing the filter rather than the user. */
  selectionFilterIsAutomatic: boolean;
  /** Null clears the manual choice and hands the filter back to the tool. */
  onSelectionFilter(filter: SelectionFilter | null): void;
}

export function StatusBar({
  status,
  tone,
  hint,
  projectName,
  bodyCount,
  featureCount,
  warningCount,
  documentVersion,
  units,
  selectionFilter,
  selectionFilterIsAutomatic,
  onSelectionFilter
}: StatusBarProps) {
  const logPanelId = useId();
  const [logOpen, setLogOpen] = useState(false);
  const nextLogIdRef = useRef(1);
  const previousStatusRef = useRef({ status, tone });
  const statusButtonRef = useRef<HTMLButtonElement | null>(null);
  const logPanelRef = useRef<HTMLElement | null>(null);
  const logListRef = useRef<HTMLOListElement | null>(null);
  const [logEntries, setLogEntries] = useState<StatusLogEntry[]>(() => [
    { id: 0, message: status, timestamp: Date.now(), tone }
  ]);

  useEffect(() => {
    const previous = previousStatusRef.current;
    if (previous.status === status && previous.tone === tone) {
      return;
    }
    previousStatusRef.current = { status, tone };
    setLogEntries((entries) => [
      ...entries,
      {
        id: nextLogIdRef.current++,
        message: status,
        timestamp: Date.now(),
        tone
      }
    ]);
  }, [status, tone]);

  useEffect(() => {
    if (!logOpen) {
      return;
    }

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !logPanelRef.current?.contains(target) &&
        !statusButtonRef.current?.contains(target)
      ) {
        setLogOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setLogOpen(false);
        statusButtonRef.current?.focus();
      }
    };

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [logOpen]);

  useEffect(() => {
    if (logOpen && logListRef.current) {
      logListRef.current.scrollTop = logListRef.current.scrollHeight;
    }
  }, [logEntries, logOpen]);

  const logPanel = logOpen
    ? createPortal(
        <section
          ref={logPanelRef}
          id={logPanelId}
          className="status-log-panel"
          role="region"
          aria-label="Activity log"
        >
          <header className="status-log-header">
            <div>
              <strong>Activity log</strong>
              <span>
                {logEntries.length}{' '}
                {logEntries.length === 1 ? 'entry' : 'entries'} this session
              </span>
            </div>
            <button
              type="button"
              className="status-log-close"
              onClick={() => {
                setLogOpen(false);
                statusButtonRef.current?.focus();
              }}
            >
              Close
            </button>
          </header>
          <ol ref={logListRef} className="status-log-list">
            {logEntries.map((entry, index) => {
              const isCurrent = index === logEntries.length - 1;
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
                  <span>{entry.message}</span>
                </li>
              );
            })}
          </ol>
        </section>,
        document.body
      )
    : null;

  return (
    <>
      <footer className="status-bar">
        <button
          ref={statusButtonRef}
          type="button"
          className={`status-state ${tone === 'ready' ? '' : tone}${
            logOpen ? ' open' : ''
          }`}
          title={`${status} — View activity log`}
          aria-label={`${logOpen ? 'Close' : 'Open'} activity log. Current status: ${status}`}
          aria-expanded={logOpen}
          aria-controls={logPanelId}
          onClick={() => setLogOpen((open) => !open)}
        >
          <i />
          <span>{status}</span>
          <span className="status-log-caret" aria-hidden="true">
            {logOpen ? '▾' : '▴'}
          </span>
        </button>
        {hint && <span className="status-hint">{hint}</span>}
        <div
          className="status-filters"
          role="group"
          aria-label="Selection filter"
        >
          <b>select</b>
          {SELECTION_FILTERS.map((filter) => {
            const active = filter === selectionFilter;
            // Clicking the active chip clears the manual choice rather than
            // re-asserting it, so the tool can take the filter back without a
            // second control to find.
            return (
              <button
                key={filter}
                type="button"
                className={`status-filter${active ? ' active' : ''}${
                  active && selectionFilterIsAutomatic ? ' automatic' : ''
                }`}
                aria-pressed={active}
                title={
                  active && selectionFilterIsAutomatic
                    ? `${SELECTION_FILTER_LABELS[filter]} — chosen by the active tool`
                    : `Select ${SELECTION_FILTER_LABELS[filter].toLowerCase()} only (Q cycles)`
                }
                onClick={() =>
                  onSelectionFilter(
                    active && !selectionFilterIsAutomatic ? null : filter
                  )
                }
              >
                {SELECTION_FILTER_LABELS[filter]}
              </button>
            );
          })}
        </div>
        <div className="status-groups" aria-label="Workspace status">
          <span>
            <b>kernel</b>
            Exact B-rep
          </span>
          <span>
            <b>units</b>
            {units}
          </span>
          <span>
            <b>warnings</b>
            {warningCount}
          </span>
          <span>
            <b>rev</b>
            {documentVersion ?? '—'}
          </span>
          <span
            title={`${projectName ?? 'Project'} · ${featureCount} features · ${bodyCount} bodies`}
          >
            <b>sync</b>
            Synced
          </span>
        </div>
      </footer>
      {logPanel}
    </>
  );
}
