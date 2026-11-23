import {
  MAX_UNDO_BYTES,
  nowIso,
  type ProjectDocument,
  type UnitSystem,
  type UserId
} from '@openzcad/shared';
import { assertUnitsConvertSchema } from './document-content-schema';
import {
  documentChanges,
  documentHistoryBytes,
  recordDocumentEdit
} from './document-history';
import { appendRevision } from './index';
import {
  convertDocumentUnits,
  type ConvertibleUnit,
  type UnitsConversionReport
} from './units-convert';
import {
  applyReferenceMap,
  conversionReferencePreconditionRefusals,
  conversionReferenceTargets,
  type RecordedConversionReferences
} from './units-reference-map';
import { unitsConvertPayloadShapeProblem } from './units-convert-payload';

export {
  unitsConvertFactor,
  unitsConvertPayloadShapeProblem
} from './units-convert-payload';

/**
 * I03 stored-unit conversion, phase 5 (plan
 * `docs/plans/i03-stored-unit-conversion-plan.md` §5.1–§5.3): the recorded,
 * replayable `units.convert` command.
 *
 * Authoring needs the kernel: a worker converts the document
 * (`convertDocumentUnits`), re-captures every persisted reference from
 * rebuilds (`computeConversionReferenceMap`) and only then hands back the
 * payload below. Applying the payload needs no kernel: it is the same pure
 * transform followed by {@link applyReferenceMap} with the recorded map, so
 * `replayCommands` reproduces the authored document exactly, as ADR-021 does
 * for stored extrude inference.
 *
 * `factor` is redundant with the two units but pins the arithmetic: a
 * replay refuses a payload whose factor is not the exact millimetre ratio
 * of its units, rather than convert by another number.
 *
 * Each reference entry records the value it replaces (`from`) as well as
 * the new one (`to`). A replay refuses the whole conversion when the
 * document it meets stores anything else at one of those places (a history
 * reordered or rebased so that a later edit re-selected the edge first),
 * rather than overwrite the newer selection; `from` must also be the
 * document's current unit.
 */

/** The command kind (schema v154). */
export const UNITS_CONVERT_COMMAND_KIND = 'units.convert';

/** The `units.convert` payload, as recorded in the command log. */
export interface UnitsConvertInput {
  from: ConvertibleUnit;
  to: ConvertibleUnit;
  /** k = N / D: millimetres per `from` unit over millimetres per `to`. */
  factor: readonly [number, number];
  /**
   * Every persisted reference re-captured, keyed by JSON pointer: the value
   * the source stored there (the replay's precondition) and its new value.
   */
  references: RecordedConversionReferences;
}

/** Where a conversion refused: each stage names the node and the field. */
export type UnitsConvertRefusalStage =
  'payload' | 'transform' | 'references' | 'replay' | 'collaboration';

/** One user-presentable reason a conversion cannot be applied. */
export interface UnitsConvertRefusal {
  stage: UnitsConvertRefusalStage;
  code: string;
  /** A node (`Fillet 1 (feat_…)`), an area, a body or `document`. */
  subject: string;
  field?: string;
  /** A sentence for the review screen. */
  message: string;
}

/** A refused `units.convert`, with every reason. */
export class UnitsConversionError extends Error {
  constructor(readonly refusals: readonly UnitsConvertRefusal[]) {
    super(
      `Stored units cannot be converted: ${refusals
        .slice(0, 3)
        .map((refusal) => refusal.message)
        .join(
          ' '
        )}${refusals.length > 3 ? ` (and ${refusals.length - 3} more)` : ''}`
    );
    this.name = 'UnitsConversionError';
  }
}

export type UnitsConvertResult =
  | { ok: true; document: ProjectDocument; report: UnitsConversionReport }
  | { ok: false; refusals: UnitsConvertRefusal[] };

/** How the summary names a unit: `mm → in`. */
export const UNITS_CONVERT_SYMBOLS: Readonly<Record<UnitSystem, string>> = {
  mm: 'mm',
  cm: 'cm',
  m: 'm',
  inch: 'in'
};

