import { useEffect, useRef, useState } from 'react';
import { TriangleAlert, LoaderCircle, Ruler } from 'lucide-react';
import {
  unitsConvertCheckpointName,
  unitsConvertValueCount,
  type ConvertibleUnit,
  type UnitsConversionReport,
  type UnitsConversionWarning,
  type UnitsConvertRefusal
} from '@openzcad/document-core';
import type { UnitsConversionPreparation } from '@openzcad/kernel-adapter/exact';
import type { UnitSystem } from '@openzcad/shared';
import { CONVERT_UNIT_WORDS } from '../lib/unitsConversion';
import { useModalFocus } from '../lib/useModalFocus';

/** The stored units a document can be converted between (owner decision Q1). */
export const CONVERT_UNIT_CHOICES: readonly ConvertibleUnit[] = [
  'mm',
  'cm',
  'inch'
];

const CHOICE_LABELS: Readonly<Record<ConvertibleUnit, string>> = {
  mm: 'Millimeters (mm)',
  cm: 'Centimeters (cm)',
  inch: 'Inches (in)'
};

export type PreparedConversion = Extract<
  UnitsConversionPreparation,
  { ok: true }
>;

/** What a conversion (in place or on a copy) came to. */
export type ConvertUnitsOutcome =
  | { ok: true; message: string }
  | {
      ok: false;
      refusals: UnitsConvertRefusal[];
      /** Said above the refusals: where the attempt stopped. */
      context?: string;
    };

export type ConvertCopyStep = 'copying' | 'checking' | 'converting';

/**
 * A "Convert a copy" run, held by the workspace: opening the copy replaces
 * the workspace (and this dialog) for a moment, so its progress and outcome
 * cannot live in the dialog.
 */
export type ConvertCopyState =
  { step: ConvertCopyStep } | { outcome: ConvertUnitsOutcome };

export interface ConvertUnitsDialogProps {
  /** The unit the project stores. */
  stored: UnitSystem;
  /** The unit lengths are shown and typed in now. */
  shown: UnitSystem;
  /**
   * Why converting cannot start (other editors present, a read-only seat):
   * shown before anything runs, with every action but Cancel disabled.
   */
  blockedReason?: string | null;
  /** Checks a conversion to `to` in the worker; nothing changes. */
  prepare(
    to: ConvertibleUnit,
    signal: AbortSignal
  ): Promise<UnitsConversionPreparation>;
  /** Converts the open project in place, after its safety checkpoint. */
  convert(prepared: PreparedConversion): Promise<ConvertUnitsOutcome>;
  /**
   * Starts copying the project, opening the copy and converting that; its
   * progress and outcome come back as {@link copy}.
   */
  convertCopy?(to: ConvertibleUnit): void;
  /** The "Convert a copy" run, while one is under way or has finished. */
  copy?: ConvertCopyState | null;
  /** Forgets a finished copy run, to check what is open again. */
  onClearCopy?(): void;
  onClose(): void;
}

type Phase =
  | { kind: 'blocked' }
  | { kind: 'checking' }
  | { kind: 'ready'; prepared: PreparedConversion }
  | {
      kind: 'refused';
      refusals: UnitsConvertRefusal[];
      warnings: UnitsConversionWarning[];
      context?: string;
      /** Whether "Check again" is offered (the project moved or changed). */
      retry?: boolean;
      /** The last good check, still convertible after a non-stale refusal. */
      prepared?: PreparedConversion;
    }
  | { kind: 'failed'; message: string }
  | { kind: 'converting'; step: 'converting' | ConvertCopyStep }
  | { kind: 'done'; message: string };

const COPY_STEP_LABELS: Readonly<Record<ConvertCopyStep, string>> = {
  copying: 'Making a copy…',
  checking: 'Checking the copy…',
  converting: 'Converting…'
};

