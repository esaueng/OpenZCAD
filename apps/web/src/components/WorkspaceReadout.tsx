import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { Magnet, MousePointer2, ScrollText } from 'lucide-react';
import {
  SELECTION_FILTERS,
  SELECTION_FILTER_LABELS,
  type SelectionFilter
} from '@openzcad/viewport/types';
import type { WorkspaceSaveState } from '../lib/cloudProjectAutosave';
import { usePacedStatus } from '../hooks/usePacedStatus';
import {
  advanceStatusClock,
  STATUS_CLOCK_STEP_MS,
  STATUS_LIFETIME_MS,
  statusExpiresAt
} from '../lib/statusLifetime';
import { WORKSPACE_SAVE_STATE_PRESENTATION } from '../lib/workspaceSaveStatePresentation';
import type { StatusTone } from './StatusActivityLog';

/**
 * A message worth going back to the log for: a warning, or a refusal worded
 * as one ("Cannot use Box: …", "Not created — …") whatever its tone.
 */
const REFUSAL_PATTERN = /refus|cannot|can't|not created|not applied|no change/i;

function isNotableStatus(status: string, tone: StatusTone): boolean {
  return tone === 'warning' || REFUSAL_PATTERN.test(status);
}

interface WorkspaceReadoutProps {
  status: string;
  statusAt?: number;
  statusSticky?: boolean;
  /**
   * The exact-geometry line while the model is not ready: the worker phase
   * and what the viewport shows meanwhile. A state rather than a message, it
   * never expires. A live message is drawn in front of it, never hidden
   * behind it: a project open or a refused shortcut during a slow worker
   * start used to expire unseen behind this line.
   */
  geometryStatus?: { phase: string; projection: string } | null;
  tone: StatusTone;
  /** A tool card is up and carries the message itself. */
  muted?: boolean;
  logOpen: boolean;
  onToggleLog(): void;
  /**
   * The context-sensitive next-step line the status bar showed beside the
   * message: what a click takes, what Escape does next. The tool card and the
   * selection dock carry it visually now; it stays here for assistive tech.
   */
  prompt: string | null;
  /**
   * The workspace summary the status bar carried for assistive tech: project,
   * feature and body counts, warnings and sync state. Kept as an
   * off-screen group so screen readers (and the specs) still have it.
   */
  projectName: string | null;
  featureCount: number;
  bodyCount: number;
  warningCount: number;
  documentVersion: number | null;
  saveState: WorkspaceSaveState;
  /**
   * The command bar at the foot of the stage: the one place to search
   * commands or ask the assistant, under the guidance line.
   */
  searchBar: ReactNode;
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
  geometryStatus = null,
  tone,
  muted = false,
  logOpen,
  onToggleLog,
  prompt,
  projectName,
  featureCount,
  bodyCount,
  warningCount,
  documentVersion,
  saveState,
  searchBar
}: WorkspaceReadoutProps) {
  const sticky = statusSticky ?? false;
  // A message already past its lifetime when the readout mounts — entering
  // the workspace long after it was set — is not news, and stays gone.
  const [expiredAtMount] = useState(() => {
    if (statusAt === undefined) {
      return null;
    }
    const expiry = statusExpiresAt({ at: statusAt, sticky });
    return expiry !== null && Date.now() >= expiry ? statusAt : null;
  });
  // The lifetime is counted in steps on the page's own timers, so time the
  // page could not draw — a viewer frame holding the main thread — does not
  // use it up (lib/statusLifetime).
  const [expiredAt, setExpiredAt] = useState<number | null>(null);
  useEffect(() => {
    if (
      statusAt === undefined ||
      statusAt === 0 ||
      statusAt === expiredAtMount ||
      sticky
    ) {
      return;
    }
    let elapsed = 0;
    let countedAt = statusAt;
    const count = () => {
      const now = Date.now();
      elapsed = advanceStatusClock(elapsed, now - countedAt);
      countedAt = now;
      return elapsed >= STATUS_LIFETIME_MS;
    };
    if (count()) {
      setExpiredAt(statusAt);
      return;
    }
    const timer = window.setInterval(() => {
      if (count()) {
        window.clearInterval(timer);
        setExpiredAt(statusAt);
      }
    }, STATUS_CLOCK_STEP_MS);
    return () => window.clearInterval(timer);
  }, [statusAt, sticky, expiredAtMount]);
  const expired =
    statusAt !== undefined &&
    !sticky &&
    (statusAt === 0 || statusAt === expiredAtMount || statusAt === expiredAt);
  const messageLive = !expired && status !== '';
  // The geometry line is the floor under the message: it carries the live
  // message ahead of the phase, and the projection note once it has gone.
  const line = geometryStatus
    ? messageLive
      ? `${status} · ${geometryStatus.phase}`
      : `${geometryStatus.phase} · ${geometryStatus.projection}`
    : status;
  const quiet = geometryStatus === null && expired;
  const shown = !quiet && !muted && line !== '';
  // The log keeps every message; the toast holds each long enough to read.
  const paced = usePacedStatus(line, tone, shown, isNotableStatus);
  // Only what the user would go back for earns a counter: rebuild stages
  // and saves passed over in a burst are routine, and "10 more in log"
  // after adding one box sent people looking for a problem there was not.
  const missed =
    paced.skipped > 0
      ? `${paced.skipped} ${paced.skipped === 1 ? 'warning' : 'warnings'}`
      : null;
  // A retired or expired message leaves the bar reading as nothing happening.
  const shownStatus = quiet ? '' : paced.status;
  const featureLabel = `${featureCount} ${featureCount === 1 ? 'feature' : 'features'}`;
  const bodyLabel = `${bodyCount} ${bodyCount === 1 ? 'body' : 'bodies'}`;
  const workspaceSummary = `${projectName ?? 'Project'} · ${featureLabel} · ${bodyLabel}`;
  const syncLabel = WORKSPACE_SAVE_STATE_PRESENTATION[saveState].statusBarLabel;
  // Always in the tree, as the page's contentinfo landmark: what the status
  // bar used to be for assistive tech and for the specs that read it. Only
  // its visibility changes.
  return (
    <>
      {/* The foot of the stage: one line of guidance over the search bar.
          The guidance is the prompt the summary below already carries for
          assistive tech, so it is drawn here but hidden from the tree; a live
          status message takes its place while the toast is up. */}
      <div className="command-bar-lane">
        {prompt && !shown ? (
          <p className="workspace-hint" aria-hidden="true">
            {prompt}
          </p>
        ) : null}
        {searchBar}
      </div>
      <footer
        className={`workspace-toast ${paced.tone}${shown ? '' : ' hidden'}`}
        role="contentinfo"
      >
        <button
          type="button"
          className={`workspace-toast-body${quiet ? ' quiet' : ''}`}
          // Faded out, it was an invisible tab stop that opened the log. The
          // rail's log button stays the keyboard path.
          tabIndex={shown ? undefined : -1}
          title={
            quiet
              ? 'View activity log'
              : missed
                ? `${paced.status} — ${missed} in the activity log`
                : `${paced.status} — View activity log`
          }
          aria-label={
            quiet || line === ''
              ? `${logOpen ? 'Close' : 'Open'} activity log.`
              : `${logOpen ? 'Close' : 'Open'} activity log. Current status: ${line}`
          }
          aria-expanded={logOpen}
          onClick={onToggleLog}
        >
          <i aria-hidden="true" />
          <span role="status" aria-live="polite" aria-atomic="true">
            {shownStatus}
          </span>
          {/* Says what it counts: a bare "+11" after every status read as
              jargon. The title above carries the same for the tooltip. */}
          {shown && missed ? (
            <span className="workspace-toast-more" aria-hidden="true">
              {missed} in log
            </span>
          ) : null}
        </button>
        <div
          className="workspace-status-summary"
          role="group"
          aria-label="Workspace status"
        >
          {prompt && <span>{prompt}</span>}
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
    </>
  );
}