/** "Convert stored units mm → in": the command's label and undo step. */
export function unitsConvertLabel(from: UnitSystem, to: UnitSystem): string {
  return `Convert stored units ${UNITS_CONVERT_SYMBOLS[from]} → ${UNITS_CONVERT_SYMBOLS[to]}`;
}

/**
 * "Before unit conversion (mm → in)": the safety checkpoint written and
 * persisted before the command applies (plan §5.3).
 */
export function unitsConvertCheckpointName(
  from: UnitSystem,
  to: UnitSystem
): string {
  return `Before unit conversion (${UNITS_CONVERT_SYMBOLS[from]} → ${UNITS_CONVERT_SYMBOLS[to]})`;
}

/**
 * How many stored values a conversion rewrote: scaled numbers plus
 * rewritten expressions (wrapped, unwrapped and numerals).
 */
export function unitsConvertValueCount(report: UnitsConversionReport): number {
  return (
    report.scaledNumbers +
    report.wrapped.length +
    report.unwrapped.length +
    report.numerals.length
  );
}

/** Why `input` is not a well-formed payload for `document`, if it is not. */
export function unitsConvertPayloadProblem(
  document: Pick<ProjectDocument, 'units'>,
  input: unknown
): string | undefined {
  return unitsConvertPayloadShapeProblem(input, document.units);
}

/**
 * Applies a recorded conversion purely: `convertDocumentUnits`, then the
 * recorded reference map. Every refusal is returned, none thrown, so the
 * authoring path can present them (see {@link applyUnitsConversion}).
 */
export function runUnitsConversion(
  document: ProjectDocument,
  input: UnitsConvertInput
): UnitsConvertResult {
  try {
    assertUnitsConvertSchema(document.schemaVersion);
  } catch (error) {
    return {
      ok: false,
      refusals: [
        {
          stage: 'payload',
          code: 'schema',
          subject: 'document',
          message:
            error instanceof Error
              ? error.message
              : 'The project schema is too old.'
        }
      ]
    };
  }
  const problem = unitsConvertPayloadProblem(document, input);
  if (problem)
    return {
      ok: false,
      refusals: [
        {
          stage: 'payload',
          code: 'payload',
          subject: 'document',
          message: problem
        }
      ]
    };
  // Every replacement's precondition, checked on the document as it is
  // before anything changes: one stale place refuses the whole replay.
  const changed = conversionReferencePreconditionRefusals(
    document,
    input.references
  );
  if (changed.length > 0)
    return {
      ok: false,
      refusals: changed.map((refusal) => ({
        stage: 'references',
        code: refusal.code,
        subject: refusal.subject ?? 'document',
        ...(refusal.field ? { field: refusal.field } : {}),
        message: refusal.message
      }))
    };
  const converted = convertDocumentUnits(document, input.to);
  if (!converted.ok)
    return {
      ok: false,
      refusals: converted.refusals.map((refusal) => ({
        stage: 'transform',
        ...refusal
      }))
    };
  const applied = applyReferenceMap(
    converted.document,
    conversionReferenceTargets(input.references)
  );
  if (!applied.ok)
    return {
      ok: false,
      refusals: applied.refusals.map((refusal) => ({
        stage: 'references',
        code: refusal.code,
        subject: refusal.subject ?? 'document',
        ...(refusal.field ? { field: refusal.field } : {}),
        message: refusal.message
      }))
    };
  return { ok: true, document: applied.document, report: converted.report };
}

/**
 * The `units.convert` command's apply and replay step: the converted
 * document, or a {@link UnitsConversionError} listing every refusal. Older
 * schemas refuse it, as `setDisplayUnits` refuses display units.
 */
export function applyUnitsConversion(
  document: ProjectDocument,
  input: UnitsConvertInput
): ProjectDocument {
  const result = runUnitsConversion(document, input);
  if (!result.ok) throw new UnitsConversionError(result.refusals);
  return result.document;
}

