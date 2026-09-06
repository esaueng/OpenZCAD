import { useEffect, useState, type RefObject } from 'react';
import { History } from 'lucide-react';
import {
  SELECTION_FILTERS,
  SELECTION_FILTER_LABELS,
  type SelectionFilter
} from '@openzcad/viewport/types';
import { statusExpiresAt } from '../lib/statusLifetime';
import type { StatusTone } from './StatusActivityLog';

interface WorkspaceReadoutProps {
  status: string;
  statusAt?: number;
  statusSticky?: boolean;
  tone: StatusTone;
  /** A tool card is up and carries the message itself. */
  muted?: boolean;
  logOpen: boolean;
  onToggleLog(): void;
}

/**
 * What the status bar said, as a toast above the viewport dock: the live
 * message while it has its lifetime, nothing once it has gone quiet. It is
 * also a handle for the activity log, whose panel App owns.
 */
export function WorkspaceReadout({
  status,
  statusAt,
  statusSticky,
  tone,
  muted = false,
  logOpen,
  onToggleLog
}: WorkspaceReadoutProps) {
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
  const shown = !quiet && !muted && status !== '';
  if (!shown) {
    return null;
  }
  return (
    <button
      type="button"
      className={`workspace-toast ${tone}`}
      title="Activity log"
      aria-label={`${logOpen ? 'Close' : 'Open'} activity log. Current status: ${status}`}
      aria-expanded={logOpen}
      onClick={onToggleLog}
    >
      <i aria-hidden="true" />
      <span role="status" aria-live="polite" aria-atomic="true">
        {status}
      </span>
    </button>
  );
}

interface ViewportDockExtrasProps {
  selectionFilter: SelectionFilter;
  selectionFilterIsAutomatic: boolean;
  onSelectionFilter(filter: SelectionFilter | null): void;
  /** Sketch snap spacing while a sketch is open; null hides it. */
  snap: { spacing: number; units: string; enabled: boolean } | null;
  logOpen: boolean;
  onToggleLog(): void;
  logTriggerRef: RefObject<HTMLButtonElement | null>;
}

/**
 * The dock's middle segments: the selection filter (click or Q cycles it),
 * the sketch snap, and the activity log's button.
 */
export function ViewportDockExtras({
  selectionFilter,
  selectionFilterIsAutomatic,
  onSelectionFilter,
  snap,
  logOpen,
  onToggleLog,
  logTriggerRef
}: ViewportDockExtrasProps) {
  const filterIndex = SELECTION_FILTERS.indexOf(selectionFilter);
  const nextFilter =
    SELECTION_FILTERS[(filterIndex + 1) % SELECTION_FILTERS.length]!;
  return (
    <>
      <span className="viewport-dock-divider" aria-hidden="true" />
      <button
        type="button"
        className={`viewport-dock-filter mono${selectionFilterIsAutomatic ? ' automatic' : ''}`}
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
        <span className="viewport-dock-snap mono">
          {snap.enabled ? `Snap ${snap.spacing} ${snap.units}` : 'Snap off'}
        </span>
      )}
      <button
        ref={logTriggerRef}
        type="button"
        className="viewport-dock-log"
        title="Activity log"
        aria-label={`${logOpen ? 'Close' : 'Open'} activity log`}
        aria-expanded={logOpen}
        onClick={onToggleLog}
      >
        <History size={14} aria-hidden="true" />
      </button>
      <span className="viewport-dock-divider" aria-hidden="true" />
    </>
  );
}
