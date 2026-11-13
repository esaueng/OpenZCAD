import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { CircleHelp, Magnet, ScrollText } from 'lucide-react';
import type { WorkspaceSaveState } from '../lib/cloudProjectAutosave';
import { OVERLAY_EXIT_MS, useDelayedUnmount } from '../hooks/useDelayedUnmount';
import { usePacedStatus } from '../hooks/usePacedStatus';
import {
  advanceStatusClock,
  STATUS_CLOCK_STEP_MS,
  STATUS_LIFETIME_MS,
  statusExpiresAt
} from '../lib/statusLifetime';
import { WORKSPACE_SAVE_STATE_PRESENTATION } from '../lib/workspaceSaveStatePresentation';
import type { StatusTone } from './StatusActivityLog';
import { Tooltip } from './Tooltip';

/**
 * A message worth going back to the log for: a warning, or a refusal worded
 * as one ("Cannot use Box: …", "Not created — …") whatever its tone.
 */
const REFUSAL_PATTERN =
  /refus|cannot|can't|not created|not applied|not changed|no change/i;

function isNotableStatus(status: string, tone: StatusTone): boolean {
  return tone === 'warning' || REFUSAL_PATTERN.test(status);
}

/** Phones keep the guidance in the bar; its help glyph opens the whole text. */
const PHONE_QUERY = '(max-width: 520px)';

/**
 * Whether guidance is wider than the field it would read in. The probe is the
 * field's line laid out without being drawn: its text box is the room, its
 * ink the words. Unlaid out (a hidden lane, a test DOM) it has no room to
 * outgrow.
 */
function hintOutgrowsField(probe: HTMLElement): boolean {
  if (
    typeof window.matchMedia === 'function' &&
    window.matchMedia(PHONE_QUERY).matches
  ) {
    return false;
  }
  // The line's box, and the inline run of words inside it: the box is cut
  // to the room, the run never is.
  const line = probe.firstElementChild;
  const room = line?.getBoundingClientRect().width;
  const ink = line?.firstElementChild?.getBoundingClientRect().width;
  if (!room || !ink) return false;
  // A hair of slack: the ellipsis appears as soon as the ink overflows at
  // all, and sub-pixel layout rounds either way.
  return ink > room - 0.5;
}

interface WorkspaceReadoutProps {
  status: string;
  statusAt?: number;
  statusSticky?: boolean;
  statusImmediate?: boolean;
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
  /** Opens Settings › Activity log. */
  onOpenLog(): void;
  /**
   * The context-sensitive next-step line the status bar showed beside the
   * message: what a click takes, what Escape does next. The tool card and the
   * selection dock carry it visually now; it stays here for assistive tech.
   */
  prompt: string | null;
  /**
   * The prompt is the idle bar's resting line ("Search commands · ? shortcuts")
   * rather than guidance: it stays in the field at any width, where a card
   * over the bar would only repeat the bar's own name.
   */
  promptResting?: boolean;
  /** Additional measurement guidance, exposed with the full instructions. */
  instructionDetails?: string | null;
  /**
   * What is picked: its name and key measurement, read at the head of the
   * bar's guidance line. It stays while a status message has the toast,
   * which only the guidance makes way for.
   */
  pick?: ReactNode;
  /**
   * A refused edit with no control open to explain it (a refused drag): the
   * compact "Not built · Why?", read after the pick and before the key hints.
   */
  notice?: ReactNode;
  /**
   * U09: an in-place command's bar. It takes the guidance row while a
   * command runs, so its step is read where every hint is.
   */
  commandRow?: ReactNode;
  /**
   * The workspace summary the status bar carried for assistive tech: project,
   * feature and body counts, warnings and sync state. Kept as an
   * off-screen group so screen readers (and the specs) still have it.
   */
  projectName: string | null;
  featureCount: number;
  /** Visible committed bodies; consumed sources and previews are excluded. */
  bodyCount: number;
  previewActive?: boolean;
  warningCount: number;
  documentVersion: number | null;
  saveState: WorkspaceSaveState;
  /**
   * The command bar at the foot of the stage: the one place to search
   * commands or ask the assistant, under the guidance line.
   */
  searchBar: ReactNode;
  /**
   * The toast that is up and the status entry (its `statusAt` stamp) it
   * restates, or null. That status, and only that one, steps aside for good
   * rather than returning for a moment as the toast leaves. Any other status
   * (set before or after, or under a toast that restates none) keeps its
   * lifetime.
   */
  repeatingToast?: { toastId: number; statusAt: number } | null;
}

/**
 * What the status bar said, as a toast above the viewport dock: the live
 * message while it has its lifetime, nothing once it has gone quiet. It is
 * also a handle for the activity log, a page in Settings.
 */