/** What the conversion's undo step costs, measured before it applies (plan §5.2). */
export interface UnitsConvertUndoEstimate {
  /** The UTF-8 bytes of the conversion's own undo entry. */
  entryBytes: number;
  /**
   * The bytes of an undo history holding only that entry, envelope
   * included: the measure the history's bound applies
   * (`documentHistoryBytes`), so the entry is kept exactly when this is at
   * most {@link limitBytes}.
   */
  historyBytes: number;
  /** The whole undo history's bound (`MAX_UNDO_BYTES`). */
  limitBytes: number;
  /**
   * Whether the entry cannot be kept even alone: the history would drop it
   * and the conversion could not be undone. Authoring refuses such a
   * conversion (`undo-too-large`) rather than apply a step Ctrl+Z cannot
   * reverse; the history cannot hold a larger entry without becoming
   * unreadable.
   */
  exceedsLimit: boolean;
  /** Earlier undo steps the history would drop to make room for it. */
  stepsDropped: number;
  /**
   * Whether the conversion would be the only undo step left: every
   * earlier step drops (and there was at least one). The review screen
   * warns that earlier undo will be lost.
   */
  keepsOnlyConversion: boolean;
}

/**
 * Measures the undo step converting `before` by `input` would record for
 * `actorUserId`, and how much earlier undo it would push out, by recording
 * it exactly as the command manager will: the converted document with the
 * command appended to its log and a revision, through `recordDocumentEdit`,
 * whose bound drops the oldest entries first and so keeps the conversion
 * whenever it fits alone. Only the log entry's timestamp and the ids differ
 * from the real step, and those have fixed lengths, so the byte counts are
 * exact. Pass `after` (the result of {@link applyUnitsConversion}) to skip
 * converting again.
 */
export function estimateUnitsConvertUndo(
  before: ProjectDocument,
  input: UnitsConvertInput,
  actorUserId: UserId,
  after: ProjectDocument = applyUnitsConversion(before, input)
): UnitsConvertUndoEstimate {
  const label = unitsConvertLabel(input.from, input.to);
  const executed = appendRevision(
    {
      ...after,
      commandLog: [
        ...after.commandLog,
        {
          kind: UNITS_CONVERT_COMMAND_KIND,
          payload: input,
          replayVersion: 1,
          label,
          timestamp: nowIso()
        }
      ]
    },
    label
  );
  const kinds = [UNITS_CONVERT_COMMAND_KIND];
  const previous =
    before.editHistory?.actorUserId === actorUserId
      ? before.editHistory
      : undefined;
  const earlier = previous?.cursor ?? 0;
  // The entry exactly as `recordDocumentEdit` builds it.
  const entry = {
    id: crypto.randomUUID(),
    label: label.slice(0, 256),
    changes: documentChanges(before, executed),
    commandKinds: kinds
  };
  const entryBytes = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
  const recorded = recordDocumentEdit(
    before,
    executed,
    label,
    actorUserId,
    kinds
  ).editHistory;
  // The bound drops from the oldest end, so the result is a suffix of the
  // earlier steps plus the new one: any entry left is the conversion.
  const length = recorded?.entries.length ?? 0;
  const exceedsLimit = length === 0;
  // The history the bound measures with the conversion as its only entry,
  // carrying the counter it has once every earlier step dropped.
  const historyBytes = documentHistoryBytes({
    schemaVersion: 1,
    projectId: executed.projectId,
    actorUserId,
    entries: [entry],
    cursor: 1,
    trimmed: (previous?.trimmed ?? 0) + earlier
  });
  const stepsDropped = exceedsLimit ? earlier : earlier - (length - 1);
  return {
    entryBytes,
    historyBytes,
    limitBytes: MAX_UNDO_BYTES,
    exceedsLimit,
    stepsDropped,
    keepsOnlyConversion: !exceedsLimit && earlier > 0 && length === 1
  };
}

/**
 * The refusal for a conversion whose undo step the history could not keep
 * (plan §5.2): applying it would leave a step Ctrl+Z cannot reverse.
 */
export function unitsConvertUndoRefusal(
  undo: UnitsConvertUndoEstimate
): UnitsConvertRefusal {
  const megabytes = (bytes: number) => (bytes / 1_000_000).toFixed(1);
  return {
    stage: 'payload',
    code: 'undo-too-large',
    subject: 'document',
    message: `Converting stored units would record a ${megabytes(undo.historyBytes)} MB undo step, more than the ${megabytes(undo.limitBytes)} MB undo history can hold, so it could not be undone. Stored units were not converted.`
  };
}
