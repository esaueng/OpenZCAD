import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react';
import {
  Angle,
  Crosshair,
  Diameter,
  FileDown,
  Maximize,
  Moon,
  MousePointer2,
  MoveDiagonal2,
  MoveHorizontal,
  MoveVertical,
  Plus,
  Radius,
  RefreshCw,
  Ruler,
  Scaling,
  Scissors,
  StickyNote,
  Sun,
  Trash2,
  TriangleRight,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon
} from 'lucide-react';
import {
  commandFactories,
  composeCommands,
  type AnyCommand
} from '@openzcad/command-system';
import { updateDrawingView } from '@openzcad/document-core';
import {
  createDrawingAnnotationId,
  createDrawingViewId,
  MAX_DRAWING_DIMENSION_COUNT,
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
  drawingSectionOrientations,
  drawingSectionPlane,
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
  type ProjectDocument,
  type Vector3
} from '@openzcad/shared';
import { pruneProjectionCache } from '../lib/drawing/projectionCache';
import {
  DrawingProjectionClient,
  type DrawingProjectionViewRequest
} from '../lib/drawing/projectionClient';
import {
  projectionBuffers,
  type ProjectionBodyInput,
  type ViewProjection
} from '../lib/drawing/projectView';
import {
  autoScaleSheet,
  composeSheetPage,
  sectionCaption,
  sectionLineOnPage,
  SHEET_STROKE_ORDER,
  type ComposedView,
  fitViewsToSheet,
  sheetUnprintableCharacters,
  sheetViewArea,
  titleBlockBox,
  viewPageBox,
  viewPlacementIssue,
  type SheetPage,
  type SheetStroke,
  type SheetText,
  type ViewExtent,
  type ViewPlacementIssue
} from '../lib/drawing/sheetPage';
import {
  fitSheetZoom,
  MAX_SHEET_ZOOM,
  panSheet,
  SHEET_ZOOM_STEP,
  sheetPxPerMm,
  sheetViewBox,
  wheelPixels,
  zoomSheetAt,
  type SheetZoom
} from '../lib/drawing/sheetZoom';
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
  markHiddenLeaders,
  previewAnnotationLayer,
  resolveSheetAnnotations,
  sectionBodyKey,
  type AnnotationBox,
  type AnnotationResolution
} from '../lib/drawing/annotations';
import {
  auditDrawingDimensions,
  type DrawingAudit
} from '../lib/drawing/dimensionAudit';
import {
  planAutoDimensions,
  type AutoDimensionPlan
} from '../lib/drawing/autoDimension';
import {
  ANNOTATION_TOOL_LABELS,
  annotationToolHint,
  applyAnnotationPick,
  draftAnnotation,
  draftRefusal,
  drawingViewSignature,
  drawnLines,
  drawnOutlines,
  hitEdge,
  hitFace,
  pickableEdges,
  pickableFaces,
  pickedEnough,
  repairedAnnotation,
  repairToolKind,
  startAnnotationTool,
  type AnnotationTool,
  type AnnotationToolKind,
  type PickableEdge,
  type PickableFace
} from '../lib/drawing/annotationPicking';
import {
  createStarterSheet,
  defaultDrawingPaper,
  drawingSourceFingerprint,
  estimateViewExtent,
  sectionInputKey,
  sectionPlaneKey,
  sheetBodyIds,
  type SectionBodyInput
} from '../lib/drawing/sheetSources';
import { saveCadBinaryFile, saveCadTextFile } from '../lib/desktopBridge';
import {
  sectionLineFromDrag,
  sectionPlacement,
  sectionSnapTargets,
  sectionSourceAt,
  type SectionLine
} from '../lib/drawing/sectionTool';
import {
  drawingAssistantDigest,
  type DrawingAssistantSource
} from '../lib/drawing/assistantContext';
import { drawingBodyReplacements } from '../lib/drawing/bodySuccessors';

/**
 * D01 drawing workspace: the sheet canvas and its properties.
 *
 * Every edit is a document command, so it undoes, saves and syncs like any
 * other. The canvas draws the same `SheetPage` the PDF and SVG writers
 * serialize — one page transform for preview and export.
 *
 * The model fence: a sheet remembers a fingerprint of the bodies it draws.
 * When the model no longer matches it, the sheet says so and offers an
 * explicit Update; it never quietly redraws a sheet someone may already have
 * handed off. Until then it keeps the drawing it last made of that model —
 * views, dimensions and export included — when this session has one, and
 * draws outlines only when it does not.
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
   * The rebuild's progress while `geometryPending`, when the geometry worker
   * reports one: the feature it is on, counted from 1.
   */
  rebuildProgress?: { name: string; index: number; total: number } | null;
  /**
   * Bodies a new sheet draws: the live bodies on screen, independent of the
   * selection and the export scope. Empty refuses the new sheet.
   */
  defaultBodyIds: BodyId[];
  /**
   * Each body's canonical drawing tessellation, from the geometry worker.
   * Views project from it, never from `bodies`' display meshes: the display
   * mesh holds an earlier deflection through small edits and meshes again at
   * the nominal one after a reload, so the same model could export
   * different bytes. This one depends only on the exact geometry. `signal`
   * aborts when the workspace closes, so the geometry worker drops work
   * nobody will see.
   */
  requestTessellation: (
    document: ProjectDocument,
    bodyIds: BodyId[],
    signal: AbortSignal
  ) => Promise<Record<string, ProjectionBodyInput>>;
  /**
   * D03: each body cut exactly by a section view's plane, meshed like
   * `requestTessellation`, with its cut faces and edges. Rejects, with the
   * reason the view shows, when the kernel cannot cut the section or the
   * plane misses every body. Absent, section views refuse to draw.
   */
  requestSection?: (
    document: ProjectDocument,
    bodyIds: BodyId[],
    plane: { normal: Vector3; depth: number },
    signal: AbortSignal
  ) => Promise<Record<string, SectionBodyInput>>;
  /** Why drawing edits are refused, or null. */
  editDisabledReason: string | null;
  onCommand: (command: AnyCommand) => boolean;
  onStatus: (message: string) => void;
  /**
   * D06: the sheet on screen as the assistant reads it, or null when there
   * is none. Called whenever what it measures changes.
   */
  onAssistantSource?: (source: DrawingAssistantSource | null) => void;
  /**
   * An assistant proposal's annotations for one sheet, drawn in place of
   * the sheet's own while the proposal is previewed.
   */
  previewAnnotations?: {
    sheetId: DrawingSheetId;
    annotations: DrawingAnnotation[];
  } | null;
}

type SheetStatus =
  | { kind: 'ready'; fingerprint: string }
  | { kind: 'pending' }
  | { kind: 'stale'; fingerprint: string }
  | {
      kind: 'replaced';
      fingerprint: string;
      replacements: { from: BodyId; to: BodyId }[];
    }
  | { kind: 'missing'; bodyNames: string[] };

type ViewState =
  | { state: 'ready'; projection: ViewProjection }
  | { state: 'projecting' }
  | { state: 'error'; message: string };

