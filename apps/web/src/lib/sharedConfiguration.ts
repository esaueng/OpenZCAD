import { documentForConfiguration } from '@openzcad/document-core';
import type { ProjectDocument } from '@openzcad/shared';

/**
 * F06: the shared model as a link that names a configuration opens it. The
 * row comes from the link (`#share=…&configuration=<row id>`) and its values
 * from the model, so the link can only pick a row its author defined. A row
 * the model no longer has, or one it cannot take, opens the model as saved,
 * with a note saying so.
 */
export function sharedDocumentOnRow(
  document: ProjectDocument,
  rowId: string | null
): { document: ProjectDocument; note: string | null } {
  if (rowId === null) return { document, note: null };
  const row = document.configurations?.rows.find((entry) => entry.id === rowId);
  if (!row)
    return {
      document,
      note: 'The configuration this link names is no longer in the model, so it opened as saved.'
    };
  try {
    return {
      document: documentForConfiguration(document, rowId),
      note: `Showing ${row.name}.`
    };
  } catch {
    return {
      document,
      note: `${row.name} could not be built, so the model opened as saved.`
    };
  }
}
