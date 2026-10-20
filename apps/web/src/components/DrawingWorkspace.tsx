import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react';
import { FileDown, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import { updateDrawingView } from '@openzcad/document-core';
import {
  createDrawingViewId,
  DRAWING_PAPER_LABELS,
  DRAWING_PAPER_SIZES_MM,
  DRAWING_SCALE_PRESETS,
  DRAWING_VIEW_LABELS,
  DRAWING_VIEW_ORIENTATIONS,
  drawingPaperMm,
  drawingPaperPerModelUnit,
  drawingViewAlignment,
  formatDrawingScale,
  projectedViewSide,
  MAX_DRAWING_TEXT_LENGTH,
  type BodyId,
  type BodyRepresentation,
  type DrawingPaperSize,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingTitleBlock,
  type DrawingView,
  type DrawingViewId,
  type DrawingViewOrientation,
  type ProjectDocument
} from '@openzcad/shared';
import {
  DrawingProjectionClient,
  type DrawingProjectionViewRequest
} from '../lib/drawing/projectionClient';
import type {
  ProjectionBodyInput,
  ViewProjection
} from '../lib/drawing/projectView';
import {
  composeSheetPage,
  sheetViewArea,
  titleBlockBox,
  viewPageBox,
  type SheetPage
} from '../lib/drawing/sheetPage';
import {
  drawingExportFileName,
  sheetPageToPdf,
  sheetPageToSvg
} from '../lib/drawing/sheetExport';
import {
  createStarterSheet,
  defaultDrawingPaper,
  drawingSourceFingerprint,
  estimateViewExtent,
  projectionBodyInput,
  sheetBodyIds
} from '../lib/drawing/sheetSources';
import { saveCadBinaryFile, saveCadTextFile } from '../lib/desktopBridge';

/**
 * D01 drawing workspace: the sheet canvas and its properties.
 *
 * Every edit is a document command, so it undoes, saves and syncs like any
 * other. The canvas draws the same `SheetPage` the PDF and SVG writers
 * serialize — one page transform for preview and export.
 *
 * The model fence: a sheet remembers a fingerprint of the bodies it draws.
 * When the model no longer matches it, the sheet says so, draws its views as
 * outlines only and refuses export until an explicit Update rebinds it. It
 * never quietly redraws a sheet someone may already have handed off.
 */
export interface DrawingWorkspaceProps {
  document: ProjectDocument;
  /** The last completed projection of the model; it may lag `document`. */
  bodies: Readonly<Record<string, BodyRepresentation | undefined>>;
  /**
   * True while `bodies` is not the projection of `document` (a rebuild is in
   * flight). A sheet is never ready, drawn or exported then: old geometry
   * that still matches its fingerprint is not the model the document holds.
   * Sheet edits keep the ready geometry, so they never set this.
   */
  geometryPending: boolean;
  /**
   * Bodies a new sheet draws: the live bodies on screen, independent of the
   * selection and the export scope. Empty refuses the new sheet.
   */
  defaultBodyIds: BodyId[];
  /** Why drawing edits are refused, or null. */
  editDisabledReason: string | null;
  onCommand: (command: AnyCommand) => boolean;
  onStatus: (message: string) => void;
}

type SheetStatus =
  | { kind: 'ready'; fingerprint: string }
  | { kind: 'pending' }
  | { kind: 'stale'; fingerprint: string }
  | { kind: 'missing'; bodyNames: string[] };

type ViewState =
  | { state: 'ready'; projection: ViewProjection }
  | { state: 'projecting' }
  | { state: 'error'; message: string };

function sheetStatus(
  sheet: DrawingSheet,
  bodies: DrawingWorkspaceProps['bodies'],
  geometryPending: boolean,
  fingerprint: string | null
): SheetStatus {
  const ids = sheetBodyIds(sheet);
  // While the model rebuilds, `bodies` may not have caught up with the
  // document (a reload, or an undo that brings a body back): absence there
  // is not deletion yet, so wait before calling anything missing.
  if (geometryPending) return { kind: 'pending' };
  const missing = ids.filter((id) => !bodies[id] || bodies[id].consumed);
  if (missing.length > 0)
    return {
      kind: 'missing',
      bodyNames: missing.map((id) => bodies[id]?.name ?? 'a deleted body')
    };
  if (!fingerprint) return { kind: 'pending' };
  return fingerprint === sheet.source.fingerprint
    ? { kind: 'ready', fingerprint }
    : { kind: 'stale', fingerprint };
}

function projectionKey(fingerprint: string, view: DrawingView): string {
  return `${fingerprint}|${view.orientation}|${view.hiddenLines}|${[...view.bodyIds].sort().join(',')}`;
}

const PAPER_SIZES = Object.keys(DRAWING_PAPER_SIZES_MM) as DrawingPaperSize[];

/** Projections for the sheet's views, cached by model and view intent. */
function useViewProjections(
  sheet: DrawingSheet | null,
  /** Every projection key some sheet draws of the current model. */
  wanted: ReadonlySet<string>,
  status: SheetStatus | null,
  bodies: DrawingWorkspaceProps['bodies']
): Map<DrawingViewId, ViewState> {
  const client = useRef<DrawingProjectionClient | null>(null);
  const cache = useRef(new Map<string, ViewState>());
  /** Failed requests per view, so a worker that keeps failing is not retried forever. */
  const failures = useRef(new Map<string, number>());
  const mounted = useRef(false);
  /**
   * One batch at a time: while one is out, a pass asks for nothing, and the
   * answer's revision runs the next pass for whatever the sheet on screen
   * still lacks. Nothing is ever superseded, so two requests can never take
   * turns cancelling each other's views.
   */
  const outstanding = useRef(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    mounted.current = true;
    const owned = new DrawingProjectionClient();
    client.current = owned;
    return () => {
      mounted.current = false;
      owned.dispose();
      client.current = null;
    };
  }, []);
  const fingerprint = status?.kind === 'ready' ? status.fingerprint : null;
  useEffect(() => {
    // Keep the cache to what this model's sheets still draw: a deleted view
    // or sheet (the last one included), or a view whose bodies or hidden
    // lines changed, frees its projection.
    for (const key of cache.current.keys())
      if (!wanted.has(key)) cache.current.delete(key);
    for (const key of failures.current.keys())
      if (!wanted.has(key)) failures.current.delete(key);
    if (!sheet || !fingerprint || !client.current || outstanding.current)
      return;
    // Every view this pass still needs goes in one request, with each body's
    // geometry once however many views draw it.
    const views: DrawingProjectionViewRequest[] = [];
    const inputs: Record<string, ProjectionBodyInput> = {};
    for (const view of sheet.views) {
      const key = projectionKey(fingerprint, view);
      if (cache.current.has(key) || views.some((entry) => entry.key === key))
        continue;
      for (const id of view.bodyIds) {
        const body = bodies[id];
        const input =
          body && !(id in inputs) ? projectionBodyInput(body) : null;
        if (input) inputs[id] = input;
      }
      views.push({
        key,
        orientation: view.orientation,
        hiddenLines: view.hiddenLines,
        bodyIds: [...view.bodyIds]
      });
      cache.current.set(key, { state: 'projecting' });
    }
    if (views.length > 0) {
      outstanding.current = true;
      client.current
        .project(inputs, views)
        .then(
          (results) => {
            for (const view of views) {
              const result = results[view.key];
              // An answer clears the transport-failure count: retries are
              // counted per run of failures, not over the key's lifetime.
              failures.current.delete(view.key);
              cache.current.set(
                view.key,
                result?.ok
                  ? { state: 'ready', projection: result.projection }
                  : {
                      state: 'error',
                      message: result?.error ?? 'Projection failed.'
                    }
              );
            }
          },
          (error: unknown) => {
            // The request itself failed — the worker closed under it or
            // stopped — not any one view: forget the views so the next pass
            // asks a fresh worker. A worker that keeps failing gets two more
            // tries before the views show the error. A closed client (an
            // unmount, React's development remount) never counts.
            const aborted =
              error instanceof Error && error.name === 'AbortError';
            for (const view of views) {
              const tries = (failures.current.get(view.key) ?? 0) + 1;
              if (!aborted) failures.current.set(view.key, tries);
              if (aborted || tries < 3) cache.current.delete(view.key);
              else
                cache.current.set(view.key, {
                  state: 'error',
                  message:
                    error instanceof Error
                      ? error.message
                      : 'Projection failed.'
                });
            }
          }
        )
        .finally(() => {
          outstanding.current = false;
          if (mounted.current) setRevision((value) => value + 1);
        });
    }
    // `revision` re-runs this pass after each answer, which re-requests any
    // view whose request was dropped.
  }, [sheet, wanted, fingerprint, bodies, revision]);
  const states = new Map<DrawingViewId, ViewState>();
  if (sheet && fingerprint)
    for (const view of sheet.views) {
      const entry = cache.current.get(projectionKey(fingerprint, view));
      if (entry) states.set(view.viewId, entry);
    }
  return states;
}

