import {
  displayUnitsError,
  type ProjectDocument,
  type UnitSystem
} from '@openzcad/shared';
import { assertDisplayUnitsSchema } from './document-content-schema';

/** I03: the unit to show and take lengths in, or null for the document's own. */
export interface DisplayUnitsSetInput {
  units: UnitSystem | null;
}

/**
 * Sets the unit `document` shows and takes lengths in (schema v148). Only
 * `displayUnits` changes: every stored length stays in `units`, so nothing
 * rebuilds differently. Choosing the document's own unit clears the field,
 * so a document switched back reads as one that was never switched.
 */
export function setDisplayUnits(
  document: ProjectDocument,
  input: DisplayUnitsSetInput
): ProjectDocument {
  assertDisplayUnitsSchema(document.schemaVersion);
  const units = input.units;
  if (units !== null) {
    const problem = displayUnitsError(units);
    if (problem) throw new Error(problem);
  }
  const next = units === null || units === document.units ? undefined : units;
  const { displayUnits: previous, ...rest } = document;
  if (previous === next) return document;
  return {
    ...rest,
    // Fresh arrays: the command manager appends this command to the log of
    // the document returned here, and a shared array would write it into
    // the previous document too.
    commandLog: [...document.commandLog],
    revisions: [...document.revisions],
    checkpoints: [...document.checkpoints],
    ...(next === undefined ? {} : { displayUnits: next }),
    version: document.version + 1
  };
}
