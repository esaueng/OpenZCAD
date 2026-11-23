import { documentForConfiguration } from '@openzcad/document-core';
import type { FeatureWarning, ProjectDocument } from '@openzcad/shared';
import {
  resolvedForDisplay,
  type SolveSketch
} from './sketch/parameterResolve';

/** Builds a document's geometry and reports what it warned about. */
export type BuildForWarnings = (document: ProjectDocument) => Promise<{
  warnings: readonly string[];
  featureWarnings?: readonly FeatureWarning[];
}>;

/**
 * The features a build could not build or refused, each keyed by the
 * feature and its message: two features may share a name, so a message
 * alone cannot tell which one failed. A suppressed feature is skipped on
 * purpose and an advisory changes nothing, so neither is a failure; without
 * the typed records only suppression notes are set aside.
 */
function failures(result: Awaited<ReturnType<BuildForWarnings>>): string[] {
  if (result.featureWarnings)
    return result.featureWarnings
      .filter(
        (warning) =>
          warning.kind === 'build-failed' || warning.kind === 'refusal'
      )
      .map((warning) => `${warning.featureId}\u0000${warning.message}`);
  return result.warnings.filter(
    (warning) => !warning.endsWith('Suppressed; skipped during exact rebuild.')
  );
}

/**
 * F06: the shared model as a link that names a configuration opens it. The
 * row comes from the link (`#share=…&configuration=<row id>`) and its values
 * from the model, so the link can only pick a row its author defined. The
 * row is built before it is accepted: a row the model no longer has, one the
 * model refuses, or one with a feature that fails to build where the saved
 * model's does not (a suppressed feature that a later transform still needs,
 * say) opens the model as saved, with a note saying why.
 */
export async function sharedDocumentOnRow(
  document: ProjectDocument,
  rowId: string | null,
  build: BuildForWarnings,
  /**
   * Solves a sketch: the row's parameter values can drive sketches the
   * saved row solved to other sizes, and the row is shown as it solves.
   */
  solve?: SolveSketch
): Promise<{ document: ProjectDocument; note: string | null }> {
  if (rowId === null) return { document, note: null };
  const row = document.configurations?.rows.find((entry) => entry.id === rowId);
  if (!row)
    return {
      document,
      note: 'The configuration this link names is no longer in the model, so it opened as saved.'
    };
  const refused = {
    document,
    note: `${row.name} could not be built, so the model opened as saved.`
  };
  let candidate: ProjectDocument;
  try {
    candidate = documentForConfiguration(document, rowId);
  } catch {
    return refused;
  }
  // The row the model was saved on needs no second build.
  if (candidate === document) return { document, note: `Showing ${row.name}.` };
  try {
    if (solve) candidate = await resolvedForDisplay(document, candidate, solve);
    // One after the other: the geometry worker's preview channel answers
    // the latest request and drops the one before it.
    const built = await build(candidate);
    const saved = await build(document);
    const savedFailures = failures(saved);
    const added = failures(built).filter(
      (warning) => !savedFailures.includes(warning)
    );
    if (added.length > 0)
      return {
        document,
        note: `${row.name} could not be built (${added[0]!.split('\u0000').at(-1)}), so the model opened as saved.`
      };
  } catch (error) {
    return {
      document,
      note: `${row.name} could not be built (${error instanceof Error ? error.message : 'its rebuild failed'}), so the model opened as saved.`
    };
  }
  return { document: candidate, note: `Showing ${row.name}.` };
}
