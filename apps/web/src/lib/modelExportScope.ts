import {
  assemblyConfigurationOnlyBodies,
  documentForConfigurationExport
} from '@openzcad/document-core';
import { ownEntry, type BodyId, type ProjectDocument } from '@openzcad/shared';
import type { ExportScopeBody } from './exportScope';

/**
 * The bodies `exportScope` chooses from for File › Export, the palette and
 * the desktop menu: every body the model builds, and (F06) each body an
 * assembly part shows from its own configuration row although the active
 * row builds none for it. Such a part is in the scope like any shown body,
 * so its export reaches the kernel's refusal naming it, rather than
 * reporting an empty scope.
 */
export function exportScopeBodies(
  document: ProjectDocument,
  isHidden: (bodyId: BodyId) => boolean,
  isWithheld: (bodyId: BodyId) => boolean
): ExportScopeBody[] {
  const bodies = new Map<string, ExportScopeBody>();
  for (const body of Object.values(document.derived.bodyRepresentations))
    bodies.set(body.bodyId, {
      bodyId: body.bodyId,
      exportable:
        (body.exportableStep || body.meshReference === true) && !body.consumed,
      hidden: isHidden(body.bodyId),
      withheld: isWithheld(body.bodyId)
    });
  for (const { bodyId } of assemblyConfigurationOnlyBodies(document))
    bodies.set(bodyId, {
      bodyId,
      exportable: true,
      hidden: isHidden(bodyId),
      withheld: false
    });
  return [...bodies.values()];
}

/**
 * A scoped body's name: the model's, else the assembly part's that shows it
 * from its own row (`exportScopeBodies`), else its id.
 */
export function exportScopeBodyName(
  document: ProjectDocument,
  bodyId: BodyId
): string {
  return (
    ownEntry(document.derived.bodyRepresentations, bodyId)?.name ??
    assemblyConfigurationOnlyBodies(document).find(
      (entry) => entry.bodyId === bodyId
    )?.name ??
    bodyId
  );
}

/** F06: what an export of a configuration row writes (`exportTarget`). */
export interface ExportTarget {
  document: ProjectDocument;
  bodyIds: BodyId[];
  /** Every body the document shows, resolved by the kernel. */
  allShownBodies: boolean;
  /** The row's name, for another row than the active one. */
  rowName: string | null;
}

/**
 * F06: what an export of `rowId` writes. The active row (or none) is the
 * model as Assemble shows it, with the export scope's bodies, each part's
 * own Configuration included. Another row is built for the file alone from
 * `documentForConfigurationExport`: that row, every assembly part in it.
 * Nothing in the open document changes, and it writes every body that row
 * shows.
 */
export function exportTargetFor(
  document: ProjectDocument,
  rowId: string | null,
  scopeBodyIds: BodyId[]
): ExportTarget {
  const set = document.configurations;
  const row =
    rowId && set && rowId !== set.activeRowId
      ? set.rows.find((entry) => entry.id === rowId)
      : undefined;
  if (!row)
    return {
      document,
      bodyIds: scopeBodyIds,
      allShownBodies: false,
      rowName: null
    };
  return {
    document: documentForConfigurationExport(document, row.id),
    bodyIds: [],
    allShownBodies: true,
    rowName: row.name
  };
}
