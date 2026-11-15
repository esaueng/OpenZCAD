import {
  printClearanceError,
  type FeatureData,
  type ParamValue,
  type ProjectDocument
} from '@openzcad/shared';
import { assertPrintClearanceSchema } from './document-content-schema';
import {
  evaluateFieldExpression,
  getParameterScope,
  resolveParamValue
} from './index';

/**
 * L09 document print clearance (schema v60): one radial allowance for printed
 * fits, stored on the document. Threads and gears that leave their own
 * clearance or backlash unset read it through {@link documentPrintClearance};
 * a future joint fit reads it the same way. Unset, nothing reads anything,
 * so every result is what it was before the field existed.
 */

/**
 * The document's print clearance in document units, or undefined when it
 * has none. Throws, naming the print clearance, when the stored value does
 * not resolve or comes to less than zero: a part that reads it must not be
 * built with a gap nobody asked for.
 */
export function documentPrintClearance(
  document: Pick<ProjectDocument, 'printClearance' | 'units'> &
    Partial<ProjectDocument>,
  scope?: Record<string, number>
): number | undefined {
  const stored = document.printClearance;
  if (stored === undefined) return undefined;
  const value = resolveParamValue(
    stored,
    scope ?? getParameterScope(document as ProjectDocument).scope,
    'Print clearance',
    document.units
  );
  if (!(value >= 0)) {
    throw new Error('Print clearance: must be zero or more.');
  }
  return value;
}

/**
 * Whether a feature builds from the document's print clearance: a thread
 * that leaves its own `clearance` unset (a pipe thread never: it mates a
 * standard fitting, so it keeps its own fit), and a gear that leaves its
 * `backlash` unset.
 */
export function featureReadsPrintClearance(data: FeatureData): boolean {
  if (data.featureKind === 'thread') {
    return (
      data.clearance === undefined &&
      data.profile !== 'npt' &&
      data.profile !== 'bspt'
    );
  }
  return data.featureKind === 'gear' && data.backlash === undefined;
}

export interface PrintClearanceSetInput {
  /** The new clearance: a length in document units or an expression; null clears it. */
  value: ParamValue | null;
}

/**
 * Sets or clears the print clearance. The value is checked as a length field
 * is: it must resolve against the current parameters, come to a length (or a
 * bare number in document units) and not be negative.
 */
export function setPrintClearance(
  document: ProjectDocument,
  input: PrintClearanceSetInput
): ProjectDocument {
  assertPrintClearanceSchema(document.schemaVersion);
  const value =
    typeof input.value === 'string' ? input.value.trim() : input.value;
  if (value !== null) {
    const shape = printClearanceError(value);
    if (shape) throw new Error(shape);
    const resolved =
      typeof value === 'number'
        ? value
        : evaluateFieldExpression(value, getParameterScope(document).scope, {
            documentUnits: document.units,
            dimension: 'length'
          });
    if (!(resolved >= 0)) {
      throw new Error('The print clearance must be a length of zero or more.');
    }
  }
  const { printClearance: previous, ...rest } = document;
  if (previous === (value ?? undefined)) return document;
  return {
    ...rest,
    // Fresh arrays: the command manager appends this command to the log of
    // the document returned here, and a shared array would write it into
    // the previous document too.
    commandLog: [...document.commandLog],
    revisions: [...document.revisions],
    checkpoints: [...document.checkpoints],
    ...(value === null ? {} : { printClearance: value }),
    version: document.version + 1
  };
}
