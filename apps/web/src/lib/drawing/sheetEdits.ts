import {
  createDrawingAnnotationId,
  createDrawingSheetId,
  createDrawingViewId,
  type DrawingSheet,
  type DrawingView,
  type DrawingViewId
} from '@openzcad/shared';

/**
 * Sheet-level edits the Draw workspace offers from its tabs (review I62)
 * and the words it uses when a delete removes more than was clicked
 * (review I2). Pure: the workspace runs the commands.
 */

/**
 * "Sheet 3": the first "Sheet N" from the sheet count up that no sheet is
 * called, so deleting Sheet 1 and adding one never gives two "Sheet 2"s.
 */
export function nextSheetName(sheets: readonly Pick<DrawingSheet, 'name'>[]) {
  const names = new Set(sheets.map((sheet) => sheet.name.trim()));
  for (let n = sheets.length + 1; ; n += 1)
    if (!names.has(`Sheet ${n}`)) return `Sheet ${n}`;
}

/** "Front copy", then "Front copy 2"…: an unused name for a duplicate. */
export function copySheetName(
  name: string,
  sheets: readonly Pick<DrawingSheet, 'name'>[]
): string {
  const names = new Set(sheets.map((sheet) => sheet.name.trim()));
  const base = `${name.trim()} copy`;
  if (!names.has(base)) return base;
  for (let n = 2; ; n += 1)
    if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
}

/**
 * A copy of a sheet with fresh ids throughout: its views, the projected and
 * section views that point at them, and its dimensions and notes, so the
 * copy and the original can be edited apart.
 */
export function duplicateDrawingSheet(
  sheet: DrawingSheet,
  sheets: readonly Pick<DrawingSheet, 'name'>[],
  ids: {
    sheet?: () => DrawingSheet['sheetId'];
    view?: () => DrawingViewId;
    annotation?: () => NonNullable<
      DrawingSheet['annotations']
    >[number]['annotationId'];
  } = {}
): DrawingSheet {
  const newSheetId = ids.sheet ?? createDrawingSheetId;
  const newViewId = ids.view ?? createDrawingViewId;
  const newAnnotationId = ids.annotation ?? createDrawingAnnotationId;
  const copy = structuredClone(sheet);
  const viewIds = new Map<DrawingViewId, DrawingViewId>(
    copy.views.map((view) => [view.viewId, newViewId()])
  );
  const mapped = (id: DrawingViewId) => viewIds.get(id) ?? id;
  copy.sheetId = newSheetId();
  copy.name = copySheetName(sheet.name, sheets);
  copy.views = copy.views.map((view) => ({
    ...view,
    viewId: mapped(view.viewId),
    ...(view.parentViewId ? { parentViewId: mapped(view.parentViewId) } : {}),
    ...(view.section
      ? {
          section: {
            ...view.section,
            sourceViewId: mapped(view.section.sourceViewId)
          }
        }
      : {})
  }));
  if (copy.annotations)
    copy.annotations = copy.annotations.map((annotation) => ({
      ...annotation,
      annotationId: newAnnotationId(),
      ...(annotation.viewId ? { viewId: mapped(annotation.viewId) } : {})
    }));
  return copy;
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "A, B and C". */
function joined(parts: string[]): string {
  return parts.length <= 1
    ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
}

/**
 * What deleting a view takes with it, as the Undo notice says it: "Deleted
 * Front view, Section A-A and 4 dimensions." Mirrors `deleteDrawingView`:
 * its section views go, and every dimension and note in it or in them.
 */
export function deletedViewSummary(
  sheet: DrawingSheet,
  viewId: DrawingViewId,
  labelOf: (view: DrawingView) => string
): string {
  const view = sheet.views.find((entry) => entry.viewId === viewId);
  if (!view) return 'Deleted the view.';
  const sections = sheet.views.filter(
    (entry) => entry.section?.sourceViewId === viewId
  );
  const removed = new Set<DrawingViewId>([
    viewId,
    ...sections.map((entry) => entry.viewId)
  ]);
  const gone = (sheet.annotations ?? []).filter(
    (annotation) =>
      annotation.viewId !== undefined && removed.has(annotation.viewId)
  );
  const notes = gone.filter((annotation) => annotation.kind === 'note').length;
  const dimensions = gone.length - notes;
  const ownLabel = labelOf(view);
  const parts = [
    view.section ? ownLabel : `${ownLabel} view`,
    ...sections.map(labelOf),
    ...(dimensions > 0 ? [counted(dimensions, 'dimension', 'dimensions')] : []),
    ...(notes > 0 ? [counted(notes, 'note', 'notes')] : [])
  ];
  return `Deleted ${joined(parts)}.`;
}

/** "Deleted Sheet 2 and its 4 views." */
export function deletedSheetSummary(sheet: DrawingSheet): string {
  const views = sheet.views.length;
  return views === 0
    ? `Deleted ${sheet.name}.`
    : `Deleted ${sheet.name} and its ${counted(views, 'view', 'views')}.`;
}

/** The sheets with `sheetId` moved to `index` (clamped), or null if unmoved. */
export function movedSheets<T extends Pick<DrawingSheet, 'sheetId'>>(
  sheets: readonly T[],
  sheetId: DrawingSheet['sheetId'],
  index: number
): T[] | null {
  const from = sheets.findIndex((sheet) => sheet.sheetId === sheetId);
  if (from < 0 || !Number.isFinite(index)) return null;
  const to = Math.max(0, Math.min(sheets.length - 1, Math.round(index)));
  if (to === from) return null;
  const next = sheets.filter((sheet) => sheet.sheetId !== sheetId);
  next.splice(to, 0, sheets[from]!);
  return next;
}

/**
 * How to turn the sheet list `current` into `next` with the sheet commands
 * every client already replays: take out each sheet from the first position
 * that changes, then add the rest of `next` back in order (a sheet is
 * always added at the end). Sheet order needs no new command field, so it
 * needs no document schema bump and an older client replays a reorder
 * exactly. Ids, views and annotations are kept, so selection and
 * references survive.
 */
export function sheetOrderSteps(
  current: readonly DrawingSheet[],
  next: readonly DrawingSheet[]
): { remove: DrawingSheet['sheetId'][]; add: DrawingSheet[] } {
  let first = 0;
  while (
    first < current.length &&
    first < next.length &&
    current[first]!.sheetId === next[first]!.sheetId
  )
    first += 1;
  return {
    remove: current.slice(first).map((sheet) => sheet.sheetId),
    add: next.slice(first)
  };
}