function statusMessage(status: SheetStatus): string | null {
  switch (status.kind) {
    case 'ready':
      return null;
    case 'pending':
      return 'Waiting for the model to finish updating.';
    case 'stale':
      return 'The model changed since this sheet was drawn. Update it to redraw the views.';
    case 'missing':
      return `This sheet draws ${status.bodyNames.join(', ')}, which no longer exists as a body. Remove it from the views that use it.`;
  }
}

function svgPoints(points: number[], height: number): string {
  const out: string[] = [];
  for (let i = 0; i + 1 < points.length; i += 2)
    out.push(
      `${points[i]!.toFixed(3)},${(height - points[i + 1]!).toFixed(3)}`
    );
  return out.join(' ');
}

function TextField(props: {
  label: string;
  value: string;
  placeholder?: string;
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = () => {
    if (draft !== props.value) props.onCommit(draft);
  };
  return (
    <label className="drawing-field">
      <span>{props.label}</span>
      <input
        type="text"
        value={draft}
        placeholder={props.placeholder}
        maxLength={MAX_DRAWING_TEXT_LENGTH}
        disabled={props.disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') setDraft(props.value);
        }}
      />
    </label>
  );
}

function NumberField(props: {
  label: string;
  value: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(props.value.toFixed(1));
  useEffect(() => setDraft(props.value.toFixed(1)), [props.value]);
  const commit = () => {
    const value = Number(draft);
    if (Number.isFinite(value) && Math.abs(value - props.value) > 1e-9)
      props.onCommit(value);
    else setDraft(props.value.toFixed(1));
  };
  return (
    <label className="drawing-field">
      <span>{props.label}</span>
      <input
        type="number"
        step={0.5}
        value={draft}
        disabled={props.disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
        }}
      />
    </label>
  );
}

