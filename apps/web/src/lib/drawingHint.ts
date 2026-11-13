import type { DrawingSheetId, ProjectDocument } from '@openzcad/shared';

/**
 * Whether Draw's guidance may point at views ("Drag a view to place it"):
 * only when the sheet on screen has one. Which sheet is open is the drawing
 * workspace's own state, reported as `activeSheetId`; a project with one
 * empty and one populated sheet used to show the drag line on both. Until
 * the workspace has reported (it mounts a moment after the mode switch), or
 * when it names a sheet the document no longer holds, any sheet's views
 * count, as they did before.
 */
export function drawingSheetHasViews(
  document: Pick<ProjectDocument, 'drawings'> | null | undefined,
  activeSheetId: DrawingSheetId | null
): boolean {
  const sheets = document?.drawings?.sheets ?? [];
  const active = sheets.find((sheet) => sheet.sheetId === activeSheetId);
  return active
    ? active.views.length > 0
    : sheets.some((sheet) => sheet.views.length > 0);
}
