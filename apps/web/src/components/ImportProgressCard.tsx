import { useEffect, useRef, useState } from 'react';
import {
  IMPORT_CARD_DELAY_MS,
  IMPORT_CARD_SUCCESS_LINGER_MS,
  IMPORT_PHASE_LABEL,
  importOutcomeIsQuiet,
  importOverallFraction,
  type ImportRunState
} from '../lib/importProgress';

interface ImportProgressCardProps {
  /** The import to report, or null when there is none. */
  run: ImportRunState | null;
  /** Takes the card away. The import itself is unaffected. */
  onDismiss(): void;
  /** Retries the upload of a source that only reached this device. */
  onArchiveNow(): void;
  /** Stops the import at the next point it can stop. */
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
 * The one thing an import shows while it runs: what file, what it is doing,
 * how long it has been doing it, and a bar that never claims progress it
 * cannot see.
 *
 * The clock lives here rather than in the workspace on purpose. It ticks ten
 * times a second, and state that ticks in `App` would re-render the editor
 * around the viewport for the whole length of an import; here it re-renders
 * three spans.
 */
export function ImportProgressCard({
  run,
  onDismiss,
  onArchiveNow,
  onCancel
}: ImportProgressCardProps) {
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
    const timer = window.setTimeout(onDismiss, IMPORT_CARD_SUCCESS_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [runId, outcome, onDismiss]);

  if (!run) {
    return null;
  }

  // An import that fails or degrades inside the delay window still has
  // something the user needs; a quiet ending — a success, or a cancel the
  // user asked for — is allowed to pass in silence.
  const needsAttention = outcome !== null && !importOutcomeIsQuiet(outcome);
  if (!delayPassed && !needsAttention) {
    return null;
  }

  // The bar completes only when a body actually landed. A refusal, a
  // superseded rebuild, or a cancel leaves it exactly where it stopped, which
  // says the file was stored and read and something later is what stopped it.
  const bodyLanded =
    outcome !== null &&
    (outcome.tone === 'ok' || outcome.action === 'archive');
  const fraction = bodyLanded
    ? 1
    : importOverallFraction(run.phases, run.progress);
  // Striped, and parked: running, extent unknown. Never a creeping number.
  const indeterminate = outcome === null && run.progress.fraction === null;
  // A requested cancel that has not taken effect yet is its own state, and the
  // card says so while worker termination and source cleanup unwind.
  const cancelling = outcome === null && run.cancelRequested;
  const line = outcome
    ? outcome.message
    : cancelling
      ? 'Cancelling…'
      : IMPORT_PHASE_LABEL[run.progress.phase];
  const toneClass = outcome ? ` ${outcome.tone}` : '';

  return (
    <section className="import-card" aria-label="File import">
      <div className="import-card-head">
        <span className="import-card-glyph" aria-hidden="true">
          {outcome ? <i className={`import-dot ${outcome.tone}`} /> : <i className="import-spin" />}
        </span>
        <span className="import-card-name" title={run.fileName}>
          {run.fileName}
        </span>
        <button
          type="button"
          className="import-card-close"
          // While the import is running this hides the card and nothing else.
          title={
            outcome
              ? 'Dismiss'
              : 'Hide this card. The import keeps running.'
          }
          aria-label={
            outcome ? 'Dismiss import status' : 'Hide import progress'
          }
          onClick={onDismiss}
        >
          ✕
        </button>
      </div>
      <p className={`import-card-line${toneClass}`}>
        {/* Only the phase is announced. The clock is a sibling because a live
            region containing it would be read aloud ten times a second. */}
        <span aria-live="polite">{line}</span>
        <span className="import-card-time">{elapsedLabel(elapsed)}</span>
      </p>
      <div
        className={`import-card-bar${indeterminate ? ' indeterminate' : ''}${toneClass}`}
        aria-hidden="true"
      >
        <i style={{ width: `${Math.round(fraction * 100)}%` }} />
      </div>
      {outcome?.action === 'archive' && (
        <button
          type="button"
          className="import-card-action"
          onClick={onArchiveNow}
        >
          Archive now
        </button>
      )}
      {/* Its own control, in the same slot the archive retry uses, rather than
          a second meaning for the ✕. Those two want opposite things — one
          clears the panel, one throws away minutes of work — and putting both
          on one glyph makes the destructive one reachable by accident. */}
      {outcome === null && (
        <button
          type="button"
          className="import-card-action cancel"
          disabled={cancelling}
          title="Stop the import. Nothing will be added to your model."
          onClick={onCancel}
        >
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </button>
      )}
    </section>
  );
}