interface ActivityLogButtonProps {
  logOpen: boolean;
  onToggleLog(): void;
  logTriggerRef: RefObject<HTMLButtonElement | null>;
}

/**
 * The activity log's button, on the instrument rail with the other panels.
 * It used to close the bottom-left readout, which made that island as wide
 * as the column for one chip and one icon; here it sits with Items, History
 * and Parameters, which is what it is: a panel about the model.
 */
export function ActivityLogButton({
  logOpen,
  onToggleLog,
  logTriggerRef
}: ActivityLogButtonProps) {
  return (
    <button
      ref={logTriggerRef}
      type="button"
      className={`rail-button${logOpen ? ' active' : ''}`}
      title="Activity log"
      aria-label={`${logOpen ? 'Close' : 'Open'} activity log`}
      aria-expanded={logOpen}
      onClick={onToggleLog}
    >
      {/* Not the clock: that is rollback and Restore, one rail up from here. */}
      <ScrollText size={16} aria-hidden="true" />
    </button>
  );
}

interface ViewportDockExtrasProps {
  selectionFilter: SelectionFilter;
  selectionFilterIsAutomatic: boolean;
  onSelectionFilter(filter: SelectionFilter | null): void;
  /** Sketch snap spacing while a sketch is open; null hides it. */
  snap: { spacing: number; units: string; enabled: boolean } | null;
}

