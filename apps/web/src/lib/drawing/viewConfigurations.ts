import type {
  DrawingSheet,
  DrawingView,
  DrawingViewId,
  ProjectDocument
} from '@openzcad/shared';

/**
 * F06 slice 4b: the configuration row each drawing view draws. A base view
 * names its own (`configurationId`); a view folded from it, cut from it,
 * detailed from it or seen square to one of its edges draws its source's.
 * Views on the active row, or on a row the table no longer holds, are left
 * out: they draw the model as it is.
 */
export function viewConfigurationRows(
  sheet: DrawingSheet,
  document: Pick<ProjectDocument, 'configurations'>
): Map<DrawingViewId, string> {
  const rows = new Map<DrawingViewId, string>();
  const set = document.configurations;
  if (!set) return rows;
  const known = new Set(set.rows.map((row) => row.id));
  const byId = new Map(sheet.views.map((view) => [view.viewId, view]));
  const sourceOf = (view: DrawingView): DrawingViewId | undefined =>
    view.parentViewId ??
    view.section?.sourceViewId ??
    view.detail?.sourceViewId ??
    view.auxiliary?.sourceViewId;
  for (const view of sheet.views) {
    let root: DrawingView | undefined = view;
    const seen = new Set<DrawingViewId>();
    while (root && sourceOf(root) && !seen.has(root.viewId)) {
      seen.add(root.viewId);
      root = byId.get(sourceOf(root)!);
    }
    const rowId = root?.configurationId;
    if (rowId && rowId !== set.activeRowId && known.has(rowId))
      rows.set(view.viewId, rowId);
  }
  return rows;
}

/** Separates a row id from its content key, and a row from a body id. */
export const ROW_SEPARATOR = '\u0001';

/**
 * The sheet as projection keys read it: each view that draws another row
 * carries that row and the model content it was built from in its
 * `configurationId`, so its projection is cached apart from the active
 * row's and made again when that row's geometry can have changed. Views on
 * the active row lose any `configurationId`, so their keys stay as they are.
 */
export function projectionSheet(
  sheet: DrawingSheet,
  rows: ReadonlyMap<DrawingViewId, string>,
  contentKey: string
): DrawingSheet {
  if (rows.size === 0 && !sheet.views.some((view) => view.configurationId))
    return sheet;
  return {
    ...sheet,
    views: sheet.views.map((view) => {
      const rowId = rows.get(view.viewId);
      const { configurationId: _own, ...rest } = view;
      return rowId
        ? { ...rest, configurationId: `${rowId}${ROW_SEPARATOR}${contentKey}` }
        : rest;
    })
  };
}

/** The row a projection-sheet view draws, or null for the active row. */
export function projectionViewRow(view: DrawingView): string | null {
  return view.configurationId
    ? view.configurationId.split(ROW_SEPARATOR)[0]!
    : null;
}

/** A body's tessellation key: the body alone on the active row. */
export function rowBodyKey(rowId: string | null, bodyId: string): string {
  return rowId ? `${rowId}${ROW_SEPARATOR}${bodyId}` : bodyId;
}

/**
 * What a view on another row is built from: the model's features and the
 * table. Hashed (two 32-bit lanes) so keys stay short; computed only while
 * some view names a row.
 */
export function rowContentKey(
  document: Pick<ProjectDocument, 'nodes' | 'configurations'>
): string {
  const text = JSON.stringify([document.nodes, document.configurations]);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x5bd1e995);
  }
  return (
    (h1 >>> 0).toString(16).padStart(8, '0') +
    (h2 >>> 0).toString(16).padStart(8, '0')
  );
}
