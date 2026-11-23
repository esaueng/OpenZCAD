/**
 * I03 stored-unit conversion, phase 5 (plan
 * `docs/plans/i03-stored-unit-conversion-plan.md` §5.1, §5.2, §6): the
 * kernel half of authoring a `units.convert` command.
 *
 * {@link prepareUnitsConversion} runs every check before a command exists:
 *
 * 1. the pure transform and its field oracle (`convertDocumentUnits`);
 * 2. reference re-capture and the geometry and reference oracles, by three
 *    cold rebuilds (`computeConversionReferenceMap`);
 * 3. the recorded payload replayed without the kernel
 *    (`runUnitsConversion`), which must reproduce the verified document
 *    exactly, so what replay builds is what the oracles checked;
 * 4. the undo entry measured against `MAX_UNDO_BYTES` (plan §5.2): a
 *    conversion whose undo step the history could not keep even alone is
 *    refused (`undo-too-large`), so an applied conversion can always be
 *    undone; one that pushes out every earlier step says so
 *    (`undo.keepsOnlyConversion`).
 *
 * It returns either the payload with everything a review screen shows
 * (counts, rewritten expressions, warnings, the undo estimate), or every
 * refusal, each naming the node and field. It never changes the document:
 * the caller writes the safety checkpoint and submits
 * `commandFactories.convertUnits(payload)`. The result is plain data, so a
 * worker can post it.
 */
import {
  assertUnitsConvertSchema,
  convertDocumentUnits,
  estimateUnitsConvertUndo,
  recordConversionReferences,
  runUnitsConversion,
  unitsConvertFactor,
  type ConvertibleUnit,
  type UnitsConversionReport,
  type UnitsConversionWarning,
  type UnitsConvertInput,
  type UnitsConvertRefusal,
  type UnitsConvertUndoEstimate,
  unitsConvertUndoRefusal
} from '@openzcad/document-core';
import type { ProjectDocument, UnitSystem, UserId } from '@openzcad/shared';
import {
  computeConversionReferenceMap,
  type ConversionReferenceMapOptions,
  type ConversionReferenceRefusal,
  type ConversionReferenceReport
} from './units-reference-recapture';

/**
 * A re-capture refusal as the review screen shows it. Most phase-4
 * messages already name the node and say what to change; a
 * `blend-orientation` one describes kernel edge parameterisation, so it is
 * restated in modelling terms (the blend would come out mirrored) with
 * what to do next. The field still names the edge.
 */
export function presentReferenceRefusal(
  refusal: ConversionReferenceRefusal
): UnitsConvertRefusal {
  if (refusal.code === 'blend-orientation')
    return {
      stage: 'references',
      ...refusal,
      message: `${refusal.subject} would be rebuilt on the other side of its edges after the conversion, so its fillet or chamfer would come out mirrored. Stored units were not converted. Re-select the edges of ${refusal.subject} and try again.`
    };
  return { stage: 'references', ...refusal };
}

export interface UnitsConversionPreparationOptions extends ConversionReferenceMapOptions {
  /**
   * Whose undo history the estimate measures: the actor of the manager the
   * conversion will be committed through. Required, not defaulted to the
   * owner: a member's longer id can tip an entry the owner's would keep
   * over the bound (`commitUnitsConversion` measures again regardless).
   */
  actorUserId: UserId;
}

export type UnitsConversionPreparation =
  | {
      ok: true;
      /** Submit as `commandFactories.convertUnits(payload)`. */
      payload: UnitsConvertInput;
      /** The document version this was prepared from. */
      sourceVersion: number;
      /** Counts, rewritten expressions and warnings (phase 2). */
      report: UnitsConversionReport;
      /** Reference sites, oracle coverage and build timings (phase 4). */
      references: ConversionReferenceReport;
      undo: UnitsConvertUndoEstimate;
    }
  | {
      ok: false;
      sourceVersion: number;
      refusals: UnitsConvertRefusal[];
      /** Warnings the transform found before something refused. */
      warnings: UnitsConversionWarning[];
    };

/**
 * Prepares converting `document` to `to`; see the module comment. Needs the
 * kernel (it builds the document three times), so the browser runs it in a
 * disposable worker.
 */
export async function prepareUnitsConversion(
  document: ProjectDocument,
  to: UnitSystem,
  options: UnitsConversionPreparationOptions
): Promise<UnitsConversionPreparation> {
  const sourceVersion = document.version;
  const refuse = (
    refusals: UnitsConvertRefusal[],
    warnings: UnitsConversionWarning[] = []
  ): UnitsConversionPreparation => ({
    ok: false,
    sourceVersion,
    refusals,
    warnings
  });
  try {
    assertUnitsConvertSchema(document.schemaVersion);
  } catch (error) {
    return refuse([
      {
        stage: 'payload',
        code: 'schema',
        subject: 'document',
        message:
          error instanceof Error ? error.message : 'The project is too old.'
      }
    ]);
  }

  const converted = convertDocumentUnits(document, to);
  if (!converted.ok)
    return refuse(
      converted.refusals.map((refusal) => ({ stage: 'transform', ...refusal }))
    );
  const { report } = converted;

  const { actorUserId, ...referenceOptions } = options;
  const recaptured = await computeConversionReferenceMap(
    document,
    converted.document,
    referenceOptions
  );
  if (!recaptured.ok)
    return refuse(
      recaptured.refusals.map(presentReferenceRefusal),
      report.warnings
    );

  const payload: UnitsConvertInput = {
    from: document.units as ConvertibleUnit,
    to: to as ConvertibleUnit,
    factor: unitsConvertFactor(document.units, to),
    references: recordConversionReferences(document, recaptured.references)
  };
  const replayed = runUnitsConversion(document, payload);
  if (!replayed.ok)
    return refuse(
      replayed.refusals.map((refusal) => ({ ...refusal, stage: 'replay' })),
      report.warnings
    );
  if (JSON.stringify(replayed.document) !== JSON.stringify(recaptured.document))
    return refuse(
      [
        {
          stage: 'replay',
          code: 'replay-mismatch',
          subject: 'document',
          message:
            'Replaying the recorded conversion does not reproduce the verified document, so it would not rebuild the same way later.'
        }
      ],
      report.warnings
    );

  const undo = estimateUnitsConvertUndo(
    document,
    payload,
    actorUserId,
    replayed.document
  );
  if (undo.exceedsLimit)
    return refuse([unitsConvertUndoRefusal(undo)], report.warnings);

  return {
    ok: true,
    payload,
    sourceVersion,
    report,
    references: recaptured.report,
    undo
  };
}
