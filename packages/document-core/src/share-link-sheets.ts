import type { DrawingSheet, ProjectDocument } from '@openzcad/shared';

/**
 * L08: which drawing sheets a project's share links show.
 *
 * A link serves the current model only (`sharedProjectSnapshotDocument`), and
 * drawing sheets stay with the project unless chosen here: their title
 * blocks carry author, date and drawing-number text. The choice is part of
 * the document, so an encrypted project keeps it encrypted and signed like
 * the sheets themselves (ADR-024), and every editor's browser that
 * republishes a link's snapshot reads the same list.
 *
 * Kept outside `drawings` so a sheet's own record and every reader of it are
 * unchanged; an older client keeps the list (normalization spreads unknown
 * fields) and, building its own snapshots, shares no sheets at all.
 */

/** At most this many sheets are named; the drawing set's own bound is lower. */
export const MAX_SHARE_LINK_SHEETS = 256;

export function isShareLinkSheetIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_SHARE_LINK_SHEETS &&
    value.every(
      (id) => typeof id === 'string' && id.length > 0 && id.length <= 64
    ) &&
    new Set(value).size === value.length
  );
}

/** The sheets a share link shows, in the document's sheet order. */
export function shareLinkSheets(document: ProjectDocument): DrawingSheet[] {
  const chosen = isShareLinkSheetIds(document.shareLinkSheetIds)
    ? new Set(document.shareLinkSheetIds)
    : new Set<string>();
  return (document.drawings?.sheets ?? []).filter((sheet) =>
    chosen.has(sheet.sheetId)
  );
}

/**
 * The document with exactly these sheets shown on its links, in sheet order;
 * ids of sheets it does not hold are dropped, and an empty choice removes the
 * field. Returns the same document when nothing changes.
 */
export function withShareLinkSheets(
  document: ProjectDocument,
  sheetIds: readonly string[]
): ProjectDocument {
  const wanted = new Set(sheetIds);
  const next = (document.drawings?.sheets ?? [])
    .map((sheet) => sheet.sheetId)
    .filter((id) => wanted.has(id));
  const current = shareLinkSheets(document).map((sheet) => sheet.sheetId);
  if (
    next.length === current.length &&
    next.every((id, index) => id === current[index]) &&
    (next.length > 0 || document.shareLinkSheetIds === undefined)
  )
    return document;
  const { shareLinkSheetIds: _previous, ...rest } = document;
  return next.length ? { ...rest, shareLinkSheetIds: next } : rest;
}
