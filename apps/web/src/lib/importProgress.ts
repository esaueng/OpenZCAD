/**
 * What an import is doing, in the four words the progress card shows.
 *
 * An import is a sequence of phases, three of which can report real progress
 * and one of which cannot: `kernel.importStep` is a single synchronous call
 * into wasm that blocks the worker thread it runs on, so it can post neither a
 * percentage nor a heartbeat. The whole point of the shape below is to carry
 * that distinction — {@link ImportRunProgress.fraction} is `null` for a phase
 * with nothing to report, and {@link importOverallFraction} holds the bar
 * still rather than inventing a number for it.
 */

export type ImportPhase = 'saving' | 'reading' | 'building' | 'archiving';

/** Plain words, not internals. The user does not care which kernel it is. */
export const IMPORT_PHASE_LABEL: Record<ImportPhase, string> = {
  saving: 'Saving to this device',
  reading: 'Reading the file',
  building: 'Building geometry',
  archiving: 'Archiving the original'
};

/**
 * Relative cost per phase, in milliseconds per megabyte, used only to divide
 * the bar between them. No number derived from these is ever shown: being
 * wrong makes the bar move unevenly, it cannot make it lie.
 *
 * Measured on 250 MB, except where noted:
 *  - `saving` — streamed blob read ~0.12 s plus SHA-256 ~0.2 s, so ~2 ms/MB
 *    of work this process can see. The IndexedDB write that follows is
 *    disk-bound and was not measured; 8 assumes it dominates the phase.
 *  - `reading` — text decode plus the header regex scan, ~0.15 s total. It is
 *    kept as its own phase because it is the truthful label for that moment,
 *    and its weight is deliberately small enough to be invisible in the bar.
 *  - `building` — 283 MB in about 7 s, from `scripts/profile-step-import.mjs`.
 *  - `archiving` — network, so the least certain of the four by far. Anywhere
 *    from 20 (fast link) to 100 (slow link) would be defensible.
 */
const PHASE_WEIGHT: Record<ImportPhase, number> = {
  saving: 8,
  reading: 1,
  building: 25,
  archiving: 40
};

export interface ImportRunProgress {
  phase: ImportPhase;
  /**
   * How far through the phase, 0–1 — or `null` when the phase cannot report,
   * which is a different statement from `0` and must survive as one.
   */
  fraction: number | null;
}

/**
 * `cancelled` is its own tone rather than a warning: the user asked for it, so
 * it is not a problem to flag, and like `ok` it takes itself off the screen
 * instead of waiting to be dismissed by someone who already knows.
 */
export type ImportOutcomeTone = 'ok' | 'cancelled' | 'warning' | 'error';

/** Endings the user does not need to acknowledge, so the card clears itself. */
export function importOutcomeIsQuiet(outcome: ImportRunOutcome): boolean {
  return outcome.tone === 'ok' || outcome.tone === 'cancelled';
}

export interface ImportRunOutcome {
  tone: ImportOutcomeTone;
  /** One line. The status bar carries the longer version. */
  message: string;
  /**
   * The only action an ending ever offers: the body imported but its source
   * never reached the cloud, so the project is not portable yet.
   */
  action?: 'archive';
}

export interface ImportRunState {
  /** New per run, so a second import replaces the card rather than merging. */
  id: string;
  fileName: string;
  /** The phases THIS run will pass through — a storage-denied session has no
   * `saving` phase at all, and the bar must divide over what will happen. */
  phases: readonly ImportPhase[];
  progress: ImportRunProgress;
  /**
   * The user has asked to stop, and the run has not finished unwinding yet.
   *
   * Not the same as an ending, and the gap between them is real rather than
   * cosmetic: a cancel during `building` cannot take effect until the kernel
   * returns from a wasm call that cannot be preempted, which on a large
   * assembly is minutes. The card says what is actually happening for that
   * whole stretch instead of freezing on a button that appears not to work.
   */
  cancelRequested: boolean;
  /** Null while running. Set once, and the card stops moving. */
  outcome: ImportRunOutcome | null;
}

/**
 * How long an import must run before the card appears.
 *
 * Deliberately measured from the start of the run rather than projected from
 * the file size: a projection would be wrong for a slow disk or a cold kernel,
 * and the only thing this threshold is for is keeping a panel from flashing
 * on screen for a third of a second and reading as noise.
 */
export const IMPORT_CARD_DELAY_MS = 600;

/** How long a successful card stays up before it takes itself away. */
export const IMPORT_CARD_SUCCESS_LINGER_MS = 4000;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * The single bar's width, 0–1.
 *
 * Phases already passed contribute their whole weight; the current phase
 * contributes its share of its own weight. A phase reporting `null` adds
 * nothing, which is what leaves the bar parked where the previous phase left
 * it while the kernel works — the card stripes it there to say so.
 */
export function importOverallFraction(
  phases: readonly ImportPhase[],
  progress: ImportRunProgress
): number {
  const index = phases.indexOf(progress.phase);
  if (index < 0) {
    return 0;
  }
  const total = phases.reduce((sum, phase) => sum + PHASE_WEIGHT[phase], 0);
  if (total <= 0) {
    return 0;
  }
  const behind = phases
    .slice(0, index)
    .reduce((sum, phase) => sum + PHASE_WEIGHT[phase], 0);
  const within =
    progress.fraction === null
      ? 0
      : clamp01(progress.fraction) * PHASE_WEIGHT[progress.phase];
  return clamp01((behind + within) / total);
}

/**
 * Drops updates too small to see, so a chatty source cannot flood the host.
 *
 * The read that backs the `saving` phase arrives in chunks — roughly four
 * thousand of them for a 250 MB file — and each one publishing into React
 * state would re-render the workspace four thousand times during an import.
 * A phase change or a move to or from "cannot report" always survives; only
 * a fractional step smaller than `minFractionStep` inside one phase is
 * dropped, and 5% of a phase is well under one pixel of the bar.
 *
 * Deliberately a step filter rather than a timer: no handle to leak, no
 * trailing update to lose, and a test can drive it without a clock.
 */
export function coalesceImportProgress(
  publish: (progress: ImportRunProgress) => void,
  options: { minFractionStep?: number } = {}
): (progress: ImportRunProgress) => void {
  const minFractionStep = options.minFractionStep ?? 0.05;
  let last: ImportRunProgress | null = null;
  return (progress) => {
    const sameShape =
      last !== null &&
      last.phase === progress.phase &&
      last.fraction !== null &&
      progress.fraction !== null;
    if (
      sameShape &&
      Math.abs((progress.fraction as number) - (last?.fraction as number)) <
        minFractionStep &&
      // The end of a phase always lands: parking the bar a step short of a
      // boundary it actually reached is the one visible error here.
      progress.fraction !== 1
    ) {
      return;
    }
    last = progress;
    publish(progress);
  };
}

/**
 * What an import reports as it goes. Presentation only: every method here may
 * be dropped without changing what lands in the document or on the device,
 * which is why {@link StepImportRunDeps} takes it as optional.
 */
export interface ImportProgressSink {
  start(input: {
    fileName: string;
    phases: readonly ImportPhase[];
  }): void;
  update(progress: ImportRunProgress): void;
  /** Terminal. Nothing is emitted for this run afterwards. */
  finish(outcome: ImportRunOutcome): void;
}
