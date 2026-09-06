import { useEffect, useId, useRef, useState } from 'react';
import {
  SELECTION_FILTERS,
  SELECTION_FILTER_LABELS,
  type SelectionFilter
} from '@openzcad/viewport/types';
import type { WorkspaceSaveState } from '../lib/cloudProjectAutosave';
import { statusExpiresAt } from '../lib/statusLifetime';
import { WORKSPACE_SAVE_STATE_PRESENTATION } from '../lib/workspaceSaveStatePresentation';
import { StatusActivityLog, type StatusTone } from './StatusActivityLog';

interface WorkspaceReadoutProps {
  status: string;
  statusAt?: number;
  statusSticky?: boolean;
  tone: StatusTone;
  /** Context-sensitive next step, shown once the status has expired. */
  hint: string | null;
  saveState: WorkspaceSaveState;
  /** Sketch snap spacing, shown while a sketch is open; null hides it. */
  snap: { spacing: number; units: string; enabled: boolean } | null;
  /**
   * A tool card is up and carries the message itself; the readout keeps
   * only the corner facts so the same sentence is not on screen twice.
   */
  muted?: boolean;
  /** What picking is narrowed to; the readout shows it and Q-style cycles it. */
  selectionFilter: SelectionFilter;
  selectionFilterIsAutomatic: boolean;
  onSelectionFilter(filter: SelectionFilter | null): void;
}

/**
 * What the status bar said, without the bar: the live message (or the hint
 * once it has expired) bottom-centre over the viewport, and the sync state
 * with the sketch snap as a one-line readout in the corner.
 */
export function WorkspaceReadout({
  status,
  statusAt,
  statusSticky,
  tone,
  hint,
  saveState,
  snap,
  muted = false,
  selectionFilter,
  selectionFilterIsAutomatic,
  onSelectionFilter
}: WorkspaceReadoutProps) {
  // The status bar's activity log, opened from the message itself.
  const logId = useId();
  const [logOpen, setLogOpen] = useState(false);
  const messageRef = useRef<HTMLButtonElement | null>(null);
  // Same lifetime rule as the status bar: an informational message goes
  // quiet once it has had its time, and the hint takes the slot back.
  const expiresAt =
    statusAt === undefined
      ? null
      : statusExpiresAt({ at: statusAt, sticky: statusSticky ?? false });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === null) {
      return;
    }
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      setNow(Date.now());
      return;
    }
    const timer = window.setTimeout(() => setNow(Date.now()), remaining);
    return () => window.clearTimeout(timer);
  }, [expiresAt]);
  const quiet = expiresAt !== null && now >= expiresAt;
  const message = quiet || status === '' ? hint : status;
  const messageTone = quiet || status === '' ? 'ready' : tone;
  const sync = WORKSPACE_SAVE_STATE_PRESENTATION[saveState];
  const filterIndex = SELECTION_FILTERS.indexOf(selectionFilter);
  const nextFilter =
    SELECTION_FILTERS[(filterIndex + 1) % SELECTION_FILTERS.length]!;
  return (
    <div className="workspace-readout">
      <button
        ref={messageRef}
        type="button"
        className={`workspace-readout-hint ${messageTone}${muted || !message ? ' empty' : ''}`}
        title={message ? `${message} — activity log` : 'Activity log'}
        aria-label={`${logOpen ? 'Close' : 'Open'} activity log.${message && !muted ? ` Current status: ${message}` : ''}`}
        aria-expanded={logOpen}
        aria-controls={logId}
        onClick={() => setLogOpen((open) => !open)}
      >
        <span role="status" aria-live="polite" aria-atomic="true">
          {muted ? '' : message}
        </span>
      </button>
      <div className="workspace-readout-meta mono">
        <button
          type="button"
          className={`workspace-readout-filter${selectionFilterIsAutomatic ? ' automatic' : ''}`}
          title={
            selectionFilterIsAutomatic
              ? `Selecting ${SELECTION_FILTER_LABELS[selectionFilter].toLowerCase()} — chosen by the active tool · Q cycles`
              : `Selecting ${SELECTION_FILTER_LABELS[selectionFilter].toLowerCase()} · click or Q for ${SELECTION_FILTER_LABELS[nextFilter].toLowerCase()}`
          }
          aria-label={`Selection filter: ${SELECTION_FILTER_LABELS[selectionFilter]}. Cycle.`}
          onClick={() => onSelectionFilter(nextFilter)}
        >
          select {SELECTION_FILTER_LABELS[selectionFilter]}
        </button>
        {snap && (
          <span>
            {snap.enabled ? `Snap ${snap.spacing} ${snap.units}` : 'Snap off'}
          </span>
        )}
        <span className={`workspace-readout-sync ${saveState}`}>
          <i aria-hidden="true" />
          {sync.statusBarLabel}
        </span>
      </div>
      <StatusActivityLog
        id={logId}
        open={logOpen}
        status={status}
        tone={tone}
        triggerRef={messageRef}
        onClose={(restoreFocus) => {
          setLogOpen(false);
          if (restoreFocus) {
            messageRef.current?.focus();
          }
        }}
      />
    </div>
  );
}
