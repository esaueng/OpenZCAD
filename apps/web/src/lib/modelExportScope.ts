import {
  assemblyRowDraw,
  assemblyRowDrawnParts,
  documentForConfigurationExport,
  type AssemblyRowDraw
} from '@openzcad/document-core';
import { ownEntry, type BodyId, type ProjectDocument } from '@openzcad/shared';
import type { ExportScopeBody } from './exportScope';

/** No part shows another configuration. */
export const NO_ROW_DRAW: AssemblyRowDraw = {
  fromRow: new Map(),
  removed: new Set()
};

/**
 * F06: what Assemble draws from other configuration rows, as an export of
 * the model reads it. `rowDocument` gives a row built from the document as
 * it now stands; a part whose row is not built (outside Assemble, or while
 * it rebuilds) counts as drawn from it, and the exact export decides.
 */
export function exportRowDraw(
  document: ProjectDocument,
  rowDocument: (rowId: string) => ProjectDocument | null | undefined
): AssemblyRowDraw {
  const parts = assemblyRowDrawnParts(document, rowDocument);
  return parts.length === 0 ? NO_ROW_DRAW : assemblyRowDraw(parts);
}

/**
 * The bodies Assemble leaves out while parts show other rows. `base` is the
 * model's hidden set (the active row's and this browser's). A body its
 * part's row draws is hidden only by a hide in this browser (`local`): the
 * part's row decides, not the active one. A body its part's row removes is
 * hidden. The viewport and the export scope both read this.
 */
export function rowDrawnHiddenBodyIds(
  base: ReadonlySet<string>,
  local: ReadonlySet<string>,
  draw: AssemblyRowDraw
): ReadonlySet<string> {
  if (draw.fromRow.size === 0 && draw.removed.size === 0) return base;
  const hidden = new Set(base);
  for (const bodyId of draw.removed) hidden.add(bodyId);
  for (const bodyId of draw.fromRow.keys())
    if (!local.has(bodyId)) hidden.delete(bodyId);
  return hidden;
}

/**
 * The bodies `exportScope` chooses from for File › Export, the palette and
 * the desktop menu: every body the model builds, and (F06) each body
 * Assemble draws from a part's own configuration row (`draw`), whether or
 * not the active row builds or shows one for it. Such a body is in the
 * scope like any shown body, so its export reaches the kernel's refusal
 * naming the part rather than leaving it out unsaid. `isHidden` is
 * `rowDrawnHiddenBodyIds`: what Assemble does not draw is not in a file.
 */
export function exportScopeBodies(
  document: ProjectDocument,
  draw: AssemblyRowDraw,
  isHidden: (bodyId: BodyId) => boolean,
  isWithheld: (bodyId: BodyId) => boolean
): ExportScopeBody[] {
  const bodies = new Map<string, ExportScopeBody>();
  for (const body of Object.values(document.derived.bodyRepresentations))
    bodies.set(body.bodyId, {
      bodyId: body.bodyId,
      exportable:
        ((body.exportableStep || body.meshReference === true) &&
          !body.consumed) ||
        draw.fromRow.has(body.bodyId),
      hidden: isHidden(body.bodyId),
      withheld: isWithheld(body.bodyId)
    });
  for (const bodyId of draw.fromRow.keys())
    if (!bodies.has(bodyId))
      bodies.set(bodyId, {
        bodyId,
        exportable: true,
        hidden: isHidden(bodyId),
        withheld: false
      });
  return [...bodies.values()];
}

/**
 * A scoped body's name: the model's, else the assembly part's that draws it
 * from its own row (`exportScopeBodies`), else its id.
 */
export function exportScopeBodyName(
  document: ProjectDocument,
  draw: AssemblyRowDraw,
  bodyId: BodyId
): string {
  return (
    ownEntry(document.derived.bodyRepresentations, bodyId)?.name ??
    draw.fromRow.get(bodyId)?.componentName ??
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

/**
 * Whether an export of `target` has nothing to write that the app can
 * know of: no body in the model's scope. Another row's bodies are listed by
 * the kernel once it is built, so its target is never empty here, whatever
 * the active row's own scope holds.
 */
export function exportTargetEmpty(
  target: Pick<ExportTarget, 'bodyIds' | 'allShownBodies'>
): boolean {
  return !target.allShownBodies && target.bodyIds.length === 0;
}
