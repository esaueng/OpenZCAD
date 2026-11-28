import { documentForConfiguration } from '@openzcad/document-core';
import type {
  DrawingSheet,
  DrawingView,
  DrawingViewId,
  ProjectDocument
} from '@openzcad/shared';
import { geometryContentKey } from '../../worker/exactRebuildCache';

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
  const activeRowId = document.configurations?.activeRowId;
  for (const [viewId, rowId] of viewNamedRows(sheet, document))
    if (rowId !== activeRowId) rows.set(viewId, rowId);
  return rows;
}

/**
 * The row of the table each view names, through its source: the active row
 * included, which `viewConfigurationRows` leaves to the model.
 */
function viewNamedRows(
  sheet: Pick<DrawingSheet, 'views'>,
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
    if (rowId && known.has(rowId)) rows.set(view.viewId, rowId);
  }
  return rows;
}

/**
 * The rows of the table a sheet's views name, sorted: the rows the sheet is
 * fenced to (`rowSheetFingerprint`), whichever of them is active.
 */
export function sheetNamedRows(
  sheet: Pick<DrawingSheet, 'views'>,
  document: Pick<ProjectDocument, 'configurations'>
): string[] {
  return [...new Set(viewNamedRows(sheet, document).values())].sort();
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
 * What a view on another row is built from: everything a rebuild reads
 * (`geometryContentKey`: the features and their order, the parameters, the
 * imports, the table and its rows), so no model edit leaves a row view's
 * projection, cut or bodies in use. Drawing, folder and assembly edits keep
 * it. Hashed (two 32-bit lanes) so keys stay short; computed only while some
 * view names a row.
 */
export function rowContentKey(document: ProjectDocument): string {
  return hashText(geometryContentKey(document));
}

/** Two 32-bit FNV-style lanes over the text, as 16 hex digits. */
function hashText(text: string): string {
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

/** A row's document, or why the model cannot take that row's values. */
export type RowDocument =
  { ok: true; document: ProjectDocument } | { ok: false; message: string };

/**
 * The document with `rowId` active (`documentForConfiguration`), which
 * refuses a row the model cannot evaluate (a value naming a parameter since
 * deleted, say). The refusal is answered, never thrown: it is that row's
 * views that cannot be drawn, not the sheet.
 */
export function rowDocument(
  document: ProjectDocument,
  rowId: string
): RowDocument {
  try {
    return { ok: true, document: documentForConfiguration(document, rowId) };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : 'This configuration could not be built.'
    };
  }
}

/**
 * The views a sheet draws from the active row. A sheet's availability and
 * its model fingerprint read these alone: a body only another row builds is
 * not missing, and its freshness is in the row view's own key.
 */
export function activeRowSheet<T extends Pick<DrawingSheet, 'views'>>(
  sheet: T,
  rows: ReadonlyMap<DrawingViewId, string>
): T {
  if (rows.size === 0) return sheet;
  return {
    ...sheet,
    views: sheet.views.filter((view) => !rows.has(view.viewId))
  };
}

/**
 * What a projection-sheet view's geometry is cached under: its row and the
 * model content it was built from, or null for the active row. A row edit
 * changes the content, so its meshes and cuts are made again.
 */
export function projectionViewCacheKey(view: DrawingView): string | null {
  return view.configurationId ?? null;
}

/**
 * What one row builds, whichever row is active: the model with the row's
 * values applied (`rowDocument`) and, of the table, only what that row alone
 * adds to them (the bodies it shows, its material). So making another row
 * active, renaming a row, adding a column or editing another row's cell
 * keeps it, and an edit to anything this row's rebuild reads changes it.
 *
 * Saved with the sheet, unlike `rowContentKey`, so it leaves out what names
 * the project rather than its model (its id, owner, name, branch point and
 * schema version, on the document and on its project node): a copy of the
 * project, an imported backup, a rename or a newer schema is the same row. It reads content, not built geometry, so an edit that happens
 * not to move the row's shape still changes it. A row the model cannot take
 * is keyed by its refusal.
 */
export function rowFenceKey(document: ProjectDocument, rowId: string): string {
  const source = rowDocument(document, rowId);
  if (!source.ok) return `!${hashText(source.message)}`;
  const {
    schemaVersion: _schemaVersion,
    projectId: _projectId,
    ownerUserId: _ownerUserId,
    name: _name,
    branchedFrom: _branchedFrom,
    ...model
  } = source.document;
  const row = model.configurations?.rows.find((entry) => entry.id === rowId);
  const root = model.nodes[model.rootNodeId];
  const nodes = { ...model.nodes };
  if (root?.kind === 'project') {
    const { projectId: _id, name: _rootName, ...unnamed } = root;
    nodes[model.rootNodeId] = unnamed as typeof root;
  }
  // A feature a row suppressed and another released is left with empty
  // metadata where it had none: the same feature either way.
  for (const [id, node] of Object.entries(nodes))
    if (node.metadata && Object.keys(node.metadata).length === 0) {
      const { metadata: _empty, ...bare } = node;
      nodes[id] = bare;
    }
  return hashText(
    // Keyed as a document is, less the fields left out above.
    geometryContentKey({
      ...model,
      nodes,
      configurations: {
        activeRowId: rowId,
        columns: [],
        rows: row
          ? [
              {
                id: rowId,
                name: '',
                // In the model already: `rowDocument` applied them.
                parameters: {},
                suppressed: {},
                bodies: row.bodies,
                ...(row.material ? { material: row.material } : {})
              }
            ]
          : []
      }
    } as unknown as ProjectDocument)
  );
}

/** Marks the rows' part of a sheet's fence (`rowSheetFingerprint`). */
export const ROW_FENCE = '|r:';

/**
 * F06: a sheet's model fence with the content of every row its views name
 * appended (`rowFenceKey`), or `base` when they name none. A view on another
 * row is drawn from that row's own build, which the model fingerprint does
 * not read: with this a sheet is stale once any row it draws would build
 * differently than when it was last drawn, and stays stale whichever row is
 * made active afterwards.
 */
export function rowSheetFingerprint(
  base: string,
  rowIds: readonly string[],
  keyOf: (rowId: string) => string
): string {
  if (rowIds.length === 0) return base;
  return `${base}${ROW_FENCE}${hashText(
    [...new Set(rowIds)]
      .sort()
      .map((rowId) => `${rowId}${ROW_SEPARATOR}${keyOf(rowId)}`)
      .join('\n')
  )}`;
}

/** `base` as `sheet`'s fence in `document` (`rowSheetFingerprint`). */
export function rowFencedFingerprint(
  base: string,
  sheet: Pick<DrawingSheet, 'views'>,
  document: ProjectDocument
): string {
  return rowSheetFingerprint(base, sheetNamedRows(sheet, document), (rowId) =>
    rowFenceKey(document, rowId)
  );
}
