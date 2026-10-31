import {
  assertDrawingSet,
  deepClone,
  drawingAnnotationReferences,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  drawingPaperMm,
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
  /** Explicit body succession; subshape witnesses are retained and rechecked. */
  bodyReplacements?: { from: BodyId; to: BodyId }[];
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
  /** D03: moves a section view's cutting plane, in model units. */
  sectionDepth?: number;
}

export interface DrawingViewDeleteInput {
  sheetId: DrawingSheetId;
  viewId: DrawingViewId;
}

export interface DrawingAnnotationAddInput {
  sheetId: DrawingSheetId;
  annotation: DrawingAnnotation;
}

/**
 * Replaces an annotation whole — a move, a text or format edit, or a re-pick
 * of its references — so the command carries everything it sets.
 */
export interface DrawingAnnotationUpdateInput {
  sheetId: DrawingSheetId;
  annotation: DrawingAnnotation;
}

export interface DrawingAnnotationDeleteInput {
  sheetId: DrawingSheetId;
  annotationId: DrawingAnnotationId;
}

function withDrawings(
  document: ProjectDocument,
  edit: (sheets: DrawingSheet[]) => DrawingSheet[]
): ProjectDocument {
  const before = document.drawings?.sheets ?? [];
  const sheets = edit(deepClone(before));
  // An edit that changes nothing (a projected view nudged along the axis it
  // is locked to) returns the same document, which the command manager
  // records as no edit at all: no version, no undo entry, no save.
  if (JSON.stringify(sheets) === JSON.stringify(before)) return document;
  const drawings = sheets.length > 0 ? { sheets } : undefined;
  assertDrawingSet(drawings);
  const { drawings: _previous, ...rest } = document;
  return {
    ...rest,
    // Fresh arrays: the command manager appends this command to the log of
    // the document returned here, and a shared array would write it into
    // the previous document too — undo would then keep the command, and a
    // replay after undo bring the edit back.
    commandLog: [...document.commandLog],
    revisions: [...document.revisions],
    checkpoints: [...document.checkpoints],
    ...(drawings ? { drawings } : {}),
    version: document.version + 1
  };
}

/**
 * Keeps a view's centre on its paper, so some of it — and its handle on the
 * sheet — always stays where it can be picked, moved or deleted.
 */
function onPaper(
  sheet: DrawingSheet,
  center: { x: number; y: number }
): { x: number; y: number } {
  const { width, height } = drawingPaperMm(sheet.paper);
  return {
    x: Math.min(width, Math.max(0, center.x)),
    y: Math.min(height, Math.max(0, center.y))
  };
}

/**
 * The view `view` stays aligned with: the base a projected view folds from,
 * or the source a section view is cut from (D03).
 */
function alignmentBase(
  sheet: DrawingSheet,
  view: DrawingView
): DrawingView | undefined {
  const id = view.parentViewId ?? view.section?.sourceViewId;
  return id ? sheet.views.find((entry) => entry.viewId === id) : undefined;
}

