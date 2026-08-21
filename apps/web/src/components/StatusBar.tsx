import { useCallback, useId, useRef, useState } from 'react';
import {
  SELECTION_FILTERS,
  SELECTION_FILTER_LABELS,
  type SelectionFilter
} from '@openzcad/viewport/types';
import { StatusActivityLog, type StatusTone } from './StatusActivityLog';
import type { WorkspaceSaveState } from '../lib/cloudProjectAutosave';
import { WORKSPACE_SAVE_STATE_PRESENTATION } from '../lib/workspaceSaveStatePresentation';

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
  saveState: WorkspaceSaveState;
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
  saveState,
  selectionFilter,
  selectionFilterIsAutomatic,
  onSelectionFilter
}: StatusBarProps) {
  const logPanelId = useId();
  const [logOpen, setLogOpen] = useState(false);
  const statusButtonRef = useRef<HTMLButtonElement | null>(null);
  const featureLabel = `${featureCount} ${featureCount === 1 ? 'feature' : 'features'}`;
  const bodyLabel = `${bodyCount} ${bodyCount === 1 ? 'body' : 'bodies'}`;
  const workspaceSummary = `${projectName ?? 'Project'} · ${featureLabel} · ${bodyLabel}`;
  const syncLabel = WORKSPACE_SAVE_STATE_PRESENTATION[saveState].statusBarLabel;
  const closeLog = useCallback((restoreFocus: boolean) => {
    setLogOpen(false);
    if (restoreFocus) {
      statusButtonRef.current?.focus();
    }
  }, []);

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
          {/* The status bar is where this app says what just happened —
              refusals, what a command did, which rung of the Escape ladder you
              are on — and it was the one major surface with no live region, so
              none of it reached a screen reader unless you happened to focus
              this button. Settings, the sharing dialog and tool cards all
              announce; this now does too. `aria-live` rather than
              `role="status"` so the button's own semantics are untouched, and
              `aria-atomic` so a changed message is read whole rather than
              diffed word by word. */}
          <span aria-live="polite" aria-atomic="true">
            {status}
          </span>
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
        {/* Only readouts that change stay: the kernel name never did, units
            already sit beside the project title, and the revision lives in
            this tooltip instead of its own slot. */}
        <div
          className="status-groups"
          role="group"
          aria-label="Workspace status"
        >
          <span>
            <b>warnings</b>
            {warningCount}
          </span>
          <span
            title={`${workspaceSummary} · rev ${documentVersion ?? '—'}`}
            aria-label={`${workspaceSummary}. Sync ${syncLabel}.`}
          >
            <b>sync</b>
            {syncLabel}
          </span>
        </div>
      </footer>
      <StatusActivityLog
        id={logPanelId}
        open={logOpen}
        status={status}
        tone={tone}
        triggerRef={statusButtonRef}
        onClose={closeLog}
      />
    </>
  );
}