export function WorkspaceReadout({
  status,
  statusAt,
  statusSticky,
  statusImmediate = false,
  geometryStatus = null,
  tone,
  muted = false,
  onOpenLog,
  prompt,
  promptResting = false,
  instructionDetails = null,
  pick = null,
  notice = null,
  commandRow = null,
  projectName,
  featureCount,
  bodyCount,
  previewActive = false,
  warningCount,
  documentVersion,
  saveState,
  searchBar,
  repeatingToast = null
}: WorkspaceReadoutProps) {
  const laneRef = useRef<HTMLDivElement>(null);
  const hasCommandRow = commandRow !== null;
  const hasSelectionGuidance =
    !hasCommandRow && (pick !== null || notice !== null);
  // Guidance too long for the field stands on a card over the bar, in the
  // pick's place (measured below, once the toast's state is known).
  const [raised, setRaised] = useState(false);
  const hasGuidanceCard = hasSelectionGuidance || (!hasCommandRow && raised);
  useLayoutEffect(() => {
    const lane = laneRef.current;
    const viewer = lane?.closest<HTMLElement>('.viewer-area');
    if (!lane || !viewer || (!hasCommandRow && !hasGuidanceCard)) return;
    const measure = () => {
      const command = lane.querySelector<HTMLElement>('.in-place-command');
      const height = command?.getBoundingClientRect().height ?? 0;
      if (height > 0) {
        viewer.style.setProperty(
          '--in-place-command-h',
          `${Math.ceil(height)}px`
        );
      }
      const guidance = lane.querySelector<HTMLElement>(
        '.workspace-hint.is-selection, .workspace-hint.is-raised'
      );
      // The gap belongs to a row that is drawn. A guidance element with no
      // height (the pick's row while an operation is armed) still added it,
      // and the notice lane stood 8px up, over the handle's value chip.
      const guidanceHeight = guidance
        ? Math.ceil(guidance.getBoundingClientRect().height)
        : 0;
      viewer.style.setProperty(
        '--workspace-guidance-h',
        `${guidanceHeight > 0 ? guidanceHeight + 8 : 0}px`
      );
    };
    measure();
    // Watching the lane also handles a lazy command replacing its fallback,
    // extra actions wrapping, and the viewport narrowing during a command.
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    observer?.observe(lane);
    return () => {
      observer?.disconnect();
      viewer.style.removeProperty('--in-place-command-h');
      viewer.style.removeProperty('--workspace-guidance-h');
    };
  }, [hasCommandRow, hasGuidanceCard]);
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
  // A settled message an action toast already said ("Deleted Boss bore."
  // under "Deleted Boss bore · Undo") is spent: it used to come back for a
  // beat as the toast faded, and the toast jumped up its row and down again.
  // Which status a toast repeats is fixed when that status is set (App
  // records its stamp), so a toast raised later, or a status set while it is
  // up, never retires a status it does not restate.
  const repeated =
    repeatingToast !== null &&
    statusAt !== undefined &&
    repeatingToast.statusAt === statusAt;
  // Recorded while the toast is up, whatever the tone: after a delete the
  // model is still rebuilding when the toast is raised, and a toast dismissed
  // before the rebuild settled left nothing to retire the repeat later.
  const [spentAt, setSpentAt] = useState<number | null>(null);
  useEffect(() => {
    if (repeated && statusAt !== undefined) setSpentAt(statusAt);
  }, [repeated, statusAt]);
  const expired =
    statusAt !== undefined &&
    !sticky &&
    (statusAt === 0 ||
      statusAt === expiredAtMount ||
      statusAt === expiredAt ||
      (statusAt === spentAt && !repeated));
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
  const paced = usePacedStatus(
    line,
    tone,
    shown,
    isNotableStatus,
    statusImmediate
  );
  // Only what the user would go back for earns a counter: rebuild stages
  // and saves passed over in a burst are routine, and "10 more in log"
  // after adding one box sent people looking for a problem there was not.
  const missed =
    paced.skipped > 0
      ? `${paced.skipped} ${paced.skipped === 1 ? 'warning' : 'warnings'}`
      : null;
  // A retired or expired message leaves the bar reading as nothing happening,
  // but only once its fade has run: emptied at the fade's first frame, the
  // pill snapped to a bare dot and then faded.
  const fading = useDelayedUnmount(
    quiet ? null : paced.status,
    OVERLAY_EXIT_MS
  );
  const shownStatus = quiet ? (fading.rendered ?? '') : paced.status;
  const featureLabel = `${featureCount} ${featureCount === 1 ? 'feature' : 'features'}`;
  const bodyLabel = `${bodyCount} ${bodyCount === 1 ? 'body' : 'bodies'}`;
  const workspaceSummary = `${projectName ?? 'Project'} · ${featureLabel} · ${bodyLabel}`;
  const syncLabel = WORKSPACE_SAVE_STATE_PRESENTATION[saveState].statusBarLabel;
  const hasGuidance =
    commandRow == null && Boolean((prompt && !shown) || pick || notice);
  // Mirrors `.workspace-hint.is-selection` below as a lane class, so the
  // stylesheet need not ask `:has()`: that rule restyled the whole workspace
  // on every chip update during a drag.
  const hasSelectionHint = commandRow == null && Boolean(notice || pick);
  // Guidance alone in the field, where the placeholder would be: the one
  // case with a width to outgrow. A pick or a notice already has the card.
  const fieldPrompt =
    commandRow == null && !notice && !pick && prompt && !shown ? prompt : null;
  const probedPrompt = promptResting ? null : fieldPrompt;
  const probeRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const probe = probeRef.current;
    if (!probe || probedPrompt === null) {
      setRaised(false);
      return;
    }
    const measure = () => setRaised(hintOutgrowsField(probe));
    measure();
    // The bar narrows with the window and the docks, and loses its key badge
    // under 360px: the probe is laid out as the field's line is, so watching
    // it follows all three.
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    observer?.observe(probe);
    return () => observer?.disconnect();
  }, [probedPrompt]);
  const hintRaised = raised && probedPrompt !== null;
  // Always in the tree, as the page's contentinfo landmark: what the status
  // bar used to be for assistive tech and for the specs that read it. Only
  // its visibility changes.
  return (
    <>
      {/* The foot of the stage: one line of guidance over the search bar,
          led by what is picked. The guidance is the prompt the summary below
          already carries for assistive tech, so it is drawn here but hidden
          from the tree; a live status message takes its place while the
          toast is up. */}
      <div
        className={`command-bar-lane${hasGuidance ? ' has-guidance' : ''}${
          hasSelectionHint || hintRaised ? ' has-selection-hint' : ''
        }`}
        ref={laneRef}
      >
        {commandRow ??
          (notice ? (
            // A block, not the hint's paragraph: the notice holds buttons and
            // an explanation that opens above the row.
            <div className="workspace-hint is-selection has-notice">
              {pick}
              {notice}
              {prompt && !shown ? (
                <span className="workspace-hint-text" aria-hidden="true">
                  {prompt}
                </span>
              ) : null}
            </div>
          ) : (prompt && !shown) || pick ? (
            <p
              className={`workspace-hint${
                pick ? ' is-selection' : hintRaised ? ' is-raised' : ''
              }`}
            >
              {pick}
              {prompt && !shown ? (
                <span className="workspace-hint-text" aria-hidden="true">
                  {prompt}
                </span>
              ) : null}
            </p>
          ) : null)}
        {searchBar}
        {probedPrompt !== null && (
          // The field's line, laid out and never drawn: whether the guidance
          // fits it is read here, so the answer does not depend on which of
          // the two places the guidance is standing in, or on the bar being
          // open and the line hidden.
          <span
            className="workspace-hint-probe"
            aria-hidden="true"
            ref={probeRef}
          >
            <span className="workspace-hint-text">
              <span>{probedPrompt}</span>
            </span>
          </span>
        )}
        {!commandRow && prompt && (
          <details
            className="workspace-hint-help"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && event.currentTarget.open) {
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.open = false;
              }
            }}
          >
            <summary aria-label="Operation instructions">
              <CircleHelp size={15} aria-hidden="true" />
            </summary>
            <p>
              {prompt}
              {instructionDetails && (
                <>
                  <br />
                  <br />
                  {instructionDetails}
                </>
              )}
            </p>
          </details>
        )}
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
              ? 'Open activity log.'
              : `Open activity log. Current status: ${line}`
          }
          aria-haspopup="dialog"
          onClick={onOpenLog}
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
            aria-label={`${workspaceSummary}. Sync ${syncLabel}.${previewActive ? ' Preview active, not applied.' : ''}`}
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
  /** Opens Settings › Activity log. */
  onOpenLog(): void;
}

/**
 * The activity log's button, on the instrument rail with the other panels.
 * It used to close the bottom-left readout, which made that island as wide
 * as the column for one chip and one icon; here it sits with Objects, History
 * and Parameters, which is what it is: a panel about the model.
 */
export function ActivityLogButton({ onOpenLog }: ActivityLogButtonProps) {
  return (
    <Tooltip
      label="Activity log"
      description="Every status message and warning this session"
    >
      <button
        type="button"
        className="rail-button"
        aria-label="Open activity log"
        aria-haspopup="dialog"
        onClick={onOpenLog}
      >
        {/* Not the clock: that is rollback and Restore, one rail up from here. */}
        <ScrollText size={16} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

interface ViewportDockExtrasProps {
  /** Sketch snap spacing while a sketch is open; null hides it. */
  snap: { spacing: number; units: string; enabled: boolean } | null;
}

/**
 * The readout's segments: the sketch snap, beside the grid spacing. The
 * island hugs them, so it is as wide as what it says, and with no sketch
 * open it says nothing and does not draw. (The selection filter it used to
 * lead with is Q's alone now; the status line names each choice.)
 */
export function ViewportDockExtras({ snap }: ViewportDockExtrasProps) {
  return (
    <>
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