function alignedWith(view: DrawingView, base: DrawingView): boolean {
  return (
    view.parentViewId === base.viewId ||
    view.section?.sourceViewId === base.viewId
  );
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
    if (input.bodyReplacements) {
      if (!input.source)
        throw new Error(
          'Rebinding drawing bodies requires an explicit source Update.'
        );
      const sources = new Set(sheet.views.flatMap((view) => view.bodyIds));
      const replacements = new Map<BodyId, BodyId>();
      for (const { from, to } of input.bodyReplacements) {
        if (!sources.has(from) || replacements.has(from) || from === to) {
          throw new Error('Invalid drawing body replacement.');
        }
        assertBodiesExist(document, [to]);
        replacements.set(from, to);
      }
      for (const view of sheet.views) {
        view.bodyIds = [
          ...new Set(view.bodyIds.map((id) => replacements.get(id) ?? id))
        ];
      }
      for (const annotation of sheet.annotations ?? []) {
        for (const edge of drawingAnnotationReferences(annotation)) {
          edge.bodyId = replacements.get(edge.bodyId) ?? edge.bodyId;
        }
      }
    }
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
  const before = new Map(
    sheet.views.map((view) => [view.viewId, { ...view.centerMm }])
  );
  const mirror = (view: DrawingView, base: DrawingView) => {
    const alignment = drawingViewAlignment(base.orientation, view.orientation);
    // Across where the base was: a section's source may itself have just
    // been mirrored, and the section keeps its offset from it, flipped.
    const origin = before.get(base.viewId)!;
    const offset = {
      x: view.centerMm.x - origin.x,
      y: view.centerMm.y - origin.y
    };
    const mirrored =
      alignment === 'row'
        ? { x: base.centerMm.x - offset.x, y: base.centerMm.y }
        : alignment === 'column'
          ? { x: base.centerMm.x, y: base.centerMm.y - offset.y }
          : null;
    if (!mirrored) return;
    // Kept on the paper like any other placement, then held on its side of
    // the base.
    view.centerMm = alignedCenter(
      base,
      view,
      onPaper(sheet, mirrored),
      sheet.projectionAngle,
      'clamp'
    );
  };
  // Projected views first (bases never move here), then sections, which
  // may be cut from a projected view that just moved.
  for (const view of sheet.views) {
    const base = view.parentViewId ? byId.get(view.parentViewId) : undefined;
    if (base) mirror(view, base);
  }
  for (const view of sheet.views) {
    const source = view.section
      ? byId.get(view.section.sourceViewId)
      : undefined;
    if (source) mirror(view, source);
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
    const parent = alignmentBase(sheet, view);
    view.centerMm = onPaper(sheet, view.centerMm);
    if (parent)
      view.centerMm = onPaper(
        sheet,
        alignedCenter(
          parent,
          view,
          view.centerMm,
          sheet.projectionAngle,
          'mirror'
        )
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
    if (input.sectionDepth !== undefined) {
      if (!view.section)
        throw new Error(`Drawing view ${input.viewId} is not a section.`);
      view.section = { ...view.section, depth: input.sectionDepth };
    }
    if (input.bodyIds) view.bodyIds = [...input.bodyIds];
    if (input.centerMm) {
      const parent = alignmentBase(sheet, view);
      // On the paper first, then on the base's axis and side; the base is on
      // the paper too, so the aligned centre stays on it.
      const requested = onPaper(sheet, input.centerMm);
      const next = parent
        ? onPaper(
            sheet,
            alignedCenter(
              parent,
              view,
              requested,
              sheet.projectionAngle,
              'clamp'
            )
          )
        : requested;
      const dx = next.x - view.centerMm.x;
      const dy = next.y - view.centerMm.y;
      view.centerMm = next;
      // A base carries its projected and section views along, snapped onto
      // its shared axis, so the views it folds into stay aligned with it;
      // a projected view carries its own sections on in turn.
      const carry = (base: DrawingView, dx: number, dy: number) => {
        for (const child of sheet.views) {
          if (child === view || !alignedWith(child, base)) continue;
          const before = child.centerMm;
          child.centerMm = onPaper(
            sheet,
            alignedCenter(
              base,
              child,
              { x: before.x + dx, y: before.y + dy },
              sheet.projectionAngle,
              'clamp'
            )
          );
          carry(
            child,
            child.centerMm.x - before.x,
            child.centerMm.y - before.y
          );
        }
      };
      carry(view, dx, dy);
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
    // Its section views go with it: a section line cannot outlive the view
    // it is drawn on. Its dimensions and notes, and theirs, go too: they
    // measure and sit in them.
    const removed = new Set<DrawingViewId>([input.viewId]);
    for (const view of sheet.views)
      if (view.section?.sourceViewId === input.viewId) removed.add(view.viewId);
    if (sheet.annotations) {
      const kept = sheet.annotations.filter(
        (annotation) =>
          annotation.viewId === undefined || !removed.has(annotation.viewId)
      );
      if (kept.length > 0) sheet.annotations = kept;
      else delete sheet.annotations;
    }
    // Projected views of a deleted base stay where they are, now free.
    sheet.views = sheet.views
      .filter((view) => !removed.has(view.viewId))
      .map((view) => {
        if (view.parentViewId !== input.viewId) return view;
        const { parentViewId: _base, ...free } = view;
        return free;
      });
    return sheets;
  });
}

/**
 * A new reference must name an edge of a body its view draws: the picker
 * only offers those, and a replayed or hand-made command must not bind a
 * dimension to geometry its view does not show. References an edit keeps
 * unchanged are not checked again — a body later removed from the view
 * leaves them broken, which the sheet shows, rather than refusing the edit.
 */
function assertAnnotationEdgesInView(
  sheet: DrawingSheet,
  annotation: DrawingAnnotation,
  previous?: DrawingAnnotation
): void {
  const edges = drawingAnnotationReferences(annotation);
  if (edges.length === 0) return;
  const view = sheet.views.find((entry) => entry.viewId === annotation.viewId);
  if (!view)
    throw new Error(`Drawing view ${String(annotation.viewId)} not found.`);
  const kept = new Set(
    (previous ? drawingAnnotationReferences(previous) : []).map((edge) =>
      JSON.stringify(edge)
    )
  );
  for (const edge of edges) {
    if (kept.has(JSON.stringify(edge))) continue;
    if (!view.bodyIds.includes(edge.bodyId))
      throw new Error(`Body ${edge.bodyId} is not drawn in that view.`);
  }
}

export function addDrawingAnnotation(
  document: ProjectDocument,
  input: DrawingAnnotationAddInput
): ProjectDocument {
  return withDrawings(document, (sheets) => {
    const sheet = sheets[sheetIndex(sheets, input.sheetId)]!;
    const annotations = sheet.annotations ?? [];
    if (
      annotations.some(
        (entry) => entry.annotationId === input.annotation.annotationId
      )
    )
      throw new Error(
        `Drawing annotation ${input.annotation.annotationId} already exists.`
      );
    assertAnnotationEdgesInView(sheet, input.annotation);
    sheet.annotations = [...annotations, deepClone(input.annotation)];
    return sheets;
  });
}

export function updateDrawingAnnotation(
  document: ProjectDocument,
  input: DrawingAnnotationUpdateInput
): ProjectDocument {
  return withDrawings(document, (sheets) => {
    const sheet = sheets[sheetIndex(sheets, input.sheetId)]!;
    const annotations = sheet.annotations ?? [];
    const index = annotations.findIndex(
      (entry) => entry.annotationId === input.annotation.annotationId
    );
    if (index < 0)
      throw new Error(
        `Drawing annotation ${input.annotation.annotationId} not found.`
      );
    const previous = annotations[index]!;
    if (previous.viewId !== input.annotation.viewId)
      throw new Error('An annotation cannot move to another view.');
    assertAnnotationEdgesInView(sheet, input.annotation, previous);
    annotations[index] = deepClone(input.annotation);
    sheet.annotations = annotations;
    return sheets;
  });
}

export function deleteDrawingAnnotation(
  document: ProjectDocument,
  input: DrawingAnnotationDeleteInput
): ProjectDocument {
  return withDrawings(document, (sheets) => {
    const sheet = sheets[sheetIndex(sheets, input.sheetId)]!;
    const annotations = sheet.annotations ?? [];
    if (!annotations.some((entry) => entry.annotationId === input.annotationId))
      throw new Error(`Drawing annotation ${input.annotationId} not found.`);
    const kept = annotations.filter(
      (entry) => entry.annotationId !== input.annotationId
    );
    if (kept.length > 0) sheet.annotations = kept;
    else delete sheet.annotations;
    return sheets;
  });
}