function defaultTarget(stored: UnitSystem): ConvertibleUnit {
  return stored === 'inch' ? 'mm' : 'inch';
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/** Where a refusal or warning is: the feature and the field, when named. */
function placeOf(item: { subject: string; field?: string }): string | null {
  const subject = item.subject === 'document' ? null : item.subject;
  if (subject && item.field) return `${subject} · ${item.field}`;
  return subject ?? item.field ?? null;
}

/** What happens to the shown unit once the conversion applies (plan §5.4). */
export function displayUnitsAfterSentence(
  report: Pick<UnitsConversionReport, 'displayUnits' | 'to'>,
  shown: UnitSystem
): string {
  return report.displayUnits === 'kept'
    ? `Lengths stay shown in ${CONVERT_UNIT_WORDS[shown]}, as chosen under Units.`
    : `Lengths will be shown in ${CONVERT_UNIT_WORDS[report.to]}, the new stored unit.`;
}

/**
 * I03 phase 6: the review screen for converting a project's stored unit.
 * It checks the conversion in a worker as soon as a unit is chosen, shows
 * what would change (values, rewritten expressions, warnings, undo) or every
 * reason it cannot, and converts in place after a safety checkpoint, or
 * converts a copy. Changing how lengths are shown is the File › Units row,
 * not this.
 */
export function ConvertUnitsDialog({
  stored,
  shown,
  blockedReason = null,
  prepare,
  convert,
  convertCopy,
  copy = null,
  onClearCopy,
  onClose
}: ConvertUnitsDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, { autoFocus: true });
  const choices = CONVERT_UNIT_CHOICES.filter((unit) => unit !== stored);
  const [target, setTarget] = useState<ConvertibleUnit>(defaultTarget(stored));
  const [ownPhase, setPhase] = useState<Phase>(
    blockedReason ? { kind: 'blocked' } : { kind: 'checking' }
  );
  const copyActive = copy !== null;
  const phase: Phase = copy
    ? 'step' in copy
      ? { kind: 'converting', step: copy.step }
      : copy.outcome.ok
        ? { kind: 'done', message: copy.outcome.message }
        : {
            kind: 'refused',
            refusals: copy.outcome.refusals,
            warnings: [],
            retry: true,
            ...(copy.outcome.context ? { context: copy.outcome.context } : {})
          }
    : ownPhase;
  // Bumped to check again (a stale refusal, or a changed unit).
  const [checkRun, setCheckRun] = useState(0);
  const prepareRef = useRef(prepare);
  prepareRef.current = prepare;
  const blocked = Boolean(blockedReason);

  const phaseRef = useRef(ownPhase);
  phaseRef.current = ownPhase;

  useEffect(() => {
    // A conversion under way, or finished, is not interrupted: opening a
    // copy can lock and unlock editing for a moment.
    const current = phaseRef.current.kind;
    if (copyActive || current === 'converting' || current === 'done') return;
    if (blocked) {
      setPhase({ kind: 'blocked' });
      return;
    }
    const controller = new AbortController();
    setPhase({ kind: 'checking' });
    prepareRef
      .current(target, controller.signal)
      .then((preparation) => {
        if (controller.signal.aborted) return;
        setPhase(
          preparation.ok
            ? { kind: 'ready', prepared: preparation }
            : {
                kind: 'refused',
                refusals: preparation.refusals,
                warnings: preparation.warnings
              }
        );
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setPhase({
          kind: 'failed',
          message:
            error instanceof Error && error.message
              ? error.message
              : 'Checking the conversion failed.'
        });
      });
    return () => controller.abort();
  }, [target, checkRun, blocked, copyActive]);

  const busy = phase.kind === 'converting';
  const close = () => {
    if (!busy) onClose();
  };
  const stale =
    phase.kind === 'refused' &&
    phase.refusals.some((refusal) => refusal.code === 'stale');
  const retry =
    stale ||
    phase.kind === 'failed' ||
    (phase.kind === 'refused' && phase.retry === true);
  const prepared =
    phase.kind === 'ready'
      ? phase.prepared
      : phase.kind === 'refused' && !stale
        ? phase.prepared
        : undefined;

  async function finish(
    run: () => Promise<ConvertUnitsOutcome>,
    from: PreparedConversion
  ) {
    let outcome: ConvertUnitsOutcome;
    try {
      outcome = await run();
    } catch (error) {
      setPhase({
        kind: 'failed',
        message:
          error instanceof Error && error.message
            ? error.message
            : 'Stored units were not converted.'
      });
      return;
    }
    if (outcome.ok) {
      setPhase({ kind: 'done', message: outcome.message });
      return;
    }
    setPhase({
      kind: 'refused',
      refusals: outcome.refusals,
      warnings: from.report.warnings,
      ...(outcome.context ? { context: outcome.context } : {}),
      prepared: from
    });
  }

  function convertInPlace() {
    if (!prepared) return;
    setPhase({ kind: 'converting', step: 'converting' });
    void finish(() => convert(prepared), prepared);
  }

  function convertACopy() {
    if (!convertCopy || !prepared) return;
    convertCopy(target);
  }

  function checkAgain() {
    if (copyActive) onClearCopy?.();
    setCheckRun((run) => run + 1);
  }

  const fromName = CONVERT_UNIT_WORDS[stored];
  const toName = CONVERT_UNIT_WORDS[target];
  const checkpoint = unitsConvertCheckpointName(stored, target);
  const canAct = Boolean(prepared) && !busy && !blocked;

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="export-dialog convert-units-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="convert-units-title"
        aria-describedby="convert-units-scope"
        aria-busy={phase.kind === 'checking' || busy}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            close();
          }
        }}
      >
        <h2 id="convert-units-title">
          <Ruler size={16} aria-hidden="true" />
          Convert stored units
        </h2>
        <p id="convert-units-scope" className="export-dialog-scope">
          To only see lengths in another unit, use Units in the File menu
          instead. This rewrites every stored length from {fromName} to the unit
          you choose. The model keeps its exact size.
        </p>
        {phase.kind === 'done' ? (
          <p className="convert-units-done" role="status">
            {phase.message}
          </p>
        ) : (
          <fieldset className="export-dialog-group" disabled={busy || blocked}>
            <legend>Convert to</legend>
            {choices.map((choice) => (
              <label key={choice} className="export-dialog-option">
                <input
                  type="radio"
                  name="convert-units"
                  value={choice}
                  checked={target === choice}
                  onChange={() => setTarget(choice)}
                />
                <span>{CHOICE_LABELS[choice]}</span>
              </label>
            ))}
          </fieldset>
        )}

        {phase.kind === 'blocked' ? (
          <p className="export-dialog-error" role="alert">
            {blockedReason}
          </p>
        ) : null}

        {phase.kind === 'checking' ? (
          <p className="export-dialog-progress" role="status">
            <LoaderCircle size={13} className="spin" aria-hidden="true" />
            Checking the conversion to {toName}… This rebuilds the model, so it
            can take a moment.
          </p>
        ) : null}

        {phase.kind === 'converting' ? (
          <p className="export-dialog-progress" role="status">
            <LoaderCircle size={13} className="spin" aria-hidden="true" />
            {phase.step === 'converting'
              ? `Saving “${checkpoint}”, then converting…`
              : COPY_STEP_LABELS[phase.step]}
          </p>
        ) : null}

        {phase.kind === 'failed' ? (
          <div className="export-dialog-check-failed" role="alert">
            <p>{phase.message}</p>
            <p>Stored units were not converted.</p>
          </div>
        ) : null}

        {phase.kind === 'ready' ? (
          <ConversionSummary
            prepared={phase.prepared}
            shown={shown}
            checkpoint={checkpoint}
          />
        ) : null}

        {phase.kind === 'refused' ? (
          <section
            className="convert-units-refusals"
            aria-labelledby="convert-units-refused-title"
            role="alert"
          >
            <h3 id="convert-units-refused-title">
              {stale
                ? 'The project changed'
                : `Stored units cannot be converted to ${toName}`}
            </h3>
            {phase.context ? <p>{phase.context}</p> : null}
            <ul>
              {phase.refusals.map((refusal, index) => {
                const place = placeOf(refusal);
                return (
                  <li key={`${refusal.code}-${refusal.subject}-${index}`}>
                    {place ? <strong>{place}</strong> : null}
                    <span>{refusal.message}</span>
                  </li>
                );
              })}
            </ul>
            {phase.warnings.length > 0 && !phase.prepared ? (
              <WarningList warnings={phase.warnings} />
            ) : null}
          </section>
        ) : null}

        <div className="export-dialog-actions">
          {phase.kind === 'done' ? (
            <button type="button" className="primary" onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={close}
              >
                Cancel
              </button>
              {retry ? (
                <button type="button" className="primary" onClick={checkAgain}>
                  Check again
                </button>
              ) : (
                <>
                  {convertCopy ? (
                    <button
                      type="button"
                      className="secondary"
                      disabled={!canAct}
                      onClick={convertACopy}
                    >
                      Convert a copy
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="primary"
                    disabled={!canAct}
                    onClick={convertInPlace}
                  >
                    Convert
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function WarningList({
  warnings
}: {
  warnings: readonly UnitsConversionWarning[];
}) {
  return (
    <div className="convert-units-warnings">
      <h3>
        <TriangleAlert size={13} aria-hidden="true" />
        Check after converting ({warnings.length})
      </h3>
      <ul>
        {warnings.map((warning, index) => {
          const place = placeOf(warning);
          return (
            <li key={`${warning.subject}-${warning.field}-${index}`}>
              {place ? <strong>{place}</strong> : null}
              <code>{warning.expression}</code>
              <span>{warning.message}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ConversionSummary({
  prepared,
  shown,
  checkpoint
}: {
  prepared: PreparedConversion;
  shown: UnitSystem;
  checkpoint: string;
}) {
  const { report, undo } = prepared;
  const count = unitsConvertValueCount(report);
  const rewritten = [...report.wrapped, ...report.unwrapped];
  return (
    <section
      className="convert-units-summary"
      aria-label="What converting changes"
      role="status"
    >
      <ul className="convert-units-facts">
        <li>
          {count === 0
            ? 'No stored value changes.'
            : `${plural(count, 'stored value')} will change.`}
        </li>
        <li>
          “{checkpoint}” is saved first. Restore it from the save states to go
          back.
        </li>
        <li>{displayUnitsAfterSentence(report, shown)}</li>
        {report.configurationRows > 0 ? (
          <li>
            {plural(report.configurationRows, 'configuration row')} converted
            too.
          </li>
        ) : null}
      </ul>
      {rewritten.length > 0 ? (
        <details className="convert-units-expressions">
          <summary>
            {plural(rewritten.length, 'expression')} rewritten to keep{' '}
            {rewritten.length === 1 ? 'its' : 'their'} size
          </summary>
          <ul>
            {rewritten.map((rewrite, index) => (
              <li key={`${rewrite.subject}-${rewrite.field}-${index}`}>
                <strong>
                  {rewrite.subject} · {rewrite.field}
                </strong>
                <code>{rewrite.before}</code>
                <span aria-hidden="true">→</span>
                <span className="visually-hidden">becomes</span>
                <code>{rewrite.after}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {report.warnings.length > 0 ? (
        <WarningList warnings={report.warnings} />
      ) : null}
      {undo.keepsOnlyConversion ? (
        <p className="convert-units-undo" role="note">
          <TriangleAlert size={13} aria-hidden="true" />
          This conversion is a large undo step, so earlier undo steps will be
          lost. The safety checkpoint still lets you go back.
        </p>
      ) : null}
    </section>
  );
}