const TITLE_FIELDS: { key: keyof DrawingTitleBlock; label: string }[] = [
  { key: 'title', label: 'Title' },
  { key: 'drawingNumber', label: 'Drawing no.' },
  { key: 'revision', label: 'Revision' },
  { key: 'author', label: 'Drawn by' },
  { key: 'date', label: 'Date' }
];

const NO_SHEETS: readonly DrawingSheet[] = [];

export function DrawingWorkspace(props: DrawingWorkspaceProps) {
  const { document, bodies, editDisabledReason } = props;
  const sheets = document.drawings?.sheets ?? NO_SHEETS;
  const [selectedSheetId, setSelectedSheetId] = useState<DrawingSheetId | null>(
    sheets[0]?.sheetId ?? null
  );
  const sheet =
    sheets.find((entry) => entry.sheetId === selectedSheetId) ??
    sheets[0] ??
    null;
  const [selectedViewId, setSelectedViewId] = useState<DrawingViewId | null>(
    null
  );
  const selectedView =
    sheet?.views.find((view) => view.viewId === selectedViewId) ?? null;
  const [addOrientation, setAddOrientation] =
    useState<DrawingViewOrientation>('front');
  const [drag, setDrag] = useState<{
    sheetId: DrawingSheetId;
    viewId: DrawingViewId;
    start: { x: number; y: number };
    origin: { x: number; y: number };
    current: { x: number; y: number };
    pxPerMm: number;
  } | null>(null);
  // A drag only counts while its view is still on the sheet shown: a delete,
  // an undo or a sheet switch mid-drag must not move (or preview) a view
  // that is gone.
  const liveDrag =
    drag &&
    sheet?.sheetId === drag.sheetId &&
    sheet.views.some((view) => view.viewId === drag.viewId)
      ? drag
      : null;
  const canvasRef = useRef<SVGSVGElement | null>(null);
  const editable = editDisabledReason === null;
  // Fingerprinting sorts every face and edge hash: once per model or sheet
  // change, never per pointer move of a drag.
  // Each sheet under its own bodies' fingerprint: sheets drawing different
  // bodies keep their projections apart, and switching between them reuses
  // them.
  const fingerprints = useMemo(
    () =>
      new Map(
        sheets.map((entry) => [
          entry.sheetId,
          props.geometryPending
            ? null
            : drawingSourceFingerprint(bodies, sheetBodyIds(entry))
        ])
      ),
    [sheets, bodies, props.geometryPending]
  );
  const wanted = useMemo(() => {
    const keys = new Set<string>();
    for (const entry of sheets) {
      const fingerprint = fingerprints.get(entry.sheetId);
      if (fingerprint)
        for (const view of entry.views)
          keys.add(projectionKey(fingerprint, view));
    }
    return keys;
  }, [sheets, fingerprints]);
  const status = useMemo(
    () =>
      sheet
        ? sheetStatus(
            sheet,
            bodies,
            props.geometryPending,
            fingerprints.get(sheet.sheetId) ?? null
          )
        : null,
    [sheet, bodies, props.geometryPending, fingerprints]
  );
  const projections = useViewProjections(sheet, wanted, status, bodies);
  const liveBodies = useMemo(
    () =>
      document.bodyOrder.filter((id) => {
        const body = bodies[id];
        return body && !body.consumed;
      }),
    [document.bodyOrder, bodies]
  );

  // The sheet as drawn: during a drag, the moved view (and the projected
  // views it carries) at the pointer, by the same rule the command applies.
  const shownSheet = useMemo(() => {
    if (!sheet || !liveDrag) return sheet;
    const moved = updateDrawingView(
      { ...document, drawings: { sheets: [sheet] } },
      {
        sheetId: sheet.sheetId,
        viewId: liveDrag.viewId,
        centerMm: liveDrag.current
      }
    );
    return moved.drawings!.sheets[0]!;
  }, [sheet, liveDrag, document]);

  const run = (command: AnyCommand) => {
    if (!editable) {
      props.onStatus(editDisabledReason ?? 'Drawing edits are unavailable.');
      return false;
    }
    return props.onCommand(command);
  };

  const createSheet = () => {
    // The bodies on screen, exactly: hiding every body is a choice, not a
    // reason to draw the hidden ones.
    const bodyIds = props.defaultBodyIds.filter((id) =>
      liveBodies.includes(id)
    );
    if (bodyIds.length === 0) {
      props.onStatus(
        liveBodies.length === 0
          ? 'Add a body to the model before making a drawing.'
          : 'Show at least one body to make a drawing of it.'
      );
      return;
    }
    const fingerprint = drawingSourceFingerprint(bodies, bodyIds);
    if (!fingerprint || props.geometryPending) {
      props.onStatus(
        'Wait for the model to finish updating, then make the drawing.'
      );
      return;
    }
    const paper = defaultDrawingPaper(document.units);
    let created: DrawingSheet;
    try {
      created = createStarterSheet({
        name: `Sheet ${sheets.length + 1}`,
        bodyIds,
        bodies,
        units: document.units,
        paper: { size: paper.size, orientation: 'landscape' },
        projectionAngle: paper.projectionAngle,
        fingerprint
      });
    } catch (error) {
      props.onStatus(
        error instanceof Error ? error.message : 'The sheet could not be made.'
      );
      return;
    }
    if (run(commandFactories.addDrawingSheet({ sheet: created })))
      setSelectedSheetId(created.sheetId);
  };

  const updateSheet = (
    patch: Omit<
      Parameters<typeof commandFactories.updateDrawingSheet>[0],
      'sheetId'
    >,
    label?: string
  ) => {
    if (!sheet) return;
    run(
      commandFactories.updateDrawingSheet(
        { sheetId: sheet.sheetId, ...patch },
        label
      )
    );
  };

  const moveView = (
    viewId: DrawingViewId,
    centerMm: { x: number; y: number }
  ) => {
    if (!sheet) return;
    run(
      commandFactories.updateDrawingView({
        sheetId: sheet.sheetId,
        viewId,
        centerMm: {
          x: Math.round(centerMm.x * 10) / 10,
          y: Math.round(centerMm.y * 10) / 10
        }
      })
    );
  };

  const addView = () => {
    if (!sheet) return;
    const bodyIds =
      selectedView?.bodyIds ?? sheet.views[0]?.bodyIds ?? props.defaultBodyIds;
    const base = sheet.views.find(
      (view) =>
        view.parentViewId === undefined &&
        drawingViewAlignment(view.orientation, addOrientation) !== null
    );
    const area = sheetViewArea(sheet);
    const viewBodies = bodyIds.filter((id) => liveBodies.includes(id));
    // A projected view goes beside its base, on the side the projection
    // angle gives it, clear of the base by a gap; anything else starts in
    // the middle of the sheet.
    let centerMm = { x: area.x + area.width / 2, y: area.y + area.height / 2 };
    if (base) {
      const side = projectedViewSide(
        base.orientation,
        addOrientation,
        sheet.projectionAngle
      );
      const k = drawingPaperPerModelUnit(sheet.scale, document.units);
      const baseBox = estimateViewExtent(
        bodies,
        base.bodyIds,
        base.orientation
      );
      const box = estimateViewExtent(bodies, viewBodies, addOrientation);
      const gap = 15;
      if (drawingViewAlignment(base.orientation, addOrientation) === 'row') {
        const half =
          ((baseBox?.maxU ?? 0) -
            (baseBox?.minU ?? 0) +
            ((box?.maxU ?? 0) - (box?.minU ?? 0))) *
          k *
          0.5;
        centerMm = {
          x: base.centerMm.x + side * (half + gap),
          y: base.centerMm.y
        };
      } else {
        const half =
          ((baseBox?.maxV ?? 0) -
            (baseBox?.minV ?? 0) +
            ((box?.maxV ?? 0) - (box?.minV ?? 0))) *
          k *
          0.5;
        centerMm = {
          x: base.centerMm.x,
          y: base.centerMm.y + side * (half + gap)
        };
      }
    }
    const view: DrawingView = {
      viewId: createDrawingViewId(),
      orientation: addOrientation,
      bodyIds: viewBodies,
      centerMm,
      hiddenLines: addOrientation !== 'iso',
      ...(base ? { parentViewId: base.viewId } : {})
    };
    if (view.bodyIds.length === 0) {
      props.onStatus('Pick at least one body for the view.');
      return;
    }
    if (run(commandFactories.addDrawingView({ sheetId: sheet.sheetId, view })))
      setSelectedViewId(view.viewId);
  };

  const exportSheet = async (format: 'pdf' | 'svg') => {
    if (!sheet || status?.kind !== 'ready') return;
    const ready = sheet.views.map((view) => {
      const state = projections.get(view.viewId);
      return state?.state === 'ready'
        ? { view, projection: state.projection }
        : null;
    });
    if (ready.some((entry) => entry === null)) {
      props.onStatus('Wait for every view to finish drawing, then export.');
      return;
    }
    const page = composeSheetPage(
      sheet,
      ready.filter((entry) => entry !== null),
      { projectName: document.name, units: document.units }
    );
    const fileName = drawingExportFileName(document.name, sheet.name, format);
    try {
      const saved =
        format === 'pdf'
          ? await saveCadBinaryFile(
              fileName,
              'pdf',
              sheetPageToPdf(page, sheet.name) as Uint8Array<ArrayBuffer>
            )
          : await saveCadTextFile(
              fileName,
              'svg',
              sheetPageToSvg(page, sheet.name)
            );
      props.onStatus(
        saved
          ? `Exported the drawing to ${fileName}.`
          : 'Drawing export cancelled.'
      );
    } catch (error) {
      props.onStatus(
        error instanceof Error ? error.message : 'Drawing export failed.'
      );
    }
  };

  const onViewPointerDown = (
    event: ReactPointerEvent<SVGRectElement>,
    view: DrawingView
  ) => {
    setSelectedViewId(view.viewId);
    if (!editable || event.button !== 0 || !sheet || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const paper = drawingPaperMm(sheet.paper);
    const pxPerMm = Math.min(
      rect.width / paper.width,
      rect.height / paper.height
    );
    if (!(pxPerMm > 0)) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({
      sheetId: sheet.sheetId,
      viewId: view.viewId,
      start: { x: event.clientX, y: event.clientY },
      origin: view.centerMm,
      current: view.centerMm,
      pxPerMm
    });
  };
  const onViewPointerMove = (event: ReactPointerEvent<SVGRectElement>) => {
    if (!drag) return;
    setDrag({
      ...drag,
      current: {
        x: drag.origin.x + (event.clientX - drag.start.x) / drag.pxPerMm,
        y: drag.origin.y - (event.clientY - drag.start.y) / drag.pxPerMm
      }
    });
  };
  const onViewPointerUp = () => {
    setDrag(null);
    if (!liveDrag) return;
    const moved =
      Math.hypot(
        liveDrag.current.x - liveDrag.origin.x,
        liveDrag.current.y - liveDrag.origin.y
      ) >= 0.2;
    if (moved) moveView(liveDrag.viewId, liveDrag.current);
  };
  const onCanvasKeyDown = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    if (!selectedView || !sheet) return;
    const step = event.shiftKey ? 10 : 1;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step]
    };
    const move = delta[event.key];
    // Keys the sheet handles stop here: the workspace's window shortcuts
    // (Delete removes a selected measurement, arrows nudge the model) must
    // not act on the same press.
    if (move) {
      event.preventDefault();
      event.stopPropagation();
      // A projected view moves only along its free axis; a press along the
      // axis it shares with its base is not a move at all.
      const base = selectedView.parentViewId
        ? sheet.views.find((view) => view.viewId === selectedView.parentViewId)
        : undefined;
      const alignment = base
        ? drawingViewAlignment(base.orientation, selectedView.orientation)
        : null;
      if (
        (alignment === 'row' && move[0] === 0) ||
        (alignment === 'column' && move[1] === 0)
      )
        return;
      moveView(selectedView.viewId, {
        x: selectedView.centerMm.x + move[0],
        y: selectedView.centerMm.y + move[1]
      });
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      if (
        run(
          commandFactories.deleteDrawingView({
            sheetId: sheet.sheetId,
            viewId: selectedView.viewId
          })
        )
      )
        setSelectedViewId(null);
    }
  };

  const page: SheetPage | null = useMemo(() => {
    if (!shownSheet) return null;
    const ready = shownSheet.views.flatMap((view) => {
      const state = projections.get(view.viewId);
      return state?.state === 'ready'
        ? [{ view, projection: state.projection }]
        : [];
    });
    return composeSheetPage(shownSheet, ready, {
      projectName: document.name,
      units: document.units
    });
  }, [shownSheet, projections, document.name, document.units]);

  if (!sheet || !shownSheet || !page || !status) {
    return (
      <section className="drawing-workspace" aria-label="Drawings">
        <div className="drawing-empty">
          <h2>Drawings</h2>
          <p>
            A drawing sheet lays out front, top, side and isometric views of the
            model with hidden lines, on paper you can export as PDF or SVG.
          </p>
          <button
            type="button"
            className="primary"
            onClick={createSheet}
            disabled={!editable}
            title={editDisabledReason ?? undefined}
          >
            <Plus size={14} aria-hidden="true" /> New drawing sheet
          </button>
        </div>
      </section>
    );
  }

  const paper = drawingPaperMm(sheet.paper);
  const message = statusMessage(status);
  const exportReason =
    status.kind !== 'ready'
      ? message
      : sheet.views.some(
            (view) => projections.get(view.viewId)?.state !== 'ready'
          )
        ? 'Drawing the views…'
        : null;
  const scaleOptions = DRAWING_SCALE_PRESETS.some(
    (scale) => formatDrawingScale(scale) === formatDrawingScale(sheet.scale)
  )
    ? DRAWING_SCALE_PRESETS
    : [...DRAWING_SCALE_PRESETS, sheet.scale];
  const block = titleBlockBox(sheet);

  return (
    <section className="drawing-workspace" aria-label="Drawings">
      <aside className="drawing-sheets" aria-label="Sheets">
        <div className="drawing-panel-section">
          <div className="drawing-panel-heading">
            <h3>Sheets</h3>
            <button
              type="button"
              className="secondary"
              onClick={createSheet}
              disabled={!editable}
              title={
                editDisabledReason ?? 'New sheet with the four standard views'
              }
            >
              <Plus size={13} aria-hidden="true" /> New
            </button>
          </div>
          <div
            className="drawing-sheet-list"
            role="listbox"
            aria-label="Drawing sheets"
          >
            {sheets.map((entry) => (
              <button
                key={entry.sheetId}
                type="button"
                role="option"
                aria-selected={entry.sheetId === sheet.sheetId}
                className={`drawing-sheet-item${entry.sheetId === sheet.sheetId ? ' active' : ''}`}
                onClick={() => {
                  setSelectedSheetId(entry.sheetId);
                  setSelectedViewId(null);
                }}
              >
                {entry.name}
              </button>
            ))}
          </div>
        </div>
      </aside>
      <div className="drawing-stage">
        {message && (
          <div className={`drawing-banner is-${status.kind}`} role="status">
            <span>{message}</span>
            {status.kind === 'stale' && (
              <button
                type="button"
                className="primary"
                disabled={!editable}
                onClick={() =>
                  updateSheet({ source: { fingerprint: status.fingerprint } })
                }
              >
                <RefreshCw size={13} aria-hidden="true" /> Update
              </button>
            )}
          </div>
        )}
        <svg
          ref={canvasRef}
          className="drawing-canvas"
          role="application"
          aria-label={`Sheet ${sheet.name}`}
          tabIndex={0}
          viewBox={`0 0 ${paper.width} ${paper.height}`}
          preserveAspectRatio="xMidYMid meet"
          onKeyDown={onCanvasKeyDown}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setSelectedViewId(null);
          }}
        >
          <rect
            className="drawing-paper"
            width={paper.width}
            height={paper.height}
          />
          {(['border', 'thin', 'hidden', 'visible'] as const).map((kind) => (
            <g key={kind} className={`drawing-strokes is-${kind}`}>
              {page.strokes
                .filter((stroke) => stroke.kind === kind)
                .map((stroke, index) =>
                  stroke.closed ? (
                    <polygon
                      key={index}
                      points={svgPoints(stroke.points, paper.height)}
                    />
                  ) : (
                    <polyline
                      key={index}
                      points={svgPoints(stroke.points, paper.height)}
                    />
                  )
                )}
            </g>
          ))}
          <g className="drawing-texts">
            {page.texts.map((text, index) => (
              <text
                key={index}
                x={text.x}
                y={paper.height - text.y}
                fontSize={text.sizeMm / 0.718}
                fontWeight={text.bold ? 'bold' : undefined}
              >
                {text.text}
              </text>
            ))}
          </g>
          {shownSheet.views.map((view) => {
            const state = projections.get(view.viewId);
            const extent =
              state?.state === 'ready' && state.projection.bounds
                ? state.projection.bounds
                : estimateViewExtent(bodies, view.bodyIds, view.orientation);
            if (!extent) return null;
            const box = viewPageBox(view, extent, shownSheet, document.units);
            const pad = 3;
            const ready = state?.state === 'ready';
            const label = DRAWING_VIEW_LABELS[view.orientation];
            return (
              <g
                key={view.viewId}
                className={`drawing-view${view.viewId === selectedViewId ? ' is-selected' : ''}${ready ? '' : ' is-placeholder'}`}
                data-view={view.orientation}
              >
                {!ready && (
                  <rect
                    className="drawing-view-outline"
                    x={box.x}
                    y={paper.height - box.y - box.height}
                    width={box.width}
                    height={box.height}
                  />
                )}
                <text
                  className="drawing-view-label"
                  x={box.x}
                  y={paper.height - box.y + 5}
                >
                  {state?.state === 'error'
                    ? `${label} — ${state.message}`
                    : ready || status.kind !== 'ready'
                      ? label
                      : `${label} — drawing…`}
                </text>
                <rect
                  className="drawing-view-hit"
                  role="button"
                  aria-label={`${label} view`}
                  aria-pressed={view.viewId === selectedViewId}
                  x={box.x - pad}
                  y={paper.height - box.y - box.height - pad}
                  width={box.width + 2 * pad}
                  height={box.height + 2 * pad}
                  onPointerDown={(event) => onViewPointerDown(event, view)}
                  onPointerMove={onViewPointerMove}
                  onPointerUp={onViewPointerUp}
                  onPointerCancel={() => setDrag(null)}
                />
              </g>
            );
          })}
          <rect
            className="drawing-title-hit"
            x={block.x}
            y={paper.height - block.y - block.height}
            width={block.width}
            height={block.height}
            onPointerDown={() => setSelectedViewId(null)}
          />
        </svg>
      </div>
      <aside className="drawing-panel" aria-label="Drawing properties">
        <div className="drawing-panel-section">
          <h3>Sheet</h3>
          <TextField
            label="Name"
            value={sheet.name}
            disabled={!editable}
            onCommit={(name) =>
              name.trim() &&
              updateSheet({ name }, `Rename drawing to ${name.trim()}`)
            }
          />
          <div className="drawing-field-row">
            <label className="drawing-field">
              <span>Paper</span>
              <select
                value={sheet.paper.size}
                disabled={!editable}
                onChange={(event) =>
                  updateSheet({
                    paper: {
                      ...sheet.paper,
                      size: event.target.value as DrawingPaperSize
                    }
                  })
                }
              >
                {PAPER_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {DRAWING_PAPER_LABELS[size]}
                  </option>
                ))}
              </select>
            </label>
            <label className="drawing-field">
              <span>Orientation</span>
              <select
                value={sheet.paper.orientation}
                disabled={!editable}
                onChange={(event) =>
                  updateSheet({
                    paper: {
                      ...sheet.paper,
                      orientation: event.target
                        .value as DrawingSheet['paper']['orientation']
                    }
                  })
                }
              >
                <option value="landscape">Landscape</option>
                <option value="portrait">Portrait</option>
              </select>
            </label>
          </div>
          <div className="drawing-field-row">
            <label className="drawing-field">
              <span>Scale</span>
              <select
                value={formatDrawingScale(sheet.scale)}
                disabled={!editable}
                onChange={(event) => {
                  const scale = scaleOptions.find(
                    (option) =>
                      formatDrawingScale(option) === event.target.value
                  );
                  if (scale) updateSheet({ scale });
                }}
              >
                {scaleOptions.map((scale) => (
                  <option
                    key={formatDrawingScale(scale)}
                    value={formatDrawingScale(scale)}
                  >
                    {formatDrawingScale(scale)}
                  </option>
                ))}
              </select>
            </label>
            <label className="drawing-field">
              <span>Projection</span>
              <select
                value={sheet.projectionAngle}
                disabled={!editable}
                onChange={(event) =>
                  updateSheet({
                    projectionAngle: event.target
                      .value as DrawingSheet['projectionAngle']
                  })
                }
              >
                <option value="first">First angle</option>
                <option value="third">Third angle</option>
              </select>
            </label>
          </div>
        </div>
        <div className="drawing-panel-section">
          <h3>Title block</h3>
          {TITLE_FIELDS.map(({ key, label }) => (
            <TextField
              key={key}
              label={label}
              value={sheet.titleBlock[key] ?? ''}
              placeholder={key === 'title' ? document.name : undefined}
              disabled={!editable}
              onCommit={(value) =>
                updateSheet({ titleBlock: { [key]: value } })
              }
            />
          ))}
        </div>
        <div className="drawing-panel-section">
          <h3>
            {selectedView
              ? `${DRAWING_VIEW_LABELS[selectedView.orientation]} view`
              : 'Views'}
          </h3>
          {/* Every view, whether or not it is on the page: a view left off
              the paper (a smaller sheet, an old document) can still be
              picked here, then moved back or deleted. */}
          <div
            className="drawing-view-list"
            role="listbox"
            aria-label="Views on this sheet"
          >
            {sheet.views.map((view) => {
              const off =
                view.centerMm.x < 0 ||
                view.centerMm.y < 0 ||
                view.centerMm.x > paper.width ||
                view.centerMm.y > paper.height;
              return (
                <button
                  key={view.viewId}
                  type="button"
                  role="option"
                  aria-selected={view.viewId === selectedViewId}
                  className={`drawing-sheet-item${view.viewId === selectedViewId ? ' active' : ''}`}
                  onClick={() => setSelectedViewId(view.viewId)}
                >
                  {DRAWING_VIEW_LABELS[view.orientation]}
                  {off ? ' (off the page)' : ''}
                </button>
              );
            })}
          </div>
          {selectedView ? (
            <>
              <div className="drawing-field-row">
                <NumberField
                  label="Centre X (mm)"
                  value={selectedView.centerMm.x}
                  disabled={!editable}
                  onCommit={(x) =>
                    moveView(selectedView.viewId, {
                      ...selectedView.centerMm,
                      x
                    })
                  }
                />
                <NumberField
                  label="Centre Y (mm)"
                  value={selectedView.centerMm.y}
                  disabled={!editable}
                  onCommit={(y) =>
                    moveView(selectedView.viewId, {
                      ...selectedView.centerMm,
                      y
                    })
                  }
                />
              </div>
              {selectedView.parentViewId && (
                <p className="drawing-hint">
                  Projected from the{' '}
                  {DRAWING_VIEW_LABELS[
                    sheet.views.find(
                      (view) => view.viewId === selectedView.parentViewId
                    )!.orientation
                  ].toLowerCase()}{' '}
                  view: it stays aligned with it.
                </p>
              )}
              <label className="drawing-check">
                <input
                  type="checkbox"
                  checked={selectedView.hiddenLines}
                  disabled={!editable}
                  onChange={(event) =>
                    run(
                      commandFactories.updateDrawingView({
                        sheetId: sheet.sheetId,
                        viewId: selectedView.viewId,
                        hiddenLines: event.target.checked
                      })
                    )
                  }
                />
                Hidden lines
              </label>
              <fieldset className="drawing-bodies">
                <legend>Bodies</legend>
                {[
                  ...liveBodies,
                  // Bodies the view still names but the model no longer
                  // has: listed so they can be unticked, which is how a
                  // sheet blocked on a deleted body is repaired.
                  ...selectedView.bodyIds.filter(
                    (id) => !liveBodies.includes(id)
                  )
                ].map((id) => (
                  <label key={id} className="drawing-check">
                    <input
                      type="checkbox"
                      checked={selectedView.bodyIds.includes(id)}
                      disabled={
                        !editable ||
                        // Not offered for removal until the rebuild says
                        // whether it is really gone.
                        (props.geometryPending && !liveBodies.includes(id)) ||
                        (selectedView.bodyIds.length === 1 &&
                          selectedView.bodyIds[0] === id)
                      }
                      onChange={(event) =>
                        run(
                          commandFactories.updateDrawingView({
                            sheetId: sheet.sheetId,
                            viewId: selectedView.viewId,
                            bodyIds: event.target.checked
                              ? [...selectedView.bodyIds, id]
                              : selectedView.bodyIds.filter(
                                  (entry) => entry !== id
                                )
                          })
                        )
                      }
                    />
                    {liveBodies.includes(id)
                      ? (bodies[id]?.name ?? id)
                      : props.geometryPending
                        ? `${bodies[id]?.name ?? 'Body'} (updating…)`
                        : `${bodies[id]?.name ?? 'Deleted body'} (no longer in the model)`}
                  </label>
                ))}
              </fieldset>
              <button
                type="button"
                className="secondary"
                disabled={!editable}
                onClick={() => {
                  if (
                    run(
                      commandFactories.deleteDrawingView({
                        sheetId: sheet.sheetId,
                        viewId: selectedView.viewId
                      })
                    )
                  )
                    setSelectedViewId(null);
                }}
              >
                <Trash2 size={13} aria-hidden="true" /> Delete view
              </button>
            </>
          ) : (
            <p className="drawing-hint">
              Select a view on the sheet to move it or change what it shows.
              Drag it, or use the arrow keys (Shift for 10 mm).
            </p>
          )}
          <div className="drawing-field-row">
            <label className="drawing-field">
              <span>New view</span>
              <select
                value={addOrientation}
                disabled={!editable}
                onChange={(event) =>
                  setAddOrientation(
                    event.target.value as DrawingViewOrientation
                  )
                }
              >
                {DRAWING_VIEW_ORIENTATIONS.map((orientation) => (
                  <option key={orientation} value={orientation}>
                    {DRAWING_VIEW_LABELS[orientation]}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="secondary"
              disabled={!editable}
              onClick={addView}
            >
              <Plus size={13} aria-hidden="true" /> Add view
            </button>
          </div>
        </div>
        <div className="drawing-panel-section">
          <h3>Export</h3>
          <div className="drawing-field-row">
            <button
              type="button"
              className="primary"
              disabled={exportReason !== null}
              title={exportReason ?? 'Export this sheet as a vector PDF'}
              onClick={() => void exportSheet('pdf')}
            >
              <FileDown size={13} aria-hidden="true" /> PDF
            </button>
            <button
              type="button"
              className="secondary"
              disabled={exportReason !== null}
              title={exportReason ?? 'Export this sheet as SVG'}
              onClick={() => void exportSheet('svg')}
            >
              <FileDown size={13} aria-hidden="true" /> SVG
            </button>
          </div>
          <p className="drawing-hint">
            Lines come from the display tessellation and exact edge samples;
            curved outlines are approximate to the display tolerance.
          </p>
          <button
            type="button"
            className="secondary drawing-delete-sheet"
            disabled={!editable}
            onClick={() => {
              if (
                run(
                  commandFactories.deleteDrawingSheet({
                    sheetId: sheet.sheetId
                  })
                )
              )
                setSelectedSheetId(null);
            }}
          >
            <Trash2 size={13} aria-hidden="true" /> Delete sheet
          </button>
        </div>
      </aside>
    </section>
  );
}

export default DrawingWorkspace;