/**
 * The readout's segments: the selection filter (click or Q cycles it) and
 * the sketch snap. The island hugs them, so it is as wide as what it says.
 */
export function ViewportDockExtras({
  selectionFilter,
  selectionFilterIsAutomatic,
  onSelectionFilter,
  snap
}: ViewportDockExtrasProps) {
  const filterIndex = SELECTION_FILTERS.indexOf(selectionFilter);
  const nextFilter =
    SELECTION_FILTERS[(filterIndex + 1) % SELECTION_FILTERS.length]!;
  // The cycle ends by handing the filter back to the tool (null), as the
  // status bar's chips did when their active one was clicked again.
  const handsBack = filterIndex === SELECTION_FILTERS.length - 1;
  return (
    <>
      <span className="viewport-dock-divider" aria-hidden="true" />
      <button
        type="button"
        className={`viewport-dock-filter mono${selectionFilterIsAutomatic ? ' automatic' : ''}`}
        title={
          selectionFilterIsAutomatic
            ? `Selecting ${SELECTION_FILTER_LABELS[selectionFilter].toLowerCase()} — chosen by the active tool · Q cycles`
            : handsBack
              ? `Selecting ${SELECTION_FILTER_LABELS[selectionFilter].toLowerCase()} · click to hand the filter back to the tool`
              : `Selecting ${SELECTION_FILTER_LABELS[selectionFilter].toLowerCase()} · click or Q for ${SELECTION_FILTER_LABELS[nextFilter].toLowerCase()}`
        }
        aria-label={`Selection filter: ${SELECTION_FILTER_LABELS[selectionFilter]}. Cycle.`}
        onClick={() => onSelectionFilter(handsBack ? null : nextFilter)}
      >
        <MousePointer2
          className="viewport-readout-icon"
          size={12}
          aria-hidden="true"
        />
        <span className="viewport-dock-filter-label">select</span>
        {SELECTION_FILTER_LABELS[selectionFilter]}
      </button>
      {snap && (
        <span
          className="viewport-dock-snap mono"
          title={
            snap.enabled
              ? `Sketch snap: ${snap.spacing} ${snap.units}`
              : 'Sketch snap: off'
          }
        >
          <Magnet
            className="viewport-readout-icon"
            size={12}
            aria-hidden="true"
          />
          <span className="viewport-readout-word">Snap </span>
          {snap.enabled ? `${snap.spacing} ${snap.units}` : 'off'}
        </span>
      )}
      <span className="viewport-dock-divider" aria-hidden="true" />
    </>
  );
}
