import {
  assertDrawingSet,
  deepClone,
  drawingViewAlignment,
  projectedViewSide,
  type BodyId,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingTitleBlock,
  type DrawingView,
  type DrawingViewId,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * D01 drawing commands. Each takes explicit data — the sheet, the view, the
 * placement, the fingerprint — so undo, redo and replay reproduce the same
 * sheet without any geometry. Layout and fingerprints are computed by the
 * caller from the derived projection; nothing here reads it.
 */

export interface DrawingSheetAddInput {
  sheet: DrawingSheet;
}

export interface DrawingSheetUpdateInput {
  sheetId: DrawingSheetId;
  name?: string;
  paper?: DrawingSheet['paper'];
  scale?: DrawingSheet['scale'];
  projectionAngle?: DrawingSheet['projectionAngle'];
  /** Fields set to an empty string fall back to their automatic value. */
  titleBlock?: Partial<Record<keyof DrawingTitleBlock, string>>;
  /** Explicit Update: rebinds the sheet to the current model. */
  source?: DrawingSheet['source'];
}

export interface DrawingSheetDeleteInput {
  sheetId: DrawingSheetId;
}

export interface DrawingViewAddInput {
  sheetId: DrawingSheetId;
  view: DrawingView;
}

export interface DrawingViewUpdateInput {
  sheetId: DrawingSheetId;
  viewId: DrawingViewId;
  /** Moves the view; a projected view keeps its base's shared axis. */
  centerMm?: { x: number; y: number };
  hiddenLines?: boolean;
  bodyIds?: BodyId[];
}

export interface DrawingViewDeleteInput {
  sheetId: DrawingSheetId;
  viewId: DrawingViewId;
}

function withDrawings(
  document: ProjectDocument,
  edit: (sheets: DrawingSheet[]) => DrawingSheet[]
): ProjectDocument {
  const sheets = edit(deepClone(document.drawings?.sheets ?? []));
  const drawings = sheets.length > 0 ? { sheets } : undefined;
  assertDrawingSet(drawings);
  const { drawings: _previous, ...rest } = document;
  return {
    ...rest,
    ...(drawings ? { drawings } : {}),
    version: document.version + 1
  };
}

function sheetIndex(sheets: DrawingSheet[], sheetId: DrawingSheetId): number {
  const index = sheets.findIndex((sheet) => sheet.sheetId === sheetId);
  if (index < 0) throw new Error(`Drawing sheet ${sheetId} not found.`);
  return index;
}

function assertBodiesExist(document: ProjectDocument, bodyIds: BodyId[]): void {
  const known = new Set(document.bodyOrder);
  const missing = bodyIds.find((id) => !known.has(id));
  if (missing) throw new Error(`Body ${missing} is not in this project.`);
}

export function findDrawingSheet(
  document: ProjectDocument,
  sheetId: DrawingSheetId
): DrawingSheet | undefined {
  return document.drawings?.sheets.find((sheet) => sheet.sheetId === sheetId);
}

export function addDrawingSheet(
  document: ProjectDocument,
  input: DrawingSheetAddInput
): ProjectDocument {
  for (const view of input.sheet.views)
    assertBodiesExist(document, view.bodyIds);
  return withDrawings(document, (sheets) => {
    if (sheets.some((sheet) => sheet.sheetId === input.sheet.sheetId))
      throw new Error(`Drawing sheet ${input.sheet.sheetId} already exists.`);
    return [...sheets, deepClone(input.sheet)];
  });
}

export function updateDrawingSheet(
  document: ProjectDocument,
  input: DrawingSheetUpdateInput
): ProjectDocument {
  return withDrawings(document, (sheets) => {
    const index = sheetIndex(sheets, input.sheetId);
    const sheet = sheets[index]!;
    if (input.name !== undefined) sheet.name = input.name.trim();
    if (input.paper) sheet.paper = { ...input.paper };
    if (input.scale) sheet.scale = { ...input.scale };
    if (
      input.projectionAngle &&
      input.projectionAngle !== sheet.projectionAngle
    ) {
      sheet.projectionAngle = input.projectionAngle;
      mirrorProjectedViews(sheet);
    }
    if (input.source) sheet.source = { ...input.source };
    if (input.titleBlock) {
      const titleBlock: DrawingTitleBlock = { ...sheet.titleBlock };
      for (const [key, value] of Object.entries(input.titleBlock) as [
        keyof DrawingTitleBlock,
        string
      ][]) {
        const text = value.trim();
        if (text) titleBlock[key] = text;
        else delete titleBlock[key];
      }
      sheet.titleBlock = titleBlock;
    }
    return sheets;
  });
}

/**
 * First and third angle place each projected view on opposite sides of the
 * base it folds from. Switching convention therefore mirrors every projected
 * view across its base along their shared axis, in the same edit, so the
 * layout never contradicts the projection named in the title block.
 */
function mirrorProjectedViews(sheet: DrawingSheet): void {
  const byId = new Map(sheet.views.map((view) => [view.viewId, view]));
  for (const view of sheet.views) {
    const base = view.parentViewId ? byId.get(view.parentViewId) : undefined;
    if (!base) continue;
    const alignment = drawingViewAlignment(base.orientation, view.orientation);
    if (alignment === 'row')
      view.centerMm = {
        x: 2 * base.centerMm.x - view.centerMm.x,
        y: base.centerMm.y
      };
    else if (alignment === 'column')
      view.centerMm = {
        x: base.centerMm.x,
        y: 2 * base.centerMm.y - view.centerMm.y
      };
  }
}

export function deleteDrawingSheet(
  document: ProjectDocument,
  input: DrawingSheetDeleteInput
): ProjectDocument {
  return withDrawings(document, (sheets) => {
    sheetIndex(sheets, input.sheetId);
    return sheets.filter((sheet) => sheet.sheetId !== input.sheetId);
  });
}

export function addDrawingView(
  document: ProjectDocument,
  input: DrawingViewAddInput
): ProjectDocument {
  assertBodiesExist(document, input.view.bodyIds);
  return withDrawings(document, (sheets) => {
    const sheet = sheets[sheetIndex(sheets, input.sheetId)]!;
    if (sheet.views.some((view) => view.viewId === input.view.viewId))
      throw new Error(`Drawing view ${input.view.viewId} already exists.`);
    const view = deepClone(input.view);
    const parent = view.parentViewId
      ? sheet.views.find((entry) => entry.viewId === view.parentViewId)
      : undefined;
    if (parent)
      view.centerMm = alignedCenter(
        parent,
        view,
        view.centerMm,
        sheet.projectionAngle,
        'mirror'
      );
    sheet.views.push(view);
    return sheets;
  });
}

/**
 * Where `child` lands when asked to sit at `requested`: on the base's row
 * or column, whichever axis the two views share, and on the side of the
 * base the sheet's projection angle gives it. A request on the other side
 * is mirrored across the base when a view is added (`mirror`) and stopped
 * at the base when a view is moved (`clamp`), so no edit can contradict the
 * projection named in the title block.
 */
function alignedCenter(
  base: DrawingView,
  child: DrawingView,
  requested: { x: number; y: number },
  angle: DrawingSheet['projectionAngle'],
  across: 'mirror' | 'clamp'
): { x: number; y: number } {
  const alignment = drawingViewAlignment(base.orientation, child.orientation);
  if (alignment === null) return requested;
  const side = projectedViewSide(base.orientation, child.orientation, angle);
  const settle = (value: number, origin: number) =>
    side * (value - origin) >= 0
      ? value
      : across === 'mirror'
        ? 2 * origin - value
        : origin;
  return alignment === 'row'
    ? { x: settle(requested.x, base.centerMm.x), y: base.centerMm.y }
    : { x: base.centerMm.x, y: settle(requested.y, base.centerMm.y) };
}

export function updateDrawingView(
  document: ProjectDocument,
  input: DrawingViewUpdateInput
): ProjectDocument {
  return withDrawings(document, (sheets) => {
    const sheet = sheets[sheetIndex(sheets, input.sheetId)]!;
    const view = sheet.views.find((entry) => entry.viewId === input.viewId);
    if (!view) throw new Error(`Drawing view ${input.viewId} not found.`);
    // Only bodies the edit adds must exist: a body the model has since
    // deleted stays in the list until the user removes it, and adding a
    // live one beside it must not be refused because of it.
    if (input.bodyIds)
      assertBodiesExist(
        document,
        input.bodyIds.filter((id) => !view.bodyIds.includes(id))
      );
    if (input.hiddenLines !== undefined) view.hiddenLines = input.hiddenLines;
    if (input.bodyIds) view.bodyIds = [...input.bodyIds];
    if (input.centerMm) {
      const parent = view.parentViewId
        ? sheet.views.find((entry) => entry.viewId === view.parentViewId)
        : undefined;
      const next = parent
        ? alignedCenter(
            parent,
            view,
            input.centerMm,
            sheet.projectionAngle,
            'clamp'
          )
        : { ...input.centerMm };
      const dx = next.x - view.centerMm.x;
      const dy = next.y - view.centerMm.y;
      view.centerMm = next;
      // A base carries its projected views along, snapped onto its shared
      // axis, so the views it folds into stay aligned with it.
      for (const child of sheet.views) {
        if (child.parentViewId !== view.viewId) continue;
        child.centerMm = alignedCenter(
          view,
          child,
          { x: child.centerMm.x + dx, y: child.centerMm.y + dy },
          sheet.projectionAngle,
          'clamp'
        );
      }
    }
    return sheets;
  });
}

export function deleteDrawingView(
  document: ProjectDocument,
  input: DrawingViewDeleteInput
): ProjectDocument {
  return withDrawings(document, (sheets) => {
    const sheet = sheets[sheetIndex(sheets, input.sheetId)]!;
    if (!sheet.views.some((view) => view.viewId === input.viewId))
      throw new Error(`Drawing view ${input.viewId} not found.`);
    // Projected views of a deleted base stay where they are, now free.
    sheet.views = sheet.views
      .filter((view) => view.viewId !== input.viewId)
      .map((view) => {
        if (view.parentViewId !== input.viewId) return view;
        const { parentViewId: _base, ...free } = view;
        return free;
      });
    return sheets;
  });
}