function sheetStatus(
  document: ProjectDocument,
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
  if (missing.length > 0) {
    const replacements = drawingBodyReplacements(document, bodies, ids);
    if (replacements && replacements.length > 0) {
      const targets = new Map(replacements.map(({ from, to }) => [from, to]));
      const fingerprint = drawingSourceFingerprint(bodies, [
        ...new Set(ids.map((id) => targets.get(id) ?? id))
      ]);
      if (fingerprint) return { kind: 'replaced', fingerprint, replacements };
    }
  }
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

/** What a view draws, independent of the model state it draws it from. */
function viewIntentKey(view: DrawingView): string {
  const cut = view.section ? `|section:${view.section.depth}` : '';
  return `${view.orientation}|${view.hiddenLines}|${[...view.bodyIds].sort().join(',')}${cut}`;
}

function projectionKey(fingerprint: string, view: DrawingView): string {
  return `${fingerprint}|${viewIntentKey(view)}`;
}

const PAPER_SIZES = Object.keys(DRAWING_PAPER_SIZES_MM) as DrawingPaperSize[];

/** What sheets not on screen may keep of their projections. */
const INACTIVE_PROJECTION_BYTES = 32 * 1024 * 1024;

function viewStateBytes(entry: ViewState): number {
  if (entry.state !== 'ready') return 0;
  let bytes = 0;
  for (const buffer of projectionBuffers(entry.projection))
    bytes += buffer.byteLength;
  return bytes;
}

/**
 * The projections of the project last drawn, kept while Draw is closed. The
 * workspace mounts only in Draw, so leaving it for Build and coming back
 * would otherwise project every view again, which on a detailed part takes
 * seconds. Keys name the model state and the view's intent, so an edit made
 * in the meantime simply misses; the open sheet's pruning bounds the rest.
 * Opening another project starts empty.
 */
let retainedProjections: {
  projectId: string;
  cache: Map<string, ViewState>;
  kept: Map<DrawingSheetId, KeptDrawing[]>;
} | null = null;

/**
 * Kept drawings per sheet, newest first: the one before the latest Update
 * as well, so undoing the Update brings that drawing back.
 */
const KEPT_DRAWINGS_PER_SHEET = 2;

/**
 * A sheet's last complete drawing: its views' projections by view intent and
 * the bodies its dimensions measured, under the fingerprint it was drawn at.
 * A sheet whose model has since changed keeps drawing, dimensioning and
 * exporting from it until an Update rebinds the sheet to the current model.
 */
interface KeptDrawing {
  fingerprint: string;
  bodies: DrawingWorkspaceProps['bodies'];
  projections: Map<string, ViewProjection>;
}

function retainedFor(projectId: string) {
  if (retainedProjections?.projectId !== projectId)
    retainedProjections = { projectId, cache: new Map(), kept: new Map() };
  return retainedProjections;
}

function projectionCacheFor(projectId: string): Map<string, ViewState> {
  return retainedFor(projectId).cache;
}

function keptDrawingsFor(
  projectId: string
): Map<DrawingSheetId, KeptDrawing[]> {
  return retainedFor(projectId).kept;
}

/** Forgets the retained projections and kept drawings; for tests. */
export function resetRetainedProjections(): void {
  retainedProjections = null;
}

/** Projections for the sheet's views, cached by model and view intent. */
function useViewProjections(
  sheet: DrawingSheet | null,
  /** Every projection key some sheet draws of the current model. */
  wanted: ReadonlySet<string>,
  status: SheetStatus | null,
  document: ProjectDocument,
  requestTessellation: DrawingWorkspaceProps['requestTessellation'],
  requestSection: DrawingWorkspaceProps['requestSection']
): Map<DrawingViewId, ViewState> {
  const client = useRef<DrawingProjectionClient | null>(null);
  /** Aborted on close: abandons tessellations still queued or running. */
  const closed = useRef<AbortController | null>(null);
  const cache = useRef(projectionCacheFor(document.projectId));
  cache.current = projectionCacheFor(document.projectId);
  /**
   * The 'projecting' markers this workspace put in the cache, so closing it
   * takes back only its own: the cache outlives it, and a marker left behind
   * would keep the next workspace from ever asking for that view.
   */
  const markers = useRef(new Map<string, ViewState>());
  /**
   * The canonical tessellations of the model the sheet on screen is fenced
   * to, per body, so a pass that only toggles hidden lines does not mesh
   * again. Dropped when the fingerprint changes.
   */
  const tessellations = useRef<{
    fingerprint: string;
    bodies: Map<BodyId, ProjectionBodyInput>;
    /** D03 cut bodies, per section plane (`sectionPlaneKey`). */
    sections: Map<string, Record<string, SectionBodyInput>>;
  } | null>(null);
  // Read when a pass starts, not effect inputs: a drawing edit replaces the
  // document without changing the model a ready sheet draws.
  const latest = useRef({ document, requestTessellation, requestSection });
  latest.current = { document, requestTessellation, requestSection };
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
    const lifetime = new AbortController();
    client.current = owned;
    closed.current = lifetime;
    const ownMarkers = markers.current;
    return () => {
      mounted.current = false;
      for (const [key, marker] of ownMarkers)
        if (cache.current.get(key) === marker) cache.current.delete(key);
      ownMarkers.clear();
      lifetime.abort();
      owned.dispose();
      client.current = null;
      closed.current = null;
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
    if (
      !sheet ||
      !fingerprint ||
      !client.current ||
      !closed.current ||
      outstanding.current
    )
      return;
    // Every view this pass still needs goes in one request, with each body's
    // geometry once however many views draw it. A section view's bodies are
    // the model's cut by its plane, asked for once per plane.
    const views: DrawingProjectionViewRequest[] = [];
    const bodyIds = new Set<BodyId>();
    const cuts = new Map<
      string,
      {
        plane: { normal: Vector3; depth: number };
        bodyIds: Set<BodyId>;
        views: DrawingView[];
      }
    >();
    const sectionKeys = new Map<string, DrawingView>();
    const passMarkers = new Map<string, ViewState>();
    for (const view of sheet.views) {
      const key = projectionKey(fingerprint, view);
      if (cache.current.has(key) || passMarkers.has(key)) continue;
      const planeKey = sectionPlaneKey(view);
      if (planeKey && view.section) {
        const cut = cuts.get(planeKey) ?? {
          plane: drawingSectionPlane({ ...view, section: view.section }),
          bodyIds: new Set<BodyId>(),
          views: []
        };
        for (const id of view.bodyIds) cut.bodyIds.add(id);
        cut.views.push(view);
        cuts.set(planeKey, cut);
        sectionKeys.set(key, view);
      } else {
        for (const id of view.bodyIds) bodyIds.add(id);
        views.push({
          key,
          orientation: view.orientation,
          hiddenLines: view.hiddenLines,
          // In the key's order: the lines come out in body order, and a view
          // whose bodies were removed and re-added must export the same bytes
          // whether its projection was cached or made after a reload.
          bodyIds: [...view.bodyIds].sort()
        });
      }
      const marker: ViewState = { state: 'projecting' };
      cache.current.set(key, marker);
      passMarkers.set(key, marker);
      markers.current.set(key, marker);
    }
    if (passMarkers.size > 0) {
      outstanding.current = true;
      const owned = client.current;
      const { signal } = closed.current;
      if (tessellations.current?.fingerprint !== fingerprint)
        tessellations.current = {
          fingerprint,
          bodies: new Map(),
          sections: new Map()
        };
      const known = tessellations.current;
      const missing = [...bodyIds].filter((id) => !known.bodies.has(id));
      const {
        document: current,
        requestTessellation: tessellate,
        requestSection: section
      } = latest.current;
      /** A section refused by the kernel: final, not a transport failure. */
      const refusals = new Map<string, string>();
      const sectioned = [...cuts].map(([planeKey, cut]) => {
        if (known.sections.has(planeKey)) return Promise.resolve();
        if (!section)
          return Promise.resolve(
            refusals.set(planeKey, 'Section views cannot be drawn here.')
          ).then(() => undefined);
        return section(
          current,
          [...cut.bodyIds].sort(),
          cut.plane,
          signal
        ).then(
          (bodies) => {
            known.sections.set(planeKey, bodies);
          },
          (error: unknown) => {
            if (error instanceof Error && error.name === 'AbortError')
              throw error;
            refusals.set(
              planeKey,
              error instanceof Error
                ? error.message
                : 'The section could not be cut.'
            );
          }
        );
      });
      Promise.all([
        missing.length > 0
          ? tessellate(current, missing.sort(), signal)
          : Promise.resolve<Record<string, ProjectionBodyInput>>({}),
        ...sectioned
      ])
        .then(([meshed]) => {
          // Closed while the geometry worker meshed: a disposed client
          // would start a fresh worker nobody stops.
          if (client.current !== owned) {
            const closed = new Error('Drawing closed.');
            closed.name = 'AbortError';
            throw closed;
          }
          for (const id of missing) {
            const input = meshed[id];
            if (input) known.bodies.set(id, input);
          }
          // Every body or none: a view missing one would look complete.
          const inputs: Record<string, ProjectionBodyInput> = {};
          for (const id of bodyIds) {
            const input = known.bodies.get(id);
            if (!input) throw new Error(`Body ${id} has no geometry to draw.`);
            inputs[id] = input;
          }
          // Section views project from their cut bodies; a body wholly in
          // front of the plane is simply not in the section. A refused cut
          // is shown on its view at once: retrying cannot change it.
          for (const [key, view] of sectionKeys) {
            const planeKey = sectionPlaneKey(view)!;
            const refusal = refusals.get(planeKey);
            const cut = known.sections.get(planeKey);
            if (refusal || !cut) {
              markers.current.delete(key);
              cache.current.set(key, {
                state: 'error',
                message: refusal ?? 'The section could not be cut.'
              });
              continue;
            }
            const ids: string[] = [];
            for (const id of [...view.bodyIds].sort()) {
              const body = cut[id];
              if (!body) throw new Error(`Body ${id} has no geometry to draw.`);
              if (body.indices.length === 0) continue;
              const inputKey = sectionInputKey(view, id);
              // Refused by the kernel: the projection cuts its mesh.
              inputs[inputKey] = body.approximate
                ? {
                    ...body,
                    clip: drawingSectionPlane({
                      ...view,
                      section: view.section!
                    })
                  }
                : body;
              ids.push(inputKey);
            }
            views.push({
              key,
              orientation: view.orientation,
              hiddenLines: view.hiddenLines,
              bodyIds: ids
            });
          }
          /** A section's projection, with its cut bodies' edges for D02. */
          const withSection = (
            key: string,
            projection: ViewProjection
          ): ViewProjection => {
            const view = sectionKeys.get(key);
            const cut = view && known.sections.get(sectionPlaneKey(view)!);
            if (!view || !cut) return projection;
            const approximate = view.bodyIds
              .map((id) => cut[id]?.approximate)
              .find((reason) => reason !== undefined);
            return {
              ...projection,
              sectionEdges: Object.fromEntries(
                view.bodyIds.map((id) => [id, cut[id]?.edgeTopology ?? []])
              ),
              ...(approximate ? { sectionApproximate: approximate } : {})
            };
          };
          if (views.length === 0) return null;
          // Each view shows as soon as it is projected, not when the
          // slowest view of the sheet is done.
          return owned
            .project(inputs, views, (key, result) => {
              failures.current.delete(key);
              markers.current.delete(key);
              cache.current.set(
                key,
                result.ok
                  ? {
                      state: 'ready',
                      projection: withSection(key, result.projection)
                    }
                  : { state: 'error', message: result.error }
              );
              if (mounted.current) setRevision((value) => value + 1);
            })
            .then((results) => ({ results, withSection, views }));
        })
        .then(
          (answer) => {
            if (!answer) return;
            const { results, withSection, views: asked } = answer;
            for (const view of asked) {
              const result = results[view.key];
              // An answer clears the transport-failure count: retries are
              // counted per run of failures, not over the key's lifetime.
              failures.current.delete(view.key);
              markers.current.delete(view.key);
              cache.current.set(
                view.key,
                result?.ok
                  ? {
                      state: 'ready',
                      projection: withSection(view.key, result.projection)
                    }
                  : {
                      state: 'error',
                      message: result?.error ?? 'Projection failed.'
                    }
              );
            }
          },
          (error: unknown) => {
            // The request itself failed — the tessellation was refused, or
            // a worker closed under it or stopped — not any one view: forget
            // the views so the next pass asks again. A worker that keeps
            // failing gets two more tries before the views show the error. A
            // closed client (an unmount, React's development remount) never
            // counts.
            const aborted =
              error instanceof Error && error.name === 'AbortError';
            for (const [key, marker] of passMarkers) {
              // A view already answered keeps its answer, and one another
              // workspace has asked for since is not this pass's to forget.
              markers.current.delete(key);
              if (cache.current.get(key) !== marker) continue;
              const tries = (failures.current.get(key) ?? 0) + 1;
              if (!aborted) failures.current.set(key, tries);
              if (aborted || tries < 3) cache.current.delete(key);
              else
                cache.current.set(key, {
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
  }, [sheet, wanted, fingerprint, revision]);
  const states = new Map<DrawingViewId, ViewState>();
  if (sheet && fingerprint)
    for (const view of sheet.views) {
      const entry = cache.current.get(projectionKey(fingerprint, view));
      if (entry) states.set(view.viewId, entry);
    }
  return states;
}

/** A view's name in the editor: its orientation, or "Section A-A". */
function viewLabel(view: DrawingView): string {
  return view.section
    ? sectionCaption(view.section.label).replace('SECTION', 'Section')
    : DRAWING_VIEW_LABELS[view.orientation];
}

function statusMessage(status: SheetStatus): string | null {
  switch (status.kind) {
    case 'ready':
      return null;
    case 'pending':
      return 'Waiting for the model to finish updating. The views redraw when it does.';
    case 'stale':
      return 'The model changed since this sheet was drawn. Update it to redraw the views.';
    case 'replaced':
      return 'Finishing features replaced a body this sheet draws. Update to use the current body and check its dimensions. Changed edges may need re-picking.';
    case 'missing':
      return `This sheet draws ${status.bodyNames.join(', ')}, which no longer exists as a body. Remove it from the views that use it.`;
  }
}

/** "The Front view", "The Front and Top views", "The Front, Top and Left views". */
function listNames(names: string[]): string {
  const list =
    names.length === 1
      ? names[0]!
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
  return `The ${list} view${names.length === 1 ? '' : 's'}`;
}

const PLACEMENT_LABELS: Readonly<Record<ViewPlacementIssue, string>> = {
  'off-page': 'off the page',
  'partly-off-page': 'partly off the page',
  'past-border': 'past the border',
  'over-title-block': 'over the title block'
};

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
  /** Printed on the sheet: warn about characters the PDF font lacks. */
  printed?: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = () => {
    if (draft !== props.value) props.onCommit(draft);
  };
  const unprintable = props.printed ? sheetUnprintableCharacters(draft) : [];
  return (
    <>
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
      {unprintable.length > 0 && (
        // Not blocking: the text is kept, but the sheet font cannot draw
        // these, so preview and exports show "?" for them.
        <p className="drawing-field-warning" role="status">
          {unprintable.join(' ')} will print as &quot;?&quot;: sheet text uses
          the standard PDF Helvetica, which covers Latin-1 only.
        </p>
      )}
    </>
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
  'chamfer',
  'note'
];

const ANNOTATION_TOOL_ICONS: Readonly<Record<AnnotationToolKind, LucideIcon>> =
  {
    horizontal: MoveHorizontal,
    vertical: MoveVertical,
    aligned: MoveDiagonal2,
    radius: Radius,
    diameter: Diameter,
    angle: Angle,
    chamfer: TriangleRight,
    note: StickyNote
  };

/** One key per tool, live while Draw is open and focus is not in a field. */
const ANNOTATION_TOOL_KEYS: Readonly<Record<AnnotationToolKind, string>> = {
  horizontal: 'H',
  vertical: 'V',
  aligned: 'A',
  radius: 'R',
  diameter: 'D',
  angle: 'G',
  chamfer: 'C',
  note: 'N'
};

/** D03: the section view tool's key, beside the annotation tools'. */
const SECTION_TOOL_KEY = 'S';

const DARK_PAPER_STORAGE_KEY = 'openzcad.drawing.darkPaper';

/**
 * Dark paper is a per-device editor preference: the canvas only. The PDF
 * and SVG writers never read it, so exports stay black on white.
 */
function readDarkPaper(): boolean {
  try {
    return globalThis.localStorage?.getItem(DARK_PAPER_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDarkPaper(dark: boolean) {
  try {
    globalThis.localStorage?.setItem(DARK_PAPER_STORAGE_KEY, dark ? '1' : '0');
  } catch {
    // Private windows and blocked storage keep the choice for this visit.
  }
}

/** A keydown the drawing shortcuts may take: no field, menu or dialog. */
function drawingShortcutTarget(
  event: KeyboardEvent,
  workspace: HTMLElement | null
): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat)
    return false;
  const target = event.target as HTMLElement | null;
  if (!target || !workspace) return false;
  if (target.closest('input, select, textarea, [contenteditable="true"]'))
    return false;
  return target === globalThis.document.body || workspace.contains(target);
}

const ANNOTATION_KIND_LABELS: Readonly<
  Record<DrawingAnnotation['kind'], string>
> = {
  linear: 'Dimension',
  radius: 'Radius',
  diameter: 'Diameter',
  angle: 'Angle',
  chamfer: 'Chamfer',
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

/** The annotations on the sheet, to select one; values only while ready. */
function AnnotationList(props: {
  sheet: DrawingSheet;
  ready: boolean;
  selected: DrawingAnnotation | null;
  resolutions: ReadonlyMap<DrawingAnnotationId, AnnotationResolution>;
  onSelect: (annotationId: DrawingAnnotationId | null) => void;
}) {
  const { ready, selected } = props;
  const annotations = props.sheet.annotations ?? [];
  return (
    <div className="drawing-panel-section">
      <h3>Annotations · {annotations.length}</h3>
      {annotations.length > 0 ? (
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
      ) : (
        <p className="drawing-hint">
          Pick a dimension tool on the sheet&apos;s left. Dimensions read their
          values from the model and follow the sheet&apos;s Update.
        </p>
      )}
    </div>
  );
}

/** Annotations not yet placed, drawn on the sheet in the accent colour. */
function AnnotationPreview(props: {
  layer: { strokes: SheetStroke[]; texts: SheetText[] };
  paperHeight: number;
  label?: string;
}) {
  const height = props.paperHeight;
  return (
    <g
      className="drawing-annotation-preview"
      {...(props.label ? { 'aria-label': props.label, role: 'img' } : {})}
    >
      {props.layer.strokes.map((stroke, index) => (
        <polyline
          key={index}
          className={stroke.filled ? 'is-filled' : undefined}
          points={`${svgPoints(stroke.points, height)}${stroke.filled ? ` ${svgPoints(stroke.points.slice(0, 2), height)}` : ''}`}
        />
      ))}
      {props.layer.texts.map((text, index) => {
        const start = sheetTextStart(text);
        return (
          <text
            key={index}
            x={start.x}
            y={height - start.y}
            fontSize={text.sizeMm / 0.718}
            transform={
              text.angleDeg
                ? `rotate(${-text.angleDeg} ${start.x} ${height - start.y})`
                : undefined
            }
          >
            {text.text}
          </text>
        );
      })}
    </g>
  );
}

/** What Auto-dimension would add, shown on the sheet until Apply or Cancel. */
function AutoDimensionPreview(props: {
  plan: AutoDimensionPlan;
  audit: DrawingAudit;
  onApply: () => void;
  onCancel: () => void;
}) {
  const { plan, audit } = props;
  const count = plan.annotations.length;
  // The check already lists what no dimension can state yet; only what
  // Auto-dimension leaves for other reasons is listed here.
  const unmeasurable = new Set(audit.unmeasurable.map((f) => f.message));
  const left = plan.skipped.filter((f) => !unmeasurable.has(f.message));
  const waiting = plan.skipped.length - left.length;
  return (
    <div
      className="drawing-auto-preview"
      role="group"
      aria-label="Auto-dimension preview"
    >
      <p className="drawing-annotation-value">
        {count === 0
          ? 'Nothing it can add.'
          : `Adds ${count} ${count === 1 ? 'dimension' : 'dimensions'}, shown on the sheet.`}
      </p>
      {plan.onHiddenLines > 0 && (
        <p className="drawing-hint">
          {plan.onHiddenLines === 1
            ? '1 measures hidden lines'
            : `${plan.onHiddenLines} measure hidden lines`}
          : no view shows that feature visible.
        </p>
      )}
      {plan.sectionAdvice && (
        <p className="drawing-hint">{plan.sectionAdvice}</p>
      )}
      {waiting > 0 && (
        <p className="drawing-hint">
          Skips {waiting} it can&apos;t dimension yet, listed below.
        </p>
      )}
      {left.length > 0 && (
        <>
          <p className="drawing-audit-heading is-warning">
            Left for you · {left.length}
          </p>
          <ul
            className="drawing-audit-list"
            aria-label="Dimensions Auto-dimension leaves for you"
          >
            {left.map((finding) => (
              <li key={finding.message}>{finding.message}</li>
            ))}
          </ul>
        </>
      )}
      <div className="drawing-auto-actions">
        <button
          type="button"
          className="primary"
          disabled={count === 0}
          onClick={props.onApply}
        >
          Apply
        </button>
        <button type="button" className="secondary" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * D06: whether the sheet's dimensions state every size and position the
 * check can read, once. Read from the current model, so only a ready sheet
 * reports; a repeated or unchecked dimension selects on click.
 * Auto-dimension (slice C) previews what it would add here, and adds it as
 * one command on Apply.
 */
function DimensionCheck(props: {
  sheet: DrawingSheet;
  ready: boolean;
  audit: DrawingAudit | null;
  resolutions: ReadonlyMap<DrawingAnnotationId, AnnotationResolution>;
  onSelect: (annotationId: DrawingAnnotationId) => void;
  autoDisabledReason: string | null;
  autoPlan: AutoDimensionPlan | null;
  onAuto: () => void;
  onApplyAuto: () => void;
  onCancelAuto: () => void;
}) {
  const { sheet, audit } = props;
  if (sheet.views.length === 0) return null;
  const annotations = new Map(
    (sheet.annotations ?? []).map((annotation) => [
      annotation.annotationId,
      annotation
    ])
  );
  const entry = (annotationId: DrawingAnnotationId, message: string) => {
    const annotation = annotations.get(annotationId);
    return (
      <button
        key={annotationId}
        type="button"
        className="drawing-sheet-item drawing-audit-item"
        onClick={() => props.onSelect(annotationId)}
      >
        {annotation
          ? annotationName(
              annotation,
              props.resolutions.get(annotationId),
              props.ready
            )
          : 'Dimension'}
        <span className="drawing-audit-reason">{message}</span>
      </button>
    );
  };
  const complete =
    audit !== null &&
    audit.missing.length === 0 &&
    audit.redundant.length === 0;
  return (
    <div className="drawing-panel-section">
      <h3>Dimension check</h3>
      {!props.ready || !audit ? (
        <p className="drawing-hint">Checked once the sheet is drawn.</p>
      ) : (
        <>
          <p className="drawing-annotation-value">
            {complete
              ? `Every size and position it reads is stated once (${audit.stated}).`
              : `${audit.stated} of ${audit.required} stated`}
          </p>
          {props.autoPlan ? (
            <AutoDimensionPreview
              plan={props.autoPlan}
              audit={audit}
              onApply={props.onApplyAuto}
              onCancel={props.onCancelAuto}
            />
          ) : (
            <button
              type="button"
              className="secondary"
              disabled={
                props.autoDisabledReason !== null || audit.missing.length === 0
              }
              title={
                props.autoDisabledReason ??
                (audit.missing.length === 0
                  ? 'No dimension it can place is missing.'
                  : 'Add the missing dimensions, previewed before anything changes')
              }
              onClick={props.onAuto}
            >
              <Ruler size={13} aria-hidden="true" /> Auto-dimension
            </button>
          )}
          {audit.missing.length > 0 && (
            <>
              <p className="drawing-audit-heading">
                Missing · {audit.missing.length}
              </p>
              <ul
                className="drawing-audit-list"
                aria-label="Missing dimensions"
              >
                {audit.missing.map((finding) => (
                  <li key={finding.message}>{finding.message}</li>
                ))}
              </ul>
            </>
          )}
          {audit.redundant.length > 0 && (
            <>
              <p className="drawing-audit-heading is-warning">
                Repeated · {audit.redundant.length}
              </p>
              <div className="drawing-view-list">
                {audit.redundant.map((finding) =>
                  entry(finding.annotationId, finding.message)
                )}
              </div>
            </>
          )}
          {audit.unmeasurable.length > 0 && (
            <>
              <p className="drawing-audit-heading">
                Can&apos;t dimension yet · {audit.unmeasurable.length}
              </p>
              <ul
                className="drawing-audit-list"
                aria-label="Requirements no dimension can state yet"
              >
                {audit.unmeasurable.map((finding) => (
                  <li key={finding.message}>{finding.message}</li>
                ))}
              </ul>
            </>
          )}
          {audit.unchecked.length > 0 && (
            <>
              <p className="drawing-audit-heading">
                Not checked · {audit.unchecked.length}
              </p>
              <div className="drawing-view-list">
                {audit.unchecked.map((finding) =>
                  entry(finding.annotationId, finding.message)
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * D02: the selected annotation's properties. Values are shown only while the
 * sheet is ready: a stale sheet has not been redrawn from the model they
 * would be read from.
 */
function AnnotationProperties(props: {
  selected: DrawingAnnotation;
  ready: boolean;
  /** Re-picking needs a ready, editable sheet with views. */
  canRepick: boolean;
  editable: boolean;
  units: ProjectDocument['units'];
  resolutions: ReadonlyMap<DrawingAnnotationId, AnnotationResolution>;
  onTool: (tool: AnnotationTool | null) => void;
  onDeselect: () => void;
  onUpdate: (annotation: DrawingAnnotation, label?: string) => void;
  onDelete: (annotation: DrawingAnnotation) => void;
}) {
  const { selected, ready, editable } = props;
  const resolution = props.resolutions.get(selected.annotationId);
  return (
    <div className="drawing-panel-section is-selection">
      <SelectionHeading
        title={annotationTitle(selected)}
        onDeselect={props.onDeselect}
      />
      {!ready ? (
        <p className="drawing-hint">
          Update the sheet to read this from the model again.
        </p>
      ) : resolution && !resolution.ok ? (
        <p className="drawing-annotation-status" role="alert">
          Broken: {resolution.message} Re-pick what it measures, or delete it.
        </p>
      ) : resolution?.ok && selected.kind !== 'note' ? (
        <p className="drawing-annotation-value">
          {resolution.resolved.label}
          {selected.kind === 'angle' || selected.kind === 'chamfer'
            ? ''
            : ` ${props.units}`}
        </p>
      ) : null}
      {selected.kind === 'note' ? (
        <TextField
          label="Text"
          value={selected.text}
          maxLength={MAX_DRAWING_NOTE_LENGTH}
          printed
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
              Default ({defaultDimensionDecimals(selected.kind, props.units)})
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
      {selected.kind !== 'note' && (
        <DimensionFormat
          selected={selected}
          editable={editable}
          onUpdate={props.onUpdate}
        />
      )}
      {selected.provenance && (
        <p className="drawing-hint">
          Placed by Auto-dimension. Re-picking it makes it yours.
        </p>
      )}
      <div className="drawing-field-row">
        {(selected.kind !== 'note' || selected.leader) && (
          <button
            type="button"
            className="secondary"
            disabled={!props.canRepick}
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
  );
}

/**
 * D06 format flags: a count on radial and chamfer dimensions, Ø on a linear
 * span across a cylinder, and reference dimensions in brackets.
 */
function DimensionFormat(props: {
  selected: Exclude<DrawingAnnotation, { kind: 'note' }>;
  editable: boolean;
  onUpdate: (annotation: DrawingAnnotation, label?: string) => void;
}) {
  const { selected, editable } = props;
  const counted =
    selected.kind === 'radius' ||
    selected.kind === 'diameter' ||
    selected.kind === 'chamfer'
      ? selected
      : null;
  const flag = <K extends 'reference' | 'diameter'>(
    key: K,
    on: boolean
  ): DrawingAnnotation => {
    const { [key]: _previous, ...rest } = selected as unknown as Record<
      string,
      unknown
    >;
    return (on
      ? { ...rest, [key]: true }
      : rest) as unknown as DrawingAnnotation;
  };
  return (
    <>
      {counted && (
        <label className="drawing-field">
          <span>Count</span>
          <input
            type="number"
            min={1}
            max={MAX_DRAWING_DIMENSION_COUNT}
            step={1}
            value={counted.count ?? 1}
            disabled={!editable}
            aria-label="How many like features this states"
            onChange={(event) => {
              const value = Math.round(Number(event.target.value));
              if (
                !Number.isFinite(value) ||
                value > MAX_DRAWING_DIMENSION_COUNT
              )
                return;
              const { count: _previous, ...rest } = counted;
              props.onUpdate(
                value >= 2 ? { ...rest, count: value } : rest,
                'Format dimension'
              );
            }}
          />
        </label>
      )}
      {selected.kind === 'linear' && (
        <label className="drawing-check">
          <input
            type="checkbox"
            checked={selected.diameter === true}
            disabled={!editable}
            onChange={(event) =>
              props.onUpdate(
                flag('diameter', event.target.checked),
                'Format dimension'
              )
            }
          />
          <span>Ø diameter (across a cylinder seen side-on)</span>
        </label>
      )}
      <label className="drawing-check">
        <input
          type="checkbox"
          checked={selected.reference === true}
          disabled={!editable}
          onChange={(event) =>
            props.onUpdate(
              flag('reference', event.target.checked),
              'Format dimension'
            )
          }
        />
        <span>Reference dimension (in brackets)</span>
      </label>
    </>
  );
}

/** The selection's name, and the way back to the sheet's own settings. */
function SelectionHeading(props: { title: string; onDeselect: () => void }) {
  return (
    <div className="drawing-panel-heading">
      <h3 className="drawing-selection-title">{props.title}</h3>
      <button
        type="button"
        className="drawing-deselect"
        aria-label="Back to the sheet"
        title="Back to the sheet (Esc)"
        onClick={props.onDeselect}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * The tool rail: a select arrow and the D02 annotation tools, each with a
 * one-key shortcut the workspace listens for while Draw is open.
 */
function DrawingToolRail(props: {
  tool: AnnotationTool | null;
  canUseTool: (kind: AnnotationToolKind) => boolean;
  disabledReason: (kind: AnnotationToolKind) => string;
  onTool: (kind: AnnotationToolKind | null) => void;
  /** D03: the section view tool, beside the annotation tools. */
  section: {
    active: boolean;
    usable: boolean;
    disabledReason: string;
    onToggle: () => void;
  };
}) {
  const { tool, section } = props;
  const groups: AnnotationToolKind[][] = [
    ['horizontal', 'vertical', 'aligned'],
    ['radius', 'diameter', 'angle', 'chamfer'],
    ['note']
  ];
  return (
    <div
      className="drawing-tool-rail"
      role="toolbar"
      aria-label="Annotation tools"
      aria-orientation="vertical"
    >
      <button
        type="button"
        className={`drawing-rail-button${tool ? '' : ' active'}`}
        aria-label="Select"
        aria-pressed={!tool && !section.active}
        title="Select and move views and annotations (Esc)"
        onClick={() => props.onTool(null)}
      >
        <MousePointer2 size={16} aria-hidden="true" />
      </button>
      {groups.map((group) => (
        <div key={group[0]} className="drawing-rail-group">
          {group.map((kind) => {
            const Icon = ANNOTATION_TOOL_ICONS[kind];
            const active = tool?.kind === kind && !tool.repairId;
            const usable = props.canUseTool(kind);
            const name =
              kind === 'note'
                ? 'Note'
                : `${ANNOTATION_TOOL_LABELS[kind]} dimension`;
            return (
              <button
                key={kind}
                type="button"
                className={`drawing-rail-button${active ? ' active' : ''}`}
                aria-label={ANNOTATION_TOOL_LABELS[kind]}
                aria-pressed={active}
                aria-keyshortcuts={ANNOTATION_TOOL_KEYS[kind]}
                disabled={!usable}
                title={
                  usable
                    ? `${name} (${ANNOTATION_TOOL_KEYS[kind]})`
                    : props.disabledReason(kind)
                }
                onClick={() => props.onTool(active ? null : kind)}
              >
                <Icon size={16} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      ))}
      <div className="drawing-rail-group">
        <button
          type="button"
          className={`drawing-rail-button${section.active ? ' active' : ''}`}
          aria-label="Section view"
          aria-pressed={section.active}
          aria-keyshortcuts={SECTION_TOOL_KEY}
          disabled={!section.usable}
          title={
            section.usable
              ? `Section view: draw a line across a view (${SECTION_TOOL_KEY})`
              : section.disabledReason
          }
          onClick={section.onToggle}
        >
          <Scissors size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
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
  /**
   * D03 section tool: a drag across a view draws its cutting-plane line
   * (`drag`), then the section view follows the pointer (`line`, `pointer`)
   * until a click places it.
   */
  const [sectionTool, setSectionTool] = useState<{
    drag: { start: [number, number]; current: [number, number] } | null;
    line: SectionLine | null;
    pointer: [number, number] | null;
  } | null>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] =
    useState<DrawingAnnotationId | null>(null);
  /** D06: Auto-dimension's proposal, previewed on the sheet it was made from. */
  const [autoPlan, setAutoPlan] = useState<{
    sheet: DrawingSheet;
    plan: AutoDimensionPlan;
  } | null>(null);
  /** Under the pointer while a tool is active: the edge and paper point. */
  const [hover, setHover] = useState<{
    edge: PickableEdge | null;
    /** A face outline, for the tools that pick faces. */
    face: PickableFace | null;
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
  // The canvas element as state too, so the wheel listener (which must be
  // non-passive to keep the page from scrolling) follows it in and out.
  const [canvasElement, setCanvasElement] = useState<SVGSVGElement | null>(
    null
  );
  const attachCanvas = useCallback((element: SVGSVGElement | null) => {
    canvasRef.current = element;
    setCanvasElement(element);
  }, []);
  // Sheet zoom, kept per sheet and paper: another sheet, or a new paper
  // size or orientation, starts fitted again.
  const zoomKey = sheet
    ? `${sheet.sheetId}|${sheet.paper.size}|${sheet.paper.orientation}`
    : '';
  const [zoomEntry, setZoomEntry] = useState<{
    key: string;
    zoom: SheetZoom;
  } | null>(null);
  const zoomPaper = sheet ? drawingPaperMm(sheet.paper) : null;
  const sheetZoom: SheetZoom | null = zoomPaper
    ? zoomEntry?.key === zoomKey
      ? zoomEntry.zoom
      : fitSheetZoom(zoomPaper)
    : null;
  // Handlers read the latest zoom between renders: several wheel events or
  // pinch moves can arrive before React renders the first.
  const zoomRef = useRef<SheetZoom | null>(sheetZoom);
  zoomRef.current = sheetZoom;
  const setSheetZoom = (next: SheetZoom) => {
    zoomRef.current = next;
    setZoomEntry({ key: zoomKey, zoom: next });
  };
  const canvasRect = () => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0 ? rect : undefined;
  };
  /** Pan in progress: an empty-paper drag, or the middle button anywhere. */
  const panRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
  } | null>(null);
  /** Touch points on the canvas, for a two-finger pinch. */
  const touchesRef = useRef(new Map<number, { x: number; y: number }>());
  const wheelRef = useRef<(event: WheelEvent) => void>(() => undefined);
  wheelRef.current = (event: WheelEvent) => {
    const current = zoomRef.current;
    if (!current || !zoomPaper) return;
    const delta = wheelPixels(event);
    if (event.ctrlKey || event.metaKey) {
      // Ctrl/Cmd+wheel, and a trackpad pinch (which browsers send as a
      // wheel with ctrlKey), zoom about the pointer.
      event.preventDefault();
      setSheetZoom(
        zoomSheetAt(
          current,
          zoomPaper,
          current.zoom * Math.exp(-delta.y * 0.002),
          canvasRect(),
          { x: event.clientX, y: event.clientY }
        )
      );
      return;
    }
    // A plain wheel scrolls a zoomed sheet; a fitted one has nowhere to go.
    if (current.zoom <= 1) return;
    const rect = canvasRect();
    if (!rect) return;
    event.preventDefault();
    const x = event.shiftKey && delta.x === 0 ? delta.y : delta.x;
    const y = event.shiftKey && delta.x === 0 ? 0 : delta.y;
    setSheetZoom(panSheet(current, zoomPaper, rect, -x, -y));
  };
  // The canvas's size on screen, so editor overlays (view names) keep a
  // readable size whatever the paper and zoom.
  const [canvasPx, setCanvasPx] = useState<{
    width: number;
    height: number;
  } | null>(null);
  useEffect(() => {
    if (!canvasElement) return;
    const measure = () => {
      const rect = canvasElement.getBoundingClientRect();
      setCanvasPx(
        rect.width > 0 && rect.height > 0
          ? { width: rect.width, height: rect.height }
          : null
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(canvasElement);
    return () => observer.disconnect();
  }, [canvasElement]);
  const [darkPaper, setDarkPaper] = useState(readDarkPaper);
  useEffect(() => {
    if (!canvasElement) return;
    const listener = (event: WheelEvent) => wheelRef.current(event);
    canvasElement.addEventListener('wheel', listener, { passive: false });
    return () => canvasElement.removeEventListener('wheel', listener);
  }, [canvasElement]);
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
            document,
            sheet,
            bodies,
            props.geometryPending,
            fingerprints.get(sheet.sheetId) ?? null
          )
        : null,
    [document, sheet, bodies, props.geometryPending, fingerprints]
  );
  const liveProjections = useViewProjections(
    sheet,
    wanted,
    status,
    document,
    props.requestTessellation,
    props.requestSection
  );
  const keptDrawings = keptDrawingsFor(document.projectId);
  // A sheet whose model changed keeps the drawing it last made of the model
  // it is fenced to, so it stays usable until someone chooses to Update it.
  // Not while the model rebuilds: that may yet turn out to match the sheet.
  const keptDrawing =
    sheet &&
    (status?.kind === 'stale' ||
      status?.kind === 'replaced' ||
      status?.kind === 'missing')
      ? (keptDrawings
          .get(sheet.sheetId)
          ?.find((entry) => entry.fingerprint === sheet.source.fingerprint) ??
        null)
      : null;
  const projections = useMemo(() => {
    if (!keptDrawing || !sheet) return liveProjections;
    const states = new Map<DrawingViewId, ViewState>();
    for (const view of sheet.views) {
      const projection = keptDrawing.projections.get(viewIntentKey(view));
      if (projection) states.set(view.viewId, { state: 'ready', projection });
    }
    return states;
  }, [keptDrawing, sheet, liveProjections]);
  /** The bodies the drawing on screen measures: the kept model's, if kept. */
  const modelBodies = keptDrawing?.bodies ?? bodies;
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
    const preview = props.previewAnnotations;
    if (preview && preview.sheetId === sheet.sheetId)
      shown = { ...shown, annotations: preview.annotations };
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
  }, [sheet, liveDrag, liveAnnotationDrag, document, props.previewAnnotations]);
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
  /**
   * The bodies the drawing's dimensions measure: the model's, and beside
   * them each drawn section view's cut bodies (D03), whose edges a
   * dimension on that section resolves against.
   */
  const drawBodies = useMemo(() => {
    const sections = drawnViews.filter(
      ({ view, projection }) => view.section && projection.sectionEdges
    );
    if (sections.length === 0) return modelBodies;
    const merged: Record<string, BodyRepresentation | undefined> = {
      ...modelBodies
    };
    for (const { view, projection } of sections)
      for (const [bodyId, edges] of Object.entries(projection.sectionEdges!)) {
        const body = modelBodies[bodyId];
        if (!body) continue;
        merged[sectionBodyKey(view.viewId, bodyId)] = {
          ...body,
          topology: { faces: [], edges: [...edges] }
        };
      }
    return merged;
  }, [drawnViews, modelBodies]);
  // Each complete drawing of a ready sheet is kept, by view intent, with the
  // bodies it measured: it outlives this workspace, so a model edit made in
  // Build leaves the sheet as it was drawn until someone Updates it. Views
  // drawn earlier of the same model stay kept, so toggling one back costs
  // nothing.
  useEffect(() => {
    if (!shownSheet || status?.kind !== 'ready') return;
    if (drawnViews.length !== shownSheet.views.length) return;
    const previous = keptDrawings.get(shownSheet.sheetId) ?? [];
    const projections = new Map(
      previous.find((entry) => entry.fingerprint === status.fingerprint)
        ?.projections
    );
    for (const { view, projection } of drawnViews)
      projections.set(viewIntentKey(view), projection);
    keptDrawings.set(
      shownSheet.sheetId,
      [
        { fingerprint: status.fingerprint, bodies, projections },
        ...previous.filter((entry) => entry.fingerprint !== status.fingerprint)
      ].slice(0, KEPT_DRAWINGS_PER_SHEET)
    );
  }, [shownSheet, status, drawnViews, bodies, keptDrawings]);
  // While the model rebuilds the sheet shows its last drawing faded instead
  // of empty outlines; it is only ever seen, never picked from, annotated or
  // exported, since the rebuild may not leave the model it was drawn from.
  const ghostViews: ComposedView[] = useMemo(() => {
    if (!shownSheet || status?.kind !== 'pending') return [];
    const last = keptDrawings.get(shownSheet.sheetId)?.[0]?.projections;
    if (!last) return [];
    return shownSheet.views.flatMap((view) => {
      const projection = last.get(viewIntentKey(view));
      return projection ? [{ view, projection }] : [];
    });
  }, [shownSheet, status, keptDrawings]);
  // Every annotation against the model the sheet draws: the current one, or
  // the kept one of a sheet not yet updated. Only a drawn sheet draws or
  // reports them. A leader whose edge its view no longer draws at all is
  // broken too.
  const resolutions = useMemo(
    () =>
      shownSheet
        ? markHiddenLeaders(
            shownSheet,
            resolveSheetAnnotations(shownSheet, drawBodies, document.units),
            drawnViews,
            document.units,
            drawBodies
          )
        : new Map<DrawingAnnotationId, AnnotationResolution>(),
    [shownSheet, drawBodies, document.units, drawnViews]
  );
  /** Drawn and usable: matches the model, or keeps its earlier drawing. */
  const sheetReady = status?.kind === 'ready' || keptDrawing !== null;
  // The assistant reads the sheet's own annotations, never a preview's, and
  // only once every view is drawn: a partial sheet lists partial edges.
  const { onAssistantSource } = props;
  const assistantReady =
    sheetReady &&
    sheet !== null &&
    drawnViews.length === sheet.views.length &&
    !props.geometryPending;
  useEffect(() => {
    if (!onAssistantSource) return;
    if (!sheet) {
      onAssistantSource(null);
      return;
    }
    let digest: ReturnType<typeof drawingAssistantDigest> | null = null;
    onAssistantSource({
      sheetId: sheet.sheetId,
      ready: assistantReady,
      bodies: drawBodies,
      units: document.units,
      digest: () =>
        (digest ??= drawingAssistantDigest({
          sheet,
          views: drawnViews,
          bodies: drawBodies,
          units: document.units,
          ready: assistantReady
        }))
    });
  }, [
    onAssistantSource,
    sheet,
    drawnViews,
    drawBodies,
    document.units,
    assistantReady
  ]);
  useEffect(() => () => onAssistantSource?.(null), [onAssistantSource]);
  /** Drawn from an earlier model than the document's: Update redraws it. */
  const outdated =
    status?.kind === 'stale' ||
    status?.kind === 'replaced' ||
    status?.kind === 'missing';
  // D06: checked against the model the sheet draws, as its dimensions are.
  const dimensionAudit = useMemo(
    () =>
      shownSheet && sheetReady
        ? auditDrawingDimensions(shownSheet, drawBodies, document.units)
        : null,
    [shownSheet, sheetReady, drawBodies, document.units]
  );
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
  // Dimensions measure a view's geometry; a note on the paper needs none,
  // so a ready sheet with no views still takes one.
  const canAnnotate = sheetReady && editable && (sheet?.views.length ?? 0) > 0;
  const canUseTool = (kind: AnnotationToolKind) =>
    kind === 'note' ? sheetReady && editable : canAnnotate;
  const toolDisabledReason = (kind: AnnotationToolKind) =>
    !editable
      ? (editDisabledReason ?? 'Drawing edits are unavailable.')
      : !sheetReady
        ? 'Update the sheet to annotate it.'
        : kind === 'note'
          ? 'Notes are unavailable.'
          : 'Add a view to dimension it.';
  const chooseTool = (next: AnnotationTool | null) => {
    setTool(next && pinnedTool(next));
    setSectionTool(null);
    setHover(null);
    if (next) canvasRef.current?.focus();
  };
  // Tool keys, and Escape back to the sheet. Window capture, ahead of the
  // workspace's own shortcuts: in Draw a tool key would otherwise only be
  // refused as a modeling tool.
  const workspaceRef = useRef<HTMLElement | null>(null);
  const shortcutRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  shortcutRef.current = (event: KeyboardEvent) => {
    if (!sheet || !drawingShortcutTarget(event, workspaceRef.current)) return;
    if (event.key === 'Escape') {
      if (sectionTool) setSectionTool(null);
      else if (shownAutoPlan) setAutoPlan(null);
      else if (tool) {
        setTool(null);
        setHover(null);
      } else if (selectedViewId || selectedAnnotationId) {
        setSelectedViewId(null);
        setSelectedAnnotationId(null);
      } else return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.shiftKey) return;
    if (event.key.toLowerCase() === SECTION_TOOL_KEY.toLowerCase()) {
      event.preventDefault();
      event.stopPropagation();
      toggleSectionTool();
      return;
    }
    const kind = ANNOTATION_TOOLS.find(
      (entry) =>
        ANNOTATION_TOOL_KEYS[entry].toLowerCase() === event.key.toLowerCase()
    );
    if (!kind) return;
    event.preventDefault();
    event.stopPropagation();
    if (!canUseTool(kind)) {
      props.onStatus(toolDisabledReason(kind));
      return;
    }
    chooseTool(
      tool?.kind === kind && !tool.repairId ? null : startAnnotationTool(kind)
    );
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => shortcutRef.current(event);
    window.addEventListener('keydown', listener, { capture: true });
    return () =>
      window.removeEventListener('keydown', listener, { capture: true });
  }, []);

  // A proposal holds only for the sheet it was made from: any edit to that
  // sheet (an undo, a collaborator, a model Update) drops it unapplied.
  const shownAutoPlan =
    autoPlan && sheetReady && autoPlan.sheet === sheet ? autoPlan.plan : null;
  const autoDisabledReason = !editable
    ? (editDisabledReason ?? 'Drawing edits are unavailable.')
    : !sheetReady
      ? 'Update the sheet to dimension it.'
      : drawnViews.length < (sheet?.views.length ?? 0)
        ? 'Wait for every view to be drawn.'
        : null;
  const startAutoDimension = () => {
    if (!sheet || !shownSheet || autoDisabledReason) return;
    setTool(null);
    setHover(null);
    const plan = planAutoDimensions(
      shownSheet,
      drawnViews,
      drawBodies,
      document.units
    );
    setAutoPlan({ sheet, plan });
    if (plan.annotations.length === 0)
      props.onStatus('Auto-dimension found nothing it can add.');
  };
  const applyAutoDimension = () => {
    if (!sheet || !shownAutoPlan || shownAutoPlan.annotations.length === 0)
      return;
    const { annotations } = shownAutoPlan;
    // One command, so one undo takes every added dimension away again.
    if (
      run(
        composeCommands(
          'Auto-dimension',
          annotations.map((annotation) =>
            commandFactories.addDrawingAnnotation({
              sheetId: sheet.sheetId,
              annotation
            })
          )
        )
      )
    ) {
      setAutoPlan(null);
      props.onStatus(
        `Added ${annotations.length} ${annotations.length === 1 ? 'dimension' : 'dimensions'}.`
      );
    }
  };

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
    if (!sheet || !sheetReady) return;
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
    const offPaper = offPaperReason();
    if (offPaper) {
      props.onStatus(offPaper);
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
    // Through the zoom: a millimetre of drag on a zoomed sheet is more pixels.
    const pxPerMm = sheetPxPerMm(
      zoomRef.current ?? fitSheetZoom(paper),
      paper,
      rect
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
      const baseId =
        selectedView.parentViewId ?? selectedView.section?.sourceViewId;
      const base = baseId
        ? sheet.views.find((view) => view.viewId === baseId)
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

  const composed = useMemo(() => {
    if (!shownSheet) return null;
    if (drawnViews.length === 0 && ghostViews.length > 0)
      return {
        page: composeSheetPage(shownSheet, ghostViews, {
          projectName: document.name,
          units: document.units
        }),
        boxes: new Map<DrawingAnnotationId, AnnotationBox>(),
        ghost: true
      };
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
      boxes: annotations.boxes,
      ghost: false
    };
  }, [
    shownSheet,
    drawnViews,
    ghostViews,
    resolutions,
    document.name,
    document.units
  ]);
  const page: SheetPage | null = composed?.page ?? null;
  // Each view's projected extent: the drawn one once it is ready, the
  // model's estimate before. The canvas outlines, the placement flags and
  // "Fit views to sheet" all read the same one.
  const viewExtents = useMemo(() => {
    const extents = new Map<DrawingViewId, ViewExtent>();
    for (const view of shownSheet?.views ?? []) {
      const state = projections.get(view.viewId);
      const extent =
        state?.state === 'ready' && state.projection.bounds
          ? state.projection.bounds
          : estimateViewExtent(bodies, view.bodyIds, view.orientation);
      if (extent) extents.set(view.viewId, extent);
    }
    return extents;
  }, [shownSheet, projections, bodies]);
  const placements = useMemo(() => {
    const issues = new Map<DrawingViewId, ViewPlacementIssue>();
    if (!shownSheet) return issues;
    for (const view of shownSheet.views) {
      const extent = viewExtents.get(view.viewId);
      const issue = extent
        ? viewPlacementIssue(
            viewPageBox(view, extent, shownSheet, document.units),
            shownSheet
          )
        : // Nothing to measure: only a centre off the paper says anything.
          viewPlacementIssue(
              { x: view.centerMm.x, y: view.centerMm.y, width: 0, height: 0 },
              shownSheet
            ) === 'off-page'
          ? 'off-page'
          : null;
      if (issue) issues.set(view.viewId, issue);
    }
    return issues;
  }, [shownSheet, viewExtents, document.units]);

  /**
   * Why the sheet cannot export as laid out: a view runs off the paper, so
   * part of the drawing would silently not print.
   */
  function offPaperReason(): string | null {
    if (!sheet) return null;
    const names = sheet.views
      .filter((view) => {
        const issue = placements.get(view.viewId);
        return issue === 'off-page' || issue === 'partly-off-page';
      })
      .map((view) => viewLabel(view));
    if (names.length === 0) return null;
    return `${listNames(names)} ${names.length === 1 ? 'runs' : 'run'} off the paper. Fit views to sheet, or move ${names.length === 1 ? 'it' : 'them'} onto the page, to export.`;
  }

  const fitViews = (autoScale = false) => {
    if (!sheet) return;
    const label = autoScale ? 'Auto scale' : 'Fit views to sheet';
    const fitted = (autoScale ? autoScaleSheet : fitViewsToSheet)(
      sheet,
      viewExtents,
      document.units
    );
    if (!fitted) {
      props.onStatus(
        sheet.views.length === 0
          ? `Add a view to ${autoScale ? 'scale it' : 'fit it'} to the sheet.`
          : 'These views do not fit this paper at any scale. Pick a larger paper.'
      );
      return;
    }
    const scaled =
      formatDrawingScale(fitted.scale) !== formatDrawingScale(sheet.scale);
    // Bases first: moving one carries its projected views, which are then
    // set to their own fitted centres.
    const depth = (view: DrawingView): number => {
      // A section follows its source as a projected view its base.
      const baseOf = (entry: DrawingView | undefined) =>
        entry?.parentViewId ?? entry?.section?.sourceViewId;
      let count = 0;
      let parent = baseOf(view);
      while (parent && count < sheet.views.length) {
        count += 1;
        parent = baseOf(sheet.views.find((entry) => entry.viewId === parent));
      }
      return count;
    };
    const byId = new Map(sheet.views.map((view) => [view.viewId, view]));
    const moves = [...fitted.centers]
      .sort((a, b) => depth(byId.get(a.viewId)!) - depth(byId.get(b.viewId)!))
      .map(({ viewId, centerMm }) =>
        commandFactories.updateDrawingView({
          sheetId: sheet.sheetId,
          viewId,
          centerMm
        })
      );
    const commands = [
      ...(scaled
        ? [
            commandFactories.updateDrawingSheet({
              sheetId: sheet.sheetId,
              scale: fitted.scale
            })
          ]
        : []),
      ...moves
    ];
    if (run(composeCommands(label, commands)))
      props.onStatus(
        autoScale
          ? scaled
            ? `Scaled the views to ${formatDrawingScale(fitted.scale)}, the largest scale that fits the sheet.`
            : `${formatDrawingScale(fitted.scale)} is already the largest scale that fits the sheet.`
          : scaled
            ? `Fitted the views to the sheet at ${formatDrawingScale(fitted.scale)}.`
            : 'Fitted the views to the sheet.'
      );
  };
  // Edges a tool can pick, kept while the drawn views and model are the same
  // objects: a pointer move re-renders, it must not re-project every edge.
  const pickCache = useRef<{
    views: ComposedView[];
    bodies: DrawingWorkspaceProps['bodies'];
    edges: PickableEdge[];
    drawn: ReturnType<typeof drawnLines>;
    faces: PickableFace[];
    outlines: ReturnType<typeof drawnOutlines>;
  } | null>(null);
  const currentPickable = (): {
    edges: PickableEdge[];
    drawn: ReturnType<typeof drawnLines>;
    faces: PickableFace[];
    outlines: ReturnType<typeof drawnOutlines>;
  } => {
    if (!shownSheet || !sheetReady)
      return { edges: [], drawn: new Map(), faces: [], outlines: new Map() };
    const cached = pickCache.current;
    if (
      cached &&
      cached.bodies === drawBodies &&
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
      bodies: drawBodies,
      edges: pickableEdges(shownSheet, drawnViews, drawBodies, document.units),
      drawn: drawnLines(shownSheet, drawnViews, document.units),
      faces: pickableFaces(shownSheet, drawnViews, drawBodies, document.units),
      outlines: drawnOutlines(shownSheet, drawnViews, document.units)
    };
    pickCache.current = entry;
    return entry;
  };
  const edgeAt = (point: [number, number], pxPerMm: number) => {
    const { edges, drawn } = currentPickable();
    return hitEdge(edges, point, pickTolerance(pxPerMm), drawn);
  };
  const faceAt = (point: [number, number], pxPerMm: number) => {
    const { faces, outlines } = currentPickable();
    return hitFace(faces, point, pickTolerance(pxPerMm), outlines);
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
    const refusal = draftRefusal(annotation, view, drawBodies, document.units);
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
    const refusal = draftRefusal(repaired, view, drawBodies, document.units);
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
    const picking = !pickedEnough(tool);
    setHover({
      edge: picking ? edgeAt(at.point, at.pxPerMm) : null,
      face: picking ? faceAt(at.point, at.pxPerMm) : null,
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
      drawBodies,
      faceAt(at.point, at.pxPerMm)
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
    setHover({ edge: null, face: null, point: at.point });
  };

  // D03 section tool.
  const canSection =
    sheetReady &&
    editable &&
    drawnViews.some(({ view }) => !view.section && view.orientation !== 'iso');
  const sectionDisabledReason = !editable
    ? (editDisabledReason ?? 'Drawing edits are unavailable.')
    : !sheetReady
      ? 'Update the sheet to add a section.'
      : 'Add a front, top or side view to cut a section from.';
  function toggleSectionTool() {
    if (sectionTool) {
      setSectionTool(null);
      return;
    }
    if (!canSection) {
      props.onStatus(sectionDisabledReason);
      return;
    }
    setTool(null);
    setHover(null);
    setSectionTool({ drag: null, line: null, pointer: null });
    canvasRef.current?.focus();
  }
  const sectionSource = (line: SectionLine | null) =>
    line
      ? drawnViews.find(({ view }) => view.viewId === line.sourceViewId)
      : undefined;
  /**
   * How far from its source a section's centre must sit to clear it: half
   * of each view's extent across the line, and a gap.
   */
  const sectionReach = (source: DrawingView, line: SectionLine): number => {
    if (!shownSheet) return 0;
    const k = drawingPaperPerModelUnit(shownSheet.scale, document.units);
    const across = (extent: ViewExtent | null | undefined) =>
      extent
        ? line.axis === 'horizontal'
          ? extent.maxV - extent.minV
          : extent.maxU - extent.minU
        : 0;
    const orientation = drawingSectionOrientations(
      source.orientation,
      line.axis
    )[0];
    const own = orientation
      ? estimateViewExtent(bodies, source.bodyIds, orientation)
      : null;
    return (
      ((across(viewExtents.get(source.viewId)) + across(own)) * k) / 2 + 15
    );
  };
  /** The section view the tool would place now, as a preview. */
  const sectionDraft =
    sectionTool?.line && sectionTool.pointer && shownSheet
      ? (() => {
          const source = sectionSource(sectionTool.line);
          return source
            ? sectionPlacement(
                shownSheet,
                source.view,
                sectionTool.line,
                sectionTool.pointer,
                source.view.bodyIds,
                sectionReach(source.view, sectionTool.line)
              )
            : null;
        })()
      : null;
  const onSectionPointerDown = (event: ReactPointerEvent<SVGRectElement>) => {
    if (event.button !== 0 || !sectionTool || !shownSheet) return;
    const at = paperPoint(event);
    if (!at) return;
    if (sectionTool.line) {
      const source = sectionSource(sectionTool.line);
      const draft =
        source &&
        sectionPlacement(
          shownSheet,
          source.view,
          sectionTool.line,
          at.point,
          source.view.bodyIds,
          sectionReach(source.view, sectionTool.line)
        );
      if (!draft) return;
      const view: DrawingView = { ...draft, viewId: createDrawingViewId() };
      setSectionTool(null);
      if (
        run(
          commandFactories.addDrawingView({ sheetId: shownSheet.sheetId, view })
        )
      )
        setSelectedViewId(view.viewId);
      return;
    }
    if (!sectionSourceAt(shownSheet, drawnViews, at.point, document.units)) {
      props.onStatus(
        'Start the section line inside a front, top or side view.'
      );
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setSectionTool({
      drag: { start: at.point, current: at.point },
      line: null,
      pointer: null
    });
  };
  const onSectionPointerMove = (event: ReactPointerEvent<SVGRectElement>) => {
    if (!sectionTool) return;
    const at = paperPoint(event);
    if (!at) return;
    if (sectionTool.drag)
      setSectionTool({
        ...sectionTool,
        drag: { ...sectionTool.drag, current: at.point }
      });
    else if (sectionTool.line)
      setSectionTool({ ...sectionTool, pointer: at.point });
  };
  const onSectionPointerUp = (event: ReactPointerEvent<SVGRectElement>) => {
    if (!sectionTool?.drag || !shownSheet) return;
    const at = paperPoint(event);
    const end = at?.point ?? sectionTool.drag.current;
    const source = sectionSourceAt(
      shownSheet,
      drawnViews,
      sectionTool.drag.start,
      document.units
    );
    const axis =
      Math.abs(end[0] - sectionTool.drag.start[0]) >=
      Math.abs(end[1] - sectionTool.drag.start[1])
        ? 'horizontal'
        : 'vertical';
    const line =
      source &&
      sectionLineFromDrag(
        shownSheet,
        source,
        sectionTool.drag.start,
        end,
        document.units,
        sectionSnapTargets(source, drawBodies, axis)
      );
    if (!line) {
      setSectionTool({ drag: null, line: null, pointer: null });
      props.onStatus('Drag across the view to draw the section line.');
      return;
    }
    if (
      drawingSectionOrientations(source.view.orientation, line.axis).length ===
      0
    ) {
      setSectionTool({ drag: null, line: null, pointer: null });
      props.onStatus(
        `A ${line.axis} section line on the ${DRAWING_VIEW_LABELS[source.view.orientation].toLowerCase()} view has no aligned view to show it in. Draw it the other way.`
      );
      return;
    }
    setSectionTool({ drag: null, line, pointer: end });
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
      <section
        ref={workspaceRef}
        className="drawing-workspace"
        aria-label="Drawings"
      >
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
            disabled={!editable || props.geometryPending}
            title={
              editDisabledReason ??
              (props.geometryPending
                ? 'Waiting for the model to finish updating.'
                : undefined)
            }
          >
            <Plus size={14} aria-hidden="true" /> New drawing sheet
          </button>
        </div>
      </section>
    );
  }

  const paper = drawingPaperMm(sheet.paper);
  const message = statusMessage(status);
  const offPaper = offPaperReason();
  // A view that cannot be drawn (a section the kernel cannot cut, a model
  // that cannot be meshed) says so by name: it will not finish drawing.
  const refusedView = sheet.views.find(
    (view) => projections.get(view.viewId)?.state === 'error'
  );
  const refusedState = refusedView && projections.get(refusedView.viewId);
  const refusalReason =
    refusedView && refusedState?.state === 'error'
      ? `${viewLabel(refusedView)} cannot be drawn: ${refusedState.message}`
      : null;
  const exportReason = !sheetReady
    ? message
    : refusalReason
      ? refusalReason
      : sheet.views.some(
            (view) => projections.get(view.viewId)?.state !== 'ready'
          )
        ? outdated
          ? 'Update the sheet to draw every view, then export.'
          : 'Drawing the views…'
        : brokenCount > 0
          ? `${brokenCount === 1 ? 'An annotation has' : `${brokenCount} annotations have`} lost what ${brokenCount === 1 ? 'it measures' : 'they measure'}. Re-pick or delete ${brokenCount === 1 ? 'it' : 'them'} to export.`
          : offPaper;
  // Not blocking: on the paper, but over the border or the title block.
  const layoutWarning = (() => {
    const names = sheet.views
      .filter((view) => {
        const issue = placements.get(view.viewId);
        return issue === 'past-border' || issue === 'over-title-block';
      })
      .map((view) => viewLabel(view));
    return names.length === 0
      ? null
      : `${listNames(names)} ${names.length === 1 ? 'crosses' : 'cross'} the sheet border or the title block.`;
  })();
  const zoom = sheetZoom ?? fitSheetZoom(paper);
  const zoomBy = (factor: number) =>
    setSheetZoom(zoomSheetAt(zoom, paper, zoom.zoom * factor));
  const startPan = (event: ReactPointerEvent<SVGSVGElement>) => {
    panRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  // Capture phase, ahead of the views and annotations: a second finger turns
  // a touch into a pinch (and ends any drag the first one began), and the
  // middle button pans from anywhere on the sheet.
  const onCanvasPointerDownCapture = (
    event: ReactPointerEvent<SVGSVGElement>
  ) => {
    if (event.pointerType === 'touch') {
      const touches = touchesRef.current;
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size >= 2) {
        panRef.current = null;
        setDrag(null);
        setAnnotationDrag(null);
        event.stopPropagation();
        return;
      }
    }
    if (event.button === 1) {
      event.preventDefault();
      event.stopPropagation();
      startPan(event);
    }
  };
  const onCanvasPointerMoveCapture = (
    event: ReactPointerEvent<SVGSVGElement>
  ) => {
    const touches = touchesRef.current;
    if (event.pointerType === 'touch' && touches.has(event.pointerId)) {
      if (touches.size === 2) {
        const measure = () => {
          const [a, b] = [...touches.values()] as [
            { x: number; y: number },
            { x: number; y: number }
          ];
          return {
            mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
            distance: Math.hypot(a.x - b.x, a.y - b.y)
          };
        };
        const before = measure();
        touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const after = measure();
        const rect = canvasRect();
        const current = zoomRef.current;
        if (rect && current && before.distance > 0)
          setSheetZoom(
            panSheet(
              zoomSheetAt(
                current,
                paper,
                (current.zoom * after.distance) / before.distance,
                rect,
                before.mid
              ),
              paper,
              rect,
              after.mid.x - before.mid.x,
              after.mid.y - before.mid.y
            )
          );
        event.stopPropagation();
        return;
      }
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    const pan = panRef.current;
    if (pan?.pointerId !== event.pointerId) return;
    const rect = canvasRect();
    const current = zoomRef.current;
    if (rect && current)
      setSheetZoom(
        panSheet(
          current,
          paper,
          rect,
          event.clientX - pan.x,
          event.clientY - pan.y
        )
      );
    panRef.current = { ...pan, x: event.clientX, y: event.clientY };
    event.stopPropagation();
  };
  const onCanvasPointerEnd = (event: ReactPointerEvent<SVGSVGElement>) => {
    touchesRef.current.delete(event.pointerId);
    if (panRef.current?.pointerId === event.pointerId) panRef.current = null;
  };
  const scaleOptions = DRAWING_SCALE_PRESETS.some(
    (scale) => formatDrawingScale(scale) === formatDrawingScale(sheet.scale)
  )
    ? DRAWING_SCALE_PRESETS
    : [...DRAWING_SCALE_PRESETS, sheet.scale];
  const block = titleBlockBox(sheet);
  // Auto-dimension's proposal, laid out by the same rule the page uses.
  const autoLayer = shownAutoPlan
    ? composeSheetAnnotations(
        { ...shownSheet, annotations: shownAutoPlan.annotations },
        drawnViews,
        resolveSheetAnnotations(
          { ...shownSheet, annotations: shownAutoPlan.annotations },
          drawBodies,
          document.units
        ),
        document.units
      )
    : null;
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
    return previewAnnotationLayer(
      shownSheet,
      draft,
      drawnViews,
      drawBodies,
      document.units
    );
  })();

  const selectSheet = (sheetId: DrawingSheetId) => {
    setSelectedSheetId(sheetId);
    setSelectedViewId(null);
    setSelectedAnnotationId(null);
    setTool(null);
  };
  const deselect = () => {
    setSelectedViewId(null);
    setSelectedAnnotationId(null);
  };
  const toggleDarkPaper = () => {
    const next = !darkPaper;
    setDarkPaper(next);
    writeDarkPaper(next);
  };
  // Editor-only view names keep about 11 px on screen at any paper or zoom.
  const pxPerMm = canvasPx ? sheetPxPerMm(zoom, paper, canvasPx) : 0;
  const labelSizeMm = pxPerMm > 0 ? 11 / pxPerMm : 3.2;
  const ghost = composed?.ghost === true;
  const progress =
    status.kind === 'pending' && props.rebuildProgress
      ? props.rebuildProgress
      : null;
  // Not blocking export by itself, so never a live status: the sheet's
  // status chip and the export refusal stay the only ones.
  const syncLabel =
    status.kind !== 'ready'
      ? null
      : exportReason === 'Drawing the views…'
        ? 'Drawing the views…'
        : 'Matches the model';
  const canUpdate = status.kind === 'stale' || status.kind === 'replaced';
  const exportBlocked =
    (!message || keptDrawing !== null) &&
    (brokenCount > 0 ||
      (exportReason !== null &&
        (exportReason === offPaper || exportReason === refusalReason)));
  const selection: 'annotation' | 'view' | null = selectedAnnotation
    ? 'annotation'
    : selectedView
      ? 'view'
      : null;

  return (
    <section
      ref={workspaceRef}
      className={`drawing-workspace${darkPaper ? ' is-dark-paper' : ''}`}
      aria-label="Drawings"
    >
      <div className="drawing-stage">
        <div className="drawing-stage-bar">
          <div
            className="drawing-sheet-tabs"
            role="tablist"
            aria-label="Drawing sheets"
          >
            {sheets.map((entry) => (
              <button
                key={entry.sheetId}
                type="button"
                role="tab"
                aria-selected={entry.sheetId === sheet.sheetId}
                className={`drawing-sheet-tab${entry.sheetId === sheet.sheetId ? ' active' : ''}`}
                onClick={() => selectSheet(entry.sheetId)}
              >
                <span>{entry.name}</span>
                <span className="drawing-sheet-tab-paper" aria-hidden="true">
                  {DRAWING_PAPER_LABELS[entry.paper.size].split(' (')[0]}
                </span>
              </button>
            ))}
            <button
              type="button"
              className="drawing-sheet-new"
              aria-label="New sheet"
              onClick={createSheet}
              disabled={!editable || props.geometryPending}
              title={
                editDisabledReason ??
                (props.geometryPending
                  ? 'Waiting for the model to finish updating.'
                  : 'New sheet with the four standard views')
              }
            >
              <Plus size={14} aria-hidden="true" />
            </button>
          </div>
          <div className="drawing-stage-actions">
            {syncLabel && (
              <span className="drawing-sync">
                <span className="drawing-sync-dot" aria-hidden="true" />
                {syncLabel}
              </span>
            )}
            {status.kind === 'pending' && (
              <span
                className="drawing-sync is-pending"
                role="status"
                title={message ?? undefined}
              >
                <span className="drawing-sync-dot" aria-hidden="true" />
                {progress
                  ? `Rebuilding ${progress.name} (${progress.index} of ${progress.total})`
                  : 'Model updating…'}
                {progress && progress.total > 0 && (
                  <span
                    className="drawing-progress"
                    role="progressbar"
                    aria-label="Model rebuild"
                    aria-valuemin={0}
                    aria-valuemax={progress.total}
                    aria-valuenow={progress.index}
                  >
                    <span
                      className="drawing-progress-fill"
                      style={{
                        width: `${Math.min(100, (100 * progress.index) / progress.total)}%`
                      }}
                    />
                  </span>
                )}
                {/* The whole sentence for assistive tech; the pill shows
                    its gist. */}
                <span className="visually-hidden">
                  {progress
                    ? `. ${ghost ? 'Showing the last drawing until the views redraw.' : 'The views redraw when it finishes.'}`
                    : `. ${message}`}
                </span>
              </span>
            )}
            {canUpdate && (
              <span
                className="drawing-sync is-outdated"
                role="status"
                title={message ?? undefined}
              >
                <span className="drawing-sync-dot" aria-hidden="true" />
                {status.kind === 'replaced'
                  ? 'Bodies replaced'
                  : 'Model changed'}
                <span className="visually-hidden">
                  {`. ${message}${keptDrawing ? ' Until then it shows the drawing of the earlier model.' : ''}`}
                </span>
                <button
                  type="button"
                  className="drawing-sync-update"
                  disabled={!editable}
                  title={
                    editDisabledReason ??
                    'Redraw this sheet from the current model'
                  }
                  onClick={() =>
                    updateSheet({
                      source: { fingerprint: status.fingerprint },
                      ...(status.kind === 'replaced'
                        ? { bodyReplacements: status.replacements }
                        : {})
                    })
                  }
                >
                  <RefreshCw size={12} aria-hidden="true" /> Update
                </button>
              </span>
            )}
            <div
              className="drawing-zoom"
              role="toolbar"
              aria-label="Sheet zoom"
            >
              <button
                type="button"
                className="drawing-zoom-button"
                aria-label="Zoom out"
                title="Zoom out (Ctrl+wheel or pinch on the sheet)"
                disabled={zoom.zoom <= 1}
                onClick={() => zoomBy(1 / SHEET_ZOOM_STEP)}
              >
                <ZoomOut size={14} aria-hidden="true" />
              </button>
              {/* Plain text, not an <output>: that is a live "status", and the
                  sheet's status lines must stay the only ones. */}
              <span className="drawing-zoom-level" title="Zoom level">
                {Math.round(zoom.zoom * 100)}%
              </span>
              <button
                type="button"
                className="drawing-zoom-button"
                aria-label="Zoom in"
                title="Zoom in (Ctrl+wheel or pinch on the sheet)"
                disabled={zoom.zoom >= MAX_SHEET_ZOOM}
                onClick={() => zoomBy(SHEET_ZOOM_STEP)}
              >
                <ZoomIn size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="drawing-zoom-button"
                aria-label="Fit sheet"
                title="Show the whole sheet"
                disabled={zoom.zoom <= 1}
                onClick={() => setSheetZoom(fitSheetZoom(paper))}
              >
                <Maximize size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="drawing-zoom-button"
                aria-label="Dark paper"
                aria-pressed={darkPaper}
                title={
                  darkPaper
                    ? 'Show the paper white. Exports are always white.'
                    : 'Show the paper dark. Exports stay white.'
                }
                onClick={toggleDarkPaper}
              >
                {darkPaper ? (
                  <Sun size={14} aria-hidden="true" />
                ) : (
                  <Moon size={14} aria-hidden="true" />
                )}
              </button>
            </div>
            <div className="drawing-export">
              <button
                type="button"
                className="primary"
                disabled={exportReason !== null}
                title={
                  exportReason ??
                  (outdated
                    ? 'Export this sheet as drawn, before the latest model change'
                    : 'Export this sheet as a vector PDF')
                }
                onClick={() => void exportSheet('pdf')}
              >
                <FileDown size={13} aria-hidden="true" /> Export PDF
              </button>
              <button
                type="button"
                className="secondary"
                aria-label="Export SVG"
                disabled={exportReason !== null}
                title={
                  exportReason ??
                  (outdated
                    ? 'Export this sheet as SVG, as drawn before the latest model change'
                    : 'Export this sheet as SVG')
                }
                onClick={() => void exportSheet('svg')}
              >
                SVG
              </button>
            </div>
          </div>
        </div>
        {status.kind === 'missing' ? (
          <div className="drawing-banner is-missing" role="status">
            <span>{message}</span>
          </div>
        ) : exportBlocked ? (
          <div className="drawing-banner is-blocked" role="status">
            <span>{exportReason}</span>
          </div>
        ) : null}
        <div className="drawing-canvas-area">
          <svg
            ref={attachCanvas}
            className={`drawing-canvas${zoom.zoom > 1 ? ' is-zoomed' : ''}${ghost ? ' is-ghost' : ''}`}
            role="application"
            aria-label={`Sheet ${sheet.name}`}
            tabIndex={0}
            viewBox={sheetViewBox(zoom, paper)}
            preserveAspectRatio="xMidYMid meet"
            onKeyDown={onCanvasKeyDown}
            onPointerDownCapture={onCanvasPointerDownCapture}
            onPointerMoveCapture={onCanvasPointerMoveCapture}
            onPointerUpCapture={onCanvasPointerEnd}
            onPointerCancelCapture={onCanvasPointerEnd}
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) deselect();
              // A zoomed sheet pans by dragging empty paper.
              const target = event.target as Element;
              if (
                event.button === 0 &&
                zoom.zoom > 1 &&
                !target.closest?.(
                  '.drawing-view-hit, .drawing-annotation-hit, .drawing-pick-surface'
                )
              )
                startPan(event);
            }}
          >
            <rect
              className="drawing-paper"
              width={paper.width}
              height={paper.height}
            />
            {SHEET_STROKE_ORDER.map((kind) => (
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
            ))}
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
              const ghostView = ghost
                ? ghostViews.find((entry) => entry.view === view)
                : undefined;
              const extent =
                state?.state === 'ready' && state.projection.bounds
                  ? state.projection.bounds
                  : (ghostView?.projection.bounds ??
                    estimateViewExtent(bodies, view.bodyIds, view.orientation));
              if (!extent) return null;
              const box = viewPageBox(view, extent, shownSheet, document.units);
              const pad = 3;
              const ready = state?.state === 'ready';
              const label = viewLabel(view);
              return (
                <g
                  key={view.viewId}
                  className={`drawing-view${view.viewId === selectedViewId ? ' is-selected' : ''}${ready ? '' : ' is-placeholder'}`}
                  data-view={
                    view.section
                      ? `section-${view.section.label}`
                      : view.orientation
                  }
                >
                  {!ready && !ghostView && (
                    <rect
                      className="drawing-view-outline"
                      x={box.x}
                      y={paper.height - box.y - box.height}
                      width={box.width}
                      height={box.height}
                    />
                  )}
                  {/* Editor-only: view names (and drawing/error status) are an
                      overlay for picking views. composeSheetPage never draws
                      them, so PDF and SVG exports carry no view labels. */}
                  <text
                    className="drawing-view-label"
                    x={box.x}
                    y={paper.height - box.y + pad + labelSizeMm}
                    fontSize={labelSizeMm}
                  >
                    {state?.state === 'error'
                      ? `${label} — ${state.message}`
                      : ready
                        ? label
                        : status.kind === 'ready'
                          ? `${label} — drawing…`
                          : canUpdate
                            ? `${label} — update to draw`
                            : label}
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
              onPointerDown={deselect}
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
              <AnnotationPreview layer={preview} paperHeight={paper.height} />
            )}
            {autoLayer && (
              <AnnotationPreview
                layer={autoLayer}
                paperHeight={paper.height}
                label="Auto-dimension preview"
              />
            )}
            {tool && hover?.edge && tool.kind !== 'chamfer' && (
              <polyline
                className="drawing-pick-highlight"
                points={svgPoints(hover.edge.page.flat(), paper.height)}
              />
            )}
            {tool &&
              hover?.face &&
              (tool.kind === 'chamfer' ||
                ((tool.kind === 'horizontal' || tool.kind === 'vertical') &&
                  (tool.faces.length === 1 || !hover.edge))) &&
              hover.face.lines.map((line, index) => (
                <polyline
                  key={index}
                  className="drawing-pick-highlight"
                  data-pick="face"
                  points={svgPoints(line.flat(), paper.height)}
                />
              ))}
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
            {sectionTool?.drag && (
              <polyline
                className="drawing-section-preview"
                points={svgPoints(
                  [...sectionTool.drag.start, ...sectionTool.drag.current],
                  paper.height
                )}
              />
            )}
            {sectionDraft &&
              (() => {
                const source = sectionSource(sectionTool!.line);
                const line =
                  source &&
                  sectionLineOnPage(
                    shownSheet,
                    sectionDraft,
                    source,
                    document.units
                  );
                const extent = estimateViewExtent(
                  bodies,
                  sectionDraft.bodyIds,
                  sectionDraft.orientation
                );
                const k = drawingPaperPerModelUnit(
                  shownSheet.scale,
                  document.units
                );
                const width = extent ? (extent.maxU - extent.minU) * k : 20;
                const height = extent ? (extent.maxV - extent.minV) * k : 20;
                return (
                  <g className="drawing-section-draft">
                    {line && (
                      <polyline
                        className="drawing-section-preview"
                        points={svgPoints(
                          [...line.from, ...line.to],
                          paper.height
                        )}
                      />
                    )}
                    <rect
                      className="drawing-section-ghost"
                      x={sectionDraft.centerMm.x - width / 2}
                      y={paper.height - sectionDraft.centerMm.y - height / 2}
                      width={width}
                      height={height}
                    />
                    <text
                      className="drawing-view-label"
                      x={sectionDraft.centerMm.x - width / 2}
                      y={
                        paper.height - sectionDraft.centerMm.y + height / 2 + 4
                      }
                      fontSize={3}
                    >
                      {sectionCaption(sectionDraft.section!.label)}
                    </text>
                  </g>
                );
              })()}
            {sectionTool && (
              <rect
                className="drawing-section-surface"
                aria-label="Section line"
                width={paper.width}
                height={paper.height}
                onPointerDown={onSectionPointerDown}
                onPointerMove={onSectionPointerMove}
                onPointerUp={onSectionPointerUp}
              />
            )}
          </svg>
          <DrawingToolRail
            tool={tool}
            canUseTool={canUseTool}
            disabledReason={toolDisabledReason}
            onTool={(kind) =>
              chooseTool(kind ? startAnnotationTool(kind) : null)
            }
            section={{
              active: sectionTool !== null,
              usable: canSection,
              disabledReason: sectionDisabledReason,
              onToggle: toggleSectionTool
            }}
          />
          {sectionTool && (
            <div className="drawing-tool-hint" role="status">
              <span>
                {sectionTool.line
                  ? 'Move the section view into place along its arrows, then click.'
                  : 'Drag across a view to draw the section line.'}
              </span>
              <button
                type="button"
                className="drawing-tool-hint-cancel"
                onClick={() => setSectionTool(null)}
              >
                Cancel
              </button>
            </div>
          )}
          {tool && (
            <div className="drawing-tool-hint" role="status">
              <span>{annotationToolHint(tool)}</span>
              <button
                type="button"
                className="drawing-tool-hint-cancel"
                onClick={() => chooseTool(null)}
              >
                Cancel <kbd>Esc</kbd>
              </button>
            </div>
          )}
        </div>
      </div>
      <aside className="drawing-panel" aria-label="Drawing properties">
        {selection === 'annotation' && selectedAnnotation ? (
          <AnnotationProperties
            selected={selectedAnnotation}
            ready={sheetReady}
            canRepick={canAnnotate}
            editable={editable}
            units={document.units}
            resolutions={resolutions}
            onTool={chooseTool}
            onDeselect={deselect}
            onUpdate={updateAnnotation}
            onDelete={deleteAnnotation}
          />
        ) : selection === 'view' && selectedView ? (
          <div className="drawing-panel-section is-selection">
            <SelectionHeading
              title={`${viewLabel(selectedView)} view`}
              onDeselect={deselect}
            />
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
            {selectedView.section &&
              (() => {
                const section = selectedView.section;
                const source = sheet.views.find(
                  (view) => view.viewId === section.sourceViewId
                );
                // The plane's world coordinate on the axis it is normal to.
                const normal = drawingSectionPlane({
                  ...selectedView,
                  section
                }).normal;
                const axis =
                  Math.abs(normal.x) === 1
                    ? 'x'
                    : Math.abs(normal.y) === 1
                      ? 'y'
                      : 'z';
                const sign = normal[axis];
                const drawn = projections.get(selectedView.viewId);
                const approximate =
                  drawn?.state === 'ready'
                    ? drawn.projection.sectionApproximate
                    : undefined;
                return (
                  <>
                    <NumberField
                      label={`Cut at ${axis.toUpperCase()} (${document.units})`}
                      value={section.depth * sign}
                      disabled={!editable}
                      onCommit={(value) =>
                        run(
                          commandFactories.updateDrawingView(
                            {
                              sheetId: sheet.sheetId,
                              viewId: selectedView.viewId,
                              sectionDepth: value * sign
                            },
                            'Move section plane'
                          )
                        )
                      }
                    />
                    <p className="drawing-hint">
                      Cut from the{' '}
                      {source
                        ? DRAWING_VIEW_LABELS[source.orientation].toLowerCase()
                        : 'source'}{' '}
                      view along its line {section.label}-{section.label}: it
                      stays aligned with it. Cut faces are hatched.
                    </p>
                    {approximate ? (
                      <p className="drawing-hint" role="note">
                        Approximate: cut from the tessellation, to the display
                        tolerance. {approximate} Its cut edges cannot be
                        dimensioned.
                      </p>
                    ) : (
                      <p className="drawing-hint">
                        The cut is the kernel&apos;s exact boolean; hidden lines
                        are approximate to the display tolerance.
                      </p>
                    )}
                  </>
                );
              })()}
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
                ...selectedView.bodyIds.filter((id) => !liveBodies.includes(id))
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
          </div>
        ) : (
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
        )}
        <div className="drawing-panel-section">
          <h3>Views · {sheet.views.length}</h3>
          {/* Every view, whether or not it is on the page: a view left off
              the paper (a smaller sheet, an old document) can still be
              picked here, then moved back or deleted. */}
          <div
            className="drawing-view-list"
            role="listbox"
            aria-label="Views on this sheet"
          >
            {sheet.views.map((view) => {
              // The view's whole footprint, not its centre: a view half off
              // the paper exports half a view.
              const issue = placements.get(view.viewId);
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
                  {viewLabel(view)}
                  {issue ? ` (${PLACEMENT_LABELS[issue]})` : ''}
                </button>
              );
            })}
          </div>
          {/* Off the paper is said once, over the sheet, where it blocks
              export. This one blocks nothing, so it is plain text, not a
              live status that would talk over the sheet's own banner. */}
          {!offPaper && layoutWarning && (
            <p className="drawing-field-warning">{layoutWarning}</p>
          )}
          {!selectedView && (
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
          <button
            type="button"
            className="secondary"
            disabled={!editable || sheet.views.length === 0}
            title={
              editDisabledReason ??
              'Lay the views out again above the title block, at a smaller scale if they need it'
            }
            onClick={() => fitViews()}
          >
            <Maximize size={13} aria-hidden="true" /> Fit views to sheet
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!editable || sheet.views.length === 0}
            title={
              editDisabledReason ??
              'Lay the views out again, evenly spaced, at the largest scale that fits above the title block'
            }
            onClick={() => fitViews(true)}
          >
            <Scaling size={13} aria-hidden="true" /> Auto scale
          </button>
        </div>
        <AnnotationList
          sheet={sheet}
          ready={sheetReady}
          selected={selectedAnnotation}
          resolutions={resolutions}
          onSelect={(annotationId) => {
            setSelectedAnnotationId(annotationId);
            setSelectedViewId(null);
          }}
        />
        <DimensionCheck
          sheet={sheet}
          ready={sheetReady}
          audit={dimensionAudit}
          resolutions={resolutions}
          onSelect={(annotationId) => {
            setSelectedAnnotationId(annotationId);
            setSelectedViewId(null);
          }}
          autoDisabledReason={autoDisabledReason}
          autoPlan={shownAutoPlan}
          onAuto={startAutoDimension}
          onApplyAuto={applyAutoDimension}
          onCancelAuto={() => setAutoPlan(null)}
        />
        {selection === null && (
          <>
            <div className="drawing-panel-section">
              <h3>Title block</h3>
              {TITLE_FIELDS.map(({ key, label }) => (
                <TextField
                  key={key}
                  label={label}
                  value={sheet.titleBlock[key] ?? ''}
                  placeholder={key === 'title' ? document.name : undefined}
                  printed
                  disabled={!editable}
                  onCommit={(value) =>
                    updateSheet({ titleBlock: { [key]: value } })
                  }
                />
              ))}
            </div>
            <div className="drawing-panel-section">
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
          </>
        )}
      </aside>
    </section>
  );
}

export default DrawingWorkspace;
