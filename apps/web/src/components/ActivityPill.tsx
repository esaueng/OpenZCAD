import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import {
  IMPORT_CARD_DELAY_MS,
  IMPORT_CARD_SUCCESS_LINGER_MS,
  IMPORT_PHASE_LABEL,
  JOB_WORDS,
  importOutcomeIsQuiet,
  importOverallFraction,
  type ImportRunState
} from '../lib/importProgress';
import { StableLabel } from './StableLabel';

interface ActivityPillProps {
  /** The run to report, or null when there is none. */
  run: ImportRunState | null;
  /**
   * Takes the pill away. The run itself is unaffected. `shown` says whether
   * the pill was ever on screen: a quiet ending inside the delay window
   * never was, and the host must not tidy up after a notice nobody saw.
   */
  onDismiss(shown: boolean): void;
  /** Retries the upload of a source that only reached this device. */
  onArchiveNow(): void;
  /** Stops the run at the next point it can stop. */
  onCancel(): void;
}

/**
 * Elapsed time, in the shortest form that stays readable.
 *
 * Tenths below ten seconds so the number is visibly moving in the stretch
 * where the question is "did this do anything at all", whole seconds above
 * that, and minutes past sixty — a 250 MB assembly can run for several, and
 * "312 s" is a worse answer than "5:12".
 */
export function elapsedLabel(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  if (total < 10) {
    return `${total.toFixed(1)} s`;
  }
  if (total < 60) {
    return `${Math.round(total)} s`;
  }
  const minutes = Math.floor(total / 60);
  const seconds = Math.round(total % 60);
  // 59.7 s rounds to 60, which must read as the next minute rather than ":60".
  return seconds === 60
    ? `${minutes + 1}:00`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * One line, in the lane above the viewport dock, for any job that moves a
 * file in or out: what it is doing, to which file, for how long, and the one
 * control that matters. The progress bar is the pill's bottom edge.
 *
 * It shares the lane with the status toast and takes it over while it is
 * up, so a running import never has two notices describing it in two
 * vocabularies. The clock lives here rather than in the workspace on
 * purpose: it ticks ten times a second, and state that ticks in `App` would
 * re-render the editor around the viewport for the whole length of a run.
 */
export function ActivityPill({
  run,
  onDismiss,
  onArchiveNow,
  onCancel
}: ActivityPillProps) {
  const runId = run?.id ?? null;
  const outcome = run?.outcome ?? null;
  const startedAtRef = useRef(0);
  const [elapsed, setElapsed] = useState(0);
  const [delayPassed, setDelayPassed] = useState(false);

  useEffect(() => {
    if (!runId) {
      return;
    }
    startedAtRef.current = performance.now();
    setElapsed(0);
    setDelayPassed(false);
  }, [runId]);

  useEffect(() => {
    if (!runId || outcome) {
      return;
    }
    const timer = window.setInterval(() => {
      const ms = performance.now() - startedAtRef.current;
      setElapsed(ms);
      if (ms >= IMPORT_CARD_DELAY_MS) {
        setDelayPassed(true);
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [runId, outcome]);

  // The interval stops on the tick before the run settles, so the final
  // reading would otherwise be up to 100 ms short of the truth.
  useEffect(() => {
    if (!runId || !outcome) {
      return;
    }
    setElapsed(performance.now() - startedAtRef.current);
  }, [runId, outcome]);

  useEffect(() => {
    if (!runId || !outcome || !importOutcomeIsQuiet(outcome)) {
      return;
    }
    // A quiet ending that arrived before the pill was worth showing clears
    // its run state at once; nothing lingers because nothing was shown.
    if (!delayPassed) {
      onDismiss(false);
      return;
    }
    const timer = window.setTimeout(
      () => onDismiss(true),
      IMPORT_CARD_SUCCESS_LINGER_MS
    );
    return () => window.clearTimeout(timer);
  }, [runId, outcome, delayPassed, onDismiss]);

  if (!run) {
    return null;
  }

  // A run that fails or degrades inside the delay window still has something
  // the user needs; a quiet ending — a success, or a cancel the user asked
  // for — is allowed to pass in silence.
  const needsAttention = outcome !== null && !importOutcomeIsQuiet(outcome);
  if (!delayPassed && !needsAttention) {
    return null;
  }

  const words = JOB_WORDS[run.kind];
  // The bar completes only when the file actually landed. A refusal, a
  // superseded rebuild, or a cancel leaves it exactly where it stopped, which
  // says the file was stored and read and something later is what stopped it.
  const landed = outcome?.landed === true;
  const fraction = landed ? 1 : importOverallFraction(run.phases, run.progress);
  // Striped, and parked: running, extent unknown. Never a creeping number.
  const indeterminate = outcome === null && run.progress.fraction === null;
  // A requested cancel that has not taken effect yet is its own state, and the
  // pill says so while worker termination and source cleanup unwind.
  const cancelling = outcome === null && run.cancelRequested;
  const verb = !outcome
    ? words.running
    : outcome.tone === 'cancelled'
      ? words.cancelled
      : landed
        ? words.done
        : words.refused;
  const detail = outcome
    ? outcome.message
    : cancelling
      ? 'Cancelling…'
      : IMPORT_PHASE_LABEL[run.progress.phase];
  const toneClass = outcome ? ` ${outcome.tone}` : '';
  const jobLabel = `${words.running.toLowerCase()} ${run.fileName}`;

  return (
    <section
      className={`activity-pill${toneClass}`}
      aria-label={`File ${run.kind}`}
    >
      <span className="activity-pill-glyph" aria-hidden="true">
        {outcome ? (
          <i className={`activity-dot ${outcome.tone}`} />
        ) : (
          <i className="activity-spin" />
        )}
      </span>
      {/* Only the verb, name and detail are announced. The clock is a sibling
          because a live region containing it would be read aloud ten times a
          second. */}
      <span className="activity-pill-text" aria-live="polite">
        <span className="activity-pill-verb">{verb} </span>
        <span className="activity-pill-name" title={run.fileName}>
          {run.fileName}
        </span>
        <span className={`activity-pill-detail${toneClass}`}>{detail}</span>
      </span>
      {outcome === null && (
        <span className="activity-pill-time">{elapsedLabel(elapsed)}</span>
      )}
      {outcome?.action === 'archive' && (
        <>
          <span className="activity-pill-sep" aria-hidden="true" />
          <button
            type="button"
            className="activity-pill-action"
            onClick={onArchiveNow}
          >
            Archive now
          </button>
        </>
      )}
      {/* Its own control rather than a second meaning for the ✕. Those two
          want opposite things — one clears the pill, one throws away minutes
          of work — and putting both on one glyph makes the destructive one
          reachable by accident. */}
      {outcome === null && run.cancellable && (
        <>
          <span className="activity-pill-sep" aria-hidden="true" />
          <button
            type="button"
            className="activity-pill-cancel"
            disabled={cancelling}
            title={`Stop ${jobLabel}. Nothing will be changed.`}
            onClick={onCancel}
          >
            <StableLabel reserve={['Cancelling…', 'Cancel']} align="center">
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </StableLabel>
          </button>
        </>
      )}
      {needsAttention && (
        <button
          type="button"
          className="activity-pill-close"
          title="Dismiss"
          aria-label={`Dismiss ${run.kind} status`}
          onClick={() => onDismiss(true)}
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
      <span
        className={`activity-pill-bar${indeterminate ? ' indeterminate' : ''}${toneClass}`}
        aria-hidden="true"
      >
        <i style={{ width: `${Math.round(fraction * 100)}%` }} />
      </span>
    </section>
  );
}
