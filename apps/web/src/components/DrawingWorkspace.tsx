import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react';
import { Crosshair, FileDown, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import { updateDrawingView } from '@openzcad/document-core';
import {
  createDrawingAnnotationId,
  createDrawingViewId,
  MAX_DRAWING_DIMENSION_DECIMALS,
  MAX_DRAWING_NOTE_LENGTH,
  type DrawingAnnotation,
  type DrawingAnnotationId,
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
import { pruneProjectionCache } from '../lib/drawing/projectionCache';
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
  type ComposedView,
  sheetViewArea,
  titleBlockBox,
  viewPageBox,
  type SheetPage
} from '../lib/drawing/sheetPage';
import {
  drawingExportFileName,
  sheetPageToPdf,
  sheetPageToSvg,
  sheetTextStart
} from '../lib/drawing/sheetExport';
import {
  annotationAnchor,
  composeSheetAnnotations,
  defaultDimensionDecimals,
  resolveDrawingAnnotation,
  resolveSheetAnnotations,
  type AnnotationResolution
} from '../lib/drawing/annotations';
import {
  ANNOTATION_TOOL_LABELS,
  annotationToolHint,
  applyAnnotationPick,
  draftAnnotation,
  draftRefusal,
  drawingViewSignature,
  drawnLines,
  hitEdge,
  pickableEdges,
  pickedEnough,
  repairedAnnotation,
  repairToolKind,
  startAnnotationTool,
  type AnnotationTool,
  type AnnotationToolKind,
  type PickableEdge
} from '../lib/drawing/annotationPicking';
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

/** What sheets not on screen may keep of their projections. */
const INACTIVE_PROJECTION_BYTES = 32 * 1024 * 1024;

function viewStateBytes(entry: ViewState): number {
  if (entry.state !== 'ready') return 0;
  let bytes = 0;
  for (const line of entry.projection.visible) bytes += line.byteLength;
  for (const line of entry.projection.hidden) bytes += line.byteLength;
  return bytes;
}

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
    // lines changed, frees its projection. Sheets not on screen keep theirs
    // only within a byte budget, least recently shown first out.
    pruneProjectionCache(
      cache.current,
      wanted,
      new Set(
        sheet && fingerprint
          ? sheet.views.map((view) => projectionKey(fingerprint, view))
          : []
      ),
      INACTIVE_PROJECTION_BYTES,
      viewStateBytes
    );
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
        // In the key's order: the lines come out in body order, and a view
        // whose bodies were removed and re-added must export the same bytes
        // whether its projection was cached or made after a reload.
        bodyIds: [...view.bodyIds].sort()
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
  maxLength?: number;
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
        maxLength={props.maxLength ?? MAX_DRAWING_TEXT_LENGTH}
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

const ANNOTATION_TOOLS: readonly AnnotationToolKind[] = [
  'horizontal',
  'vertical',
  'aligned',
  'radius',
  'diameter',
  'angle',
  'note'
];

const ANNOTATION_KIND_LABELS: Readonly<
  Record<DrawingAnnotation['kind'], string>
> = {
  linear: 'Dimension',
  radius: 'Radius',
  diameter: 'Diameter',
  angle: 'Angle',
  note: 'Note'
};

function annotationTitle(annotation: DrawingAnnotation): string {
  return annotation.kind === 'linear'
    ? `${ANNOTATION_TOOL_LABELS[annotation.direction]} dimension`
    : annotation.kind === 'note'
      ? 'Note'
      : `${ANNOTATION_KIND_LABELS[annotation.kind]} dimension`;
}

/** What the list and the canvas call an annotation: its value or text. */
function annotationName(
  annotation: DrawingAnnotation,
  resolution: AnnotationResolution | undefined,
  ready: boolean
): string {
  if (annotation.kind === 'note') return `Note: ${annotation.text}`;
  const title = annotationTitle(annotation);
  if (!ready) return title;
  return resolution?.ok
    ? `${title} ${resolution.resolved.label}`
    : `${title} (broken)`;
}

/**
 * D02 annotation tools and the selected annotation's properties. Values are
 * shown only while the sheet is ready: a stale sheet has not been redrawn
 * from the model they would be read from.
 */
function AnnotationPanel(props: {
  sheet: DrawingSheet;
  ready: boolean;
  editable: boolean;
  units: ProjectDocument['units'];
  tool: AnnotationTool | null;
  selected: DrawingAnnotation | null;
  resolutions: ReadonlyMap<DrawingAnnotationId, AnnotationResolution>;
  onTool: (tool: AnnotationTool | null) => void;
  onSelect: (annotationId: DrawingAnnotationId | null) => void;
  onUpdate: (annotation: DrawingAnnotation, label?: string) => void;
  onDelete: (annotation: DrawingAnnotation) => void;
}) {
  const { sheet, ready, editable, tool, selected } = props;
  const annotations = sheet.annotations ?? [];
  // Dimensions measure a view's geometry; a note on the paper needs none,
  // so a ready sheet with no views still takes one.
  const canAnnotate = ready && editable && sheet.views.length > 0;
  const canUseTool = (kind: AnnotationToolKind) =>
    kind === 'note' ? ready && editable : canAnnotate;
  const resolution = selected
    ? props.resolutions.get(selected.annotationId)
    : undefined;
  return (
    <>
      <div className="drawing-panel-section">
        <h3>Annotate</h3>
        <div
          className="drawing-tool-grid"
          role="toolbar"
          aria-label="Annotation tools"
        >
          {ANNOTATION_TOOLS.map((kind) => (
            <button
              key={kind}
              type="button"
              className={`drawing-tool${tool?.kind === kind && !tool.repairId ? ' active' : ''}`}
              aria-pressed={tool?.kind === kind && !tool.repairId}
              disabled={!canUseTool(kind)}
              title={
                canUseTool(kind)
                  ? `${ANNOTATION_TOOL_LABELS[kind]} ${kind === 'note' ? '' : 'dimension'}`.trim()
                  : !editable
                    ? 'Drawing edits are unavailable.'
                    : !ready
                      ? 'Update the sheet to annotate it.'
                      : 'Add a view to dimension it.'
              }
              onClick={() =>
                props.onTool(
                  tool?.kind === kind && !tool.repairId
                    ? null
                    : startAnnotationTool(kind)
                )
              }
            >
              {ANNOTATION_TOOL_LABELS[kind]}
            </button>
          ))}
        </div>
        {tool ? (
          <div className="drawing-tool-hint" role="status">
            <span>{annotationToolHint(tool)}</span>
            <button
              type="button"
              className="secondary"
              onClick={() => props.onTool(null)}
            >
              <X size={13} aria-hidden="true" /> Cancel
            </button>
          </div>
        ) : (
          <p className="drawing-hint">
            Dimensions read their values from the model and follow the
            sheet&apos;s Update.
          </p>
        )}
        {annotations.length > 0 && (
          <div
            className="drawing-view-list"
            role="listbox"
            aria-label="Annotations on this sheet"
          >
            {annotations.map((annotation) => {
              const entry = props.resolutions.get(annotation.annotationId);
              const broken = ready && entry !== undefined && !entry.ok;
              return (
                <button
                  key={annotation.annotationId}
                  type="button"
                  role="option"
                  aria-selected={
                    annotation.annotationId === selected?.annotationId
                  }
                  className={`drawing-sheet-item${annotation.annotationId === selected?.annotationId ? ' active' : ''}${broken ? ' is-broken' : ''}`}
                  onClick={() => props.onSelect(annotation.annotationId)}
                >
                  {annotationName(annotation, entry, ready)}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {selected && (
        <div className="drawing-panel-section">
          <h3>{annotationTitle(selected)}</h3>
          {!ready ? (
            <p className="drawing-hint">
              Update the sheet to read this from the model again.
            </p>
          ) : resolution && !resolution.ok ? (
            <p className="drawing-annotation-status" role="alert">
              Broken: {resolution.message} Re-pick what it measures, or delete
              it.
            </p>
          ) : resolution?.ok && selected.kind !== 'note' ? (
            <p className="drawing-annotation-value">
              {resolution.resolved.label}
              {selected.kind === 'angle' ? '' : ` ${props.units}`}
            </p>
          ) : null}
          {selected.kind === 'note' ? (
            <TextField
              label="Text"
              value={selected.text}
              maxLength={MAX_DRAWING_NOTE_LENGTH}
              disabled={!editable}
              onCommit={(text) =>
                text.trim() &&
                props.onUpdate({ ...selected, text: text.trim() }, 'Edit note')
              }
            />
          ) : (
            <label className="drawing-field">
              <span>Decimals</span>
              <select
                value={selected.decimals ?? ''}
                disabled={!editable}
                onChange={(event) => {
                  const { decimals: _previous, ...rest } = selected;
                  props.onUpdate(
                    event.target.value === ''
                      ? rest
                      : { ...rest, decimals: Number(event.target.value) },
                    'Format dimension'
                  );
                }}
              >
                <option value="">
                  Default (
                  {defaultDimensionDecimals(selected.kind, props.units)})
                </option>
                {Array.from(
                  { length: MAX_DRAWING_DIMENSION_DECIMALS + 1 },
                  (_, decimals) => (
                    <option key={decimals} value={decimals}>
                      {decimals}
                    </option>
                  )
                )}
              </select>
            </label>
          )}
          <div className="drawing-field-row">
            {(selected.kind !== 'note' || selected.leader) && (
              <button
                type="button"
                className="secondary"
                disabled={!canAnnotate}
                title="Pick the edges this measures again"
                onClick={() =>
                  props.onTool(
                    startAnnotationTool(
                      repairToolKind(selected),
                      selected.annotationId,
                      selected.viewId
                    )
                  )
                }
              >
                <Crosshair size={13} aria-hidden="true" /> Re-pick
              </button>
            )}
            <button
              type="button"
              className="secondary"
              disabled={!editable}
              onClick={() => props.onDelete(selected)}
            >
              <Trash2 size={13} aria-hidden="true" /> Delete
            </button>
          </div>
        </div>
      )}
    </>
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
  const [tool, setTool] = useState<AnnotationTool | null>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] =
    useState<DrawingAnnotationId | null>(null);
  /** Under the pointer while a tool is active: the edge and paper point. */
  const [hover, setHover] = useState<{
    edge: PickableEdge | null;
    point: [number, number];
  } | null>(null);
  const [annotationDrag, setAnnotationDrag] = useState<{
    sheetId: DrawingSheetId;
    annotationId: DrawingAnnotationId;
    start: { x: number; y: number };
    origin: { x: number; y: number };
    current: { x: number; y: number };
    pxPerMm: number;
  } | null>(null);
  const selectedAnnotation =
    sheet?.annotations?.find(
      (entry) => entry.annotationId === selectedAnnotationId
    ) ?? null;
  const liveAnnotationDrag =
    annotationDrag &&
    sheet?.sheetId === annotationDrag.sheetId &&
    sheet.annotations?.some(
      (entry) => entry.annotationId === annotationDrag.annotationId
    )
      ? annotationDrag
      : null;
  const canvasRef = useRef<SVGSVGElement | null>(null);
  const editable = editDisabledReason === null;
  // Fingerprinting sorts every face and edge hash: once per model or sheet
  // change, never per pointer move of a drag.
  // Each sheet under its own bodies' fingerprint: sheets drawing different
  // bodies keep their projections apart, and switching between them reuses
  // them.
  // A drawing edit replaces every sheet but changes no body, so the
  // fingerprints are kept per body set for as long as the bodies are the
  // same objects: fifty sheets of one body sort its hashes once, and a sheet
  // rename sorts nothing.
  const fingerprintCache = useRef<{
    bodies: DrawingWorkspaceProps['bodies'];
    byBodySet: Map<string, string | null>;
  }>({ bodies, byBodySet: new Map() });
  const fingerprints = useMemo(() => {
    if (fingerprintCache.current.bodies !== bodies)
      fingerprintCache.current = { bodies, byBodySet: new Map() };
    const { byBodySet } = fingerprintCache.current;
    return new Map(
      sheets.map((entry) => {
        if (props.geometryPending) return [entry.sheetId, null];
        const ids = sheetBodyIds(entry);
        const key = [...ids].sort().join(',');
        if (!byBodySet.has(key))
          byBodySet.set(key, drawingSourceFingerprint(bodies, ids));
        return [entry.sheetId, byBodySet.get(key)!];
      })
    );
  }, [sheets, bodies, props.geometryPending]);
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
    if (!sheet) return sheet;
    let shown = sheet;
    if (liveDrag)
      shown = updateDrawingView(
        { ...document, drawings: { sheets: [sheet] } },
        {
          sheetId: sheet.sheetId,
          viewId: liveDrag.viewId,
          centerMm: liveDrag.current
        }
      ).drawings!.sheets[0]!;
    if (liveAnnotationDrag && shown.annotations)
      shown = {
        ...shown,
        annotations: shown.annotations.map((entry) =>
          entry.annotationId === liveAnnotationDrag.annotationId
            ? { ...entry, placementMm: liveAnnotationDrag.current }
            : entry
        )
      };
    return shown;
  }, [sheet, liveDrag, liveAnnotationDrag, document]);
  // Every annotation against the current model. Only a ready sheet draws
  // or reports them: a stale one has not been redrawn from this model.
  const resolutions = useMemo(
    () =>
      shownSheet
        ? resolveSheetAnnotations(shownSheet, bodies, document.units)
        : new Map<DrawingAnnotationId, AnnotationResolution>(),
    [shownSheet, bodies, document.units]
  );
  const sheetReady = status?.kind === 'ready';
  // A tool picks from one sheet's drawn model: a sheet that stops being
  // ready (a collaborator's model edit, a rebuild), or another sheet taking
  // its place (an undo, a delete, a collaborator's edit), ends it rather
  // than keep picks made in views that sheet no longer has.
  const activeSheetId = sheet?.sheetId ?? null;
  useEffect(() => {
    setTool(null);
    setHover(null);
  }, [sheetReady, activeSheetId]);
  // Within one sheet, a tool also ends when the view it picked in, or the
  // annotation it is re-picking, goes away (a delete, an undo, a
  // collaborator): otherwise every later pick is refused as the wrong view.
  // So does a change to what that view draws (its hidden lines, its
  // bodies): a hidden edge picked with hidden lines on must not be placed
  // once they are off.
  const toolView = tool?.viewId
    ? sheet?.views.find((view) => view.viewId === tool.viewId)
    : undefined;
  const toolOrphaned =
    tool !== null &&
    ((tool.viewId !== undefined && !toolView) ||
      (toolView !== undefined &&
        tool.viewSignature !== undefined &&
        drawingViewSignature(toolView) !== tool.viewSignature) ||
      (tool.repairId !== undefined &&
        !sheet?.annotations?.some(
          (annotation) => annotation.annotationId === tool.repairId
        )));
  useEffect(() => {
    if (!toolOrphaned) return;
    setTool(null);
    setHover(null);
  }, [toolOrphaned]);
  /** `next` with the signature of the view it is pinned to, once it is. */
  const pinnedTool = (next: AnnotationTool): AnnotationTool => {
    if (!next.viewId || next.viewSignature !== undefined) return next;
    const view = sheet?.views.find((entry) => entry.viewId === next.viewId);
    return view ? { ...next, viewSignature: drawingViewSignature(view) } : next;
  };
  const brokenCount = sheetReady
    ? [...resolutions.values()].filter((entry) => !entry.ok).length
    : 0;

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
    const viewStates = sheet.views.map((view) => {
      const state = projections.get(view.viewId);
      return state?.state === 'ready'
        ? { view, projection: state.projection }
        : null;
    });
    if (viewStates.some((entry) => entry === null)) {
      props.onStatus('Wait for every view to finish drawing, then export.');
      return;
    }
    if (brokenCount > 0) {
      props.onStatus('Re-pick or delete the broken annotations, then export.');
      return;
    }
    const drawn = viewStates.filter((entry) => entry !== null);
    const page = composeSheetPage(
      sheet,
      drawn,
      { projectName: document.name, units: document.units },
      composeSheetAnnotations(sheet, drawn, resolutions, document.units)
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
    setSelectedAnnotationId(null);
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
    if (event.key === 'Escape' && tool) {
      event.preventDefault();
      event.stopPropagation();
      setTool(null);
      setHover(null);
      return;
    }
    if (selectedAnnotation && sheet) {
      const step = event.shiftKey ? 10 : 1;
      const delta: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, step],
        ArrowDown: [0, -step]
      };
      const move = delta[event.key];
      if (move) {
        event.preventDefault();
        event.stopPropagation();
        moveAnnotation(selectedAnnotation, {
          x: selectedAnnotation.placementMm.x + move[0],
          y: selectedAnnotation.placementMm.y + move[1]
        });
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        event.stopPropagation();
        deleteAnnotation(selectedAnnotation);
      }
      return;
    }
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

  const drawnViews: ComposedView[] = useMemo(
    () =>
      shownSheet
        ? shownSheet.views.flatMap((view) => {
            const state = projections.get(view.viewId);
            return state?.state === 'ready'
              ? [{ view, projection: state.projection }]
              : [];
          })
        : [],
    [shownSheet, projections]
  );
  const composed = useMemo(() => {
    if (!shownSheet) return null;
    const annotations = composeSheetAnnotations(
      shownSheet,
      drawnViews,
      resolutions,
      document.units
    );
    return {
      page: composeSheetPage(
        shownSheet,
        drawnViews,
        { projectName: document.name, units: document.units },
        annotations
      ),
      boxes: annotations.boxes
    };
  }, [shownSheet, drawnViews, resolutions, document.name, document.units]);
  const page: SheetPage | null = composed?.page ?? null;
  // Edges a tool can pick, kept while the drawn views and model are the same
  // objects: a pointer move re-renders, it must not re-project every edge.
  const pickCache = useRef<{
    views: ComposedView[];
    bodies: DrawingWorkspaceProps['bodies'];
    edges: PickableEdge[];
    drawn: ReturnType<typeof drawnLines>;
  } | null>(null);
  const currentPickable = (): {
    edges: PickableEdge[];
    drawn: ReturnType<typeof drawnLines>;
  } => {
    if (!shownSheet || !sheetReady) return { edges: [], drawn: new Map() };
    const cached = pickCache.current;
    if (
      cached &&
      cached.bodies === bodies &&
      cached.views.length === drawnViews.length &&
      cached.views.every(
        (entry, index) =>
          entry.view === drawnViews[index]!.view &&
          entry.projection === drawnViews[index]!.projection
      )
    )
      return cached;
    const entry = {
      views: drawnViews,
      bodies,
      edges: pickableEdges(shownSheet, drawnViews, bodies, document.units),
      drawn: drawnLines(shownSheet, drawnViews, document.units)
    };
    pickCache.current = entry;
    return entry;
  };
  const edgeAt = (point: [number, number], pxPerMm: number) => {
    const { edges, drawn } = currentPickable();
    return hitEdge(edges, point, pickTolerance(pxPerMm), drawn);
  };

  /** A pointer position in paper millimetres (y up), with the zoom. */
  const paperPoint = (event: {
    clientX: number;
    clientY: number;
  }): { point: [number, number]; pxPerMm: number } | null => {
    const svg = canvasRef.current;
    const ctm = svg?.getScreenCTM?.();
    if (!svg || !ctm || !shownSheet) return null;
    const inverse = ctm.inverse();
    const x = inverse.a * event.clientX + inverse.c * event.clientY + inverse.e;
    const y = inverse.b * event.clientX + inverse.d * event.clientY + inverse.f;
    return {
      point: [x, drawingPaperMm(shownSheet.paper).height - y],
      pxPerMm: Math.hypot(ctm.a, ctm.b)
    };
  };
  const viewAt = (point: [number, number]): DrawingView | null => {
    if (!shownSheet) return null;
    for (const { view, projection } of drawnViews) {
      if (!projection.bounds) continue;
      const box = viewPageBox(
        view,
        projection.bounds,
        shownSheet,
        document.units
      );
      if (
        point[0] >= box.x - 3 &&
        point[0] <= box.x + box.width + 3 &&
        point[1] >= box.y - 3 &&
        point[1] <= box.y + box.height + 3
      )
        return view;
    }
    return null;
  };
  const pickTolerance = (pxPerMm: number) => Math.max(0.8, 8 / pxPerMm);

  const commitAnnotation = (finished: AnnotationTool, at: [number, number]) => {
    if (!sheet) return;
    const view = finished.viewId
      ? sheet.views.find((entry) => entry.viewId === finished.viewId)
      : undefined;
    if (finished.viewId && !view) {
      // The view went away under the tool (an undo, a collaborator).
      setTool(null);
      props.onStatus('That view is no longer on this sheet.');
      return;
    }
    const round = (value: number) => Math.round(value * 10) / 10;
    const placementMm = view
      ? { x: round(at[0] - view.centerMm.x), y: round(at[1] - view.centerMm.y) }
      : { x: round(at[0]), y: round(at[1]) };
    const annotation = draftAnnotation(
      finished,
      createDrawingAnnotationId(),
      placementMm
    );
    if (!annotation) return;
    const refusal = draftRefusal(annotation, view, bodies, document.units);
    if (refusal) {
      props.onStatus(refusal);
      setTool(startAnnotationTool(finished.kind));
      return;
    }
    if (
      run(
        commandFactories.addDrawingAnnotation({
          sheetId: sheet.sheetId,
          annotation
        })
      )
    ) {
      setSelectedAnnotationId(annotation.annotationId);
      setSelectedViewId(null);
      // A note is placed and then typed; dimensions keep their tool for the
      // next one.
      setTool(
        finished.kind === 'note' ? null : startAnnotationTool(finished.kind)
      );
    }
  };
  const commitRepair = (finished: AnnotationTool) => {
    const previous = sheet?.annotations?.find(
      (entry) => entry.annotationId === finished.repairId
    );
    setTool(null);
    if (!sheet || !previous) return;
    const repaired = repairedAnnotation(previous, finished);
    if (!repaired) {
      props.onStatus('Re-pick in the view this annotation belongs to.');
      return;
    }
    const view = sheet.views.find((entry) => entry.viewId === repaired.viewId);
    const refusal = draftRefusal(repaired, view, bodies, document.units);
    if (refusal) {
      props.onStatus(refusal);
      return;
    }
    run(
      commandFactories.updateDrawingAnnotation(
        { sheetId: sheet.sheetId, annotation: repaired },
        repaired.kind === 'note' ? 'Re-pick note leader' : 'Re-pick dimension'
      )
    );
  };
  const onPickPointerMove = (event: ReactPointerEvent<SVGRectElement>) => {
    const at = paperPoint(event);
    if (!at || !tool) return;
    setHover({
      edge: pickedEnough(tool) ? null : edgeAt(at.point, at.pxPerMm),
      point: at.point
    });
  };
  const onPickPointerDown = (event: ReactPointerEvent<SVGRectElement>) => {
    if (event.button !== 0 || !tool) return;
    const at = paperPoint(event);
    if (!at) return;
    if (pickedEnough(tool)) {
      commitAnnotation(tool, at.point);
      return;
    }
    const hit = edgeAt(at.point, at.pxPerMm);
    const result = applyAnnotationPick(
      tool,
      hit,
      at.point,
      viewAt(at.point),
      bodies
    );
    if (!result.ok) {
      props.onStatus(result.message);
      return;
    }
    if (result.tool.repairId && pickedEnough(result.tool)) {
      commitRepair(result.tool);
      return;
    }
    if (result.tool.placed) {
      commitAnnotation(result.tool, at.point);
      return;
    }
    setTool(pinnedTool(result.tool));
    setHover({ edge: null, point: at.point });
  };

  const updateAnnotation = (annotation: DrawingAnnotation, label?: string) => {
    if (!sheet) return;
    run(
      commandFactories.updateDrawingAnnotation(
        { sheetId: sheet.sheetId, annotation },
        label
      )
    );
  };
  const deleteAnnotation = (annotation: DrawingAnnotation) => {
    if (!sheet) return;
    if (
      run(
        commandFactories.deleteDrawingAnnotation({
          sheetId: sheet.sheetId,
          annotationId: annotation.annotationId
        })
      )
    )
      setSelectedAnnotationId(null);
  };
  const moveAnnotation = (
    annotation: DrawingAnnotation,
    placementMm: { x: number; y: number }
  ) =>
    updateAnnotation(
      {
        ...annotation,
        placementMm: {
          x: Math.round(placementMm.x * 10) / 10,
          y: Math.round(placementMm.y * 10) / 10
        }
      },
      'Move annotation'
    );
  const onAnnotationPointerDown = (
    event: ReactPointerEvent<SVGElement>,
    annotation: DrawingAnnotation
  ) => {
    event.stopPropagation();
    setSelectedAnnotationId(annotation.annotationId);
    setSelectedViewId(null);
    if (!editable || event.button !== 0 || !sheet || tool) return;
    const at = paperPoint(event);
    if (!at) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setAnnotationDrag({
      sheetId: sheet.sheetId,
      annotationId: annotation.annotationId,
      start: { x: event.clientX, y: event.clientY },
      origin: annotation.placementMm,
      current: annotation.placementMm,
      pxPerMm: at.pxPerMm
    });
  };
  const onAnnotationPointerMove = (event: ReactPointerEvent<SVGElement>) => {
    if (!annotationDrag) return;
    setAnnotationDrag({
      ...annotationDrag,
      current: {
        x:
          annotationDrag.origin.x +
          (event.clientX - annotationDrag.start.x) / annotationDrag.pxPerMm,
        y:
          annotationDrag.origin.y -
          (event.clientY - annotationDrag.start.y) / annotationDrag.pxPerMm
      }
    });
  };
  const onAnnotationPointerUp = () => {
    setAnnotationDrag(null);
    if (!liveAnnotationDrag) return;
    const annotation = sheet?.annotations?.find(
      (entry) => entry.annotationId === liveAnnotationDrag.annotationId
    );
    const moved =
      Math.hypot(
        liveAnnotationDrag.current.x - liveAnnotationDrag.origin.x,
        liveAnnotationDrag.current.y - liveAnnotationDrag.origin.y
      ) >= 0.2;
    if (annotation && moved)
      moveAnnotation(annotation, liveAnnotationDrag.current);
  };

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
        : brokenCount > 0
          ? `${brokenCount === 1 ? 'An annotation has' : `${brokenCount} annotations have`} lost what ${brokenCount === 1 ? 'it measures' : 'they measure'}. Re-pick or delete ${brokenCount === 1 ? 'it' : 'them'} to export.`
          : null;
  const scaleOptions = DRAWING_SCALE_PRESETS.some(
    (scale) => formatDrawingScale(scale) === formatDrawingScale(sheet.scale)
  )
    ? DRAWING_SCALE_PRESETS
    : [...DRAWING_SCALE_PRESETS, sheet.scale];
  const block = titleBlockBox(sheet);
  // While a finished tool waits for its placement, the annotation follows
  // the pointer, laid out by the same rule the page uses.
  const preview = (() => {
    if (!tool || !pickedEnough(tool) || tool.repairId || !hover) return null;
    const view = tool.viewId
      ? shownSheet.views.find((entry) => entry.viewId === tool.viewId)
      : undefined;
    const placementMm = view
      ? {
          x: hover.point[0] - view.centerMm.x,
          y: hover.point[1] - view.centerMm.y
        }
      : { x: hover.point[0], y: hover.point[1] };
    const draft = draftAnnotation(
      tool,
      'dann_preview' as DrawingAnnotationId,
      placementMm
    );
    if (!draft) return null;
    return composeSheetAnnotations(
      { ...shownSheet, annotations: [draft] },
      drawnViews,
      new Map([
        [
          draft.annotationId,
          resolveDrawingAnnotation(draft, view, bodies, document.units)
        ]
      ]),
      document.units
    );
  })();

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
                  setSelectedAnnotationId(null);
                  setTool(null);
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
            if (event.target === event.currentTarget) {
              setSelectedViewId(null);
              setSelectedAnnotationId(null);
            }
          }}
        >
          <rect
            className="drawing-paper"
            width={paper.width}
            height={paper.height}
          />
          {(['border', 'thin', 'hidden', 'visible', 'dimension'] as const).map(
            (kind) => (
              <g key={kind} className={`drawing-strokes is-${kind}`}>
                {page.strokes
                  .filter((stroke) => stroke.kind === kind)
                  .map((stroke, index) =>
                    stroke.filled ? (
                      <polygon
                        key={index}
                        className="is-filled"
                        points={svgPoints(stroke.points, paper.height)}
                      />
                    ) : stroke.closed ? (
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
            )
          )}
          <g className="drawing-texts">
            {page.texts.map((text, index) => {
              const start = sheetTextStart(text);
              return (
                <text
                  key={index}
                  x={start.x}
                  y={paper.height - start.y}
                  fontSize={text.sizeMm / 0.718}
                  fontWeight={text.bold ? 'bold' : undefined}
                  transform={
                    text.angleDeg
                      ? `rotate(${-text.angleDeg} ${start.x} ${paper.height - start.y})`
                      : undefined
                  }
                >
                  {text.text}
                </text>
              );
            })}
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
            onPointerDown={() => {
              setSelectedViewId(null);
              setSelectedAnnotationId(null);
            }}
          />
          {(shownSheet.annotations ?? []).map((annotation) => {
            const id = annotation.annotationId;
            const box = composed?.boxes.get(id);
            const resolution = resolutions.get(id);
            const selectedClass =
              id === selectedAnnotationId ? ' is-selected' : '';
            const name = annotationName(annotation, resolution, sheetReady);
            const handlers = {
              onPointerDown: (event: ReactPointerEvent<SVGElement>) =>
                onAnnotationPointerDown(event, annotation),
              onPointerMove: onAnnotationPointerMove,
              onPointerUp: onAnnotationPointerUp,
              onPointerCancel: () => setAnnotationDrag(null)
            };
            if (box)
              return (
                <rect
                  key={id}
                  className={`drawing-annotation-hit${selectedClass}`}
                  role="button"
                  aria-label={name}
                  aria-pressed={id === selectedAnnotationId}
                  data-annotation={annotation.kind}
                  x={box.x}
                  y={paper.height - box.y - box.height}
                  width={box.width}
                  height={box.height}
                  {...handlers}
                />
              );
            // Broken: kept where it was placed, marked, and still
            // selectable so it can be re-picked or deleted.
            const view = annotation.viewId
              ? shownSheet.views.find(
                  (entry) => entry.viewId === annotation.viewId
                )
              : undefined;
            if (
              !sheetReady ||
              !resolution ||
              resolution.ok ||
              (view && projections.get(view.viewId)?.state !== 'ready')
            )
              return null;
            const [x, y] = annotationAnchor(annotation, view);
            return (
              <g
                key={id}
                className={`drawing-annotation-broken${selectedClass}`}
              >
                <text x={x} y={paper.height - y}>
                  {annotation.kind === 'note'
                    ? 'Broken leader'
                    : 'Broken dimension'}
                </text>
                <rect
                  className="drawing-annotation-hit"
                  role="button"
                  aria-label={name}
                  aria-pressed={id === selectedAnnotationId}
                  data-annotation={annotation.kind}
                  x={x - 1}
                  y={paper.height - y - 4}
                  width={30}
                  height={5.5}
                  {...handlers}
                />
              </g>
            );
          })}
          {tool && preview && (
            <g className="drawing-annotation-preview">
              {preview.strokes.map((stroke, index) => (
                <polyline
                  key={index}
                  className={stroke.filled ? 'is-filled' : undefined}
                  points={`${svgPoints(stroke.points, paper.height)}${stroke.filled ? ` ${svgPoints(stroke.points.slice(0, 2), paper.height)}` : ''}`}
                />
              ))}
              {preview.texts.map((text, index) => {
                const start = sheetTextStart(text);
                return (
                  <text
                    key={index}
                    x={start.x}
                    y={paper.height - start.y}
                    fontSize={text.sizeMm / 0.718}
                    transform={
                      text.angleDeg
                        ? `rotate(${-text.angleDeg} ${start.x} ${paper.height - start.y})`
                        : undefined
                    }
                  >
                    {text.text}
                  </text>
                );
              })}
            </g>
          )}
          {tool && hover?.edge && (
            <polyline
              className="drawing-pick-highlight"
              points={svgPoints(hover.edge.page.flat(), paper.height)}
            />
          )}
          {tool && (
            <rect
              className="drawing-pick-surface"
              data-tool={tool.kind}
              width={paper.width}
              height={paper.height}
              onPointerDown={onPickPointerDown}
              onPointerMove={onPickPointerMove}
              onPointerLeave={() => setHover(null)}
            />
          )}
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
        <AnnotationPanel
          sheet={sheet}
          ready={sheetReady}
          editable={editable}
          units={document.units}
          tool={tool}
          selected={selectedAnnotation}
          resolutions={resolutions}
          onTool={(next) => {
            setTool(next && pinnedTool(next));
            setHover(null);
            if (next) canvasRef.current?.focus();
          }}
          onSelect={(annotationId) => {
            setSelectedAnnotationId(annotationId);
            setSelectedViewId(null);
          }}
          onUpdate={updateAnnotation}
          onDelete={deleteAnnotation}
        />
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
                  onClick={() => {
                    setSelectedViewId(view.viewId);
                    setSelectedAnnotationId(null);
                  }}
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
          {brokenCount > 0 && (
            <p className="drawing-annotation-status" role="status">
              {exportReason}
            </p>
          )}
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
