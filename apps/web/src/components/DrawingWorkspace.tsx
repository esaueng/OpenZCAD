import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react';
import {
  Angle,
  ChartPie,
  Crosshair,
  DraftingCompass,
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
  MessageCircle,
  Anchor,
  Columns3,
  Diff,
  TableProperties,
  ImageIcon,
  Sun,
  Trash2,
  TriangleRight,
  LocateFixed,
  SeparatorVertical,
  CircleDashed,
  X,
  ZoomIn,
  SquareArrowOutUpRight,
  ZoomOut,
  type LucideIcon
} from 'lucide-react';
import {
  commandFactories,
  composeCommands,
  type AnyCommand
} from '@openzcad/command-system';
import {
  ASSEMBLY_BOM_COLUMNS,
  documentForConfiguration,
  updateDrawingView
} from '@openzcad/document-core';
import {
  drawingViewFrame,
  createDrawingAnnotationId,
  createDrawingViewId,
  MAX_DRAWING_DIMENSION_AFFIX_LENGTH,
  MAX_DRAWING_DIMENSION_COUNT,
  drawingToleranceError,
  MAX_DRAWING_DIMENSION_DECIMALS,
  MAX_DRAWING_TOLERANCE,
  MAX_DRAWING_IMAGE_WIDTH_MM,
  MAX_DRAWING_SECTION_STEPS,
  MAX_DRAWING_NOTE_LENGTH,
  MIN_DRAWING_IMAGE_WIDTH_MM,
  type DrawingAnnotation,
  type DrawingTolerance,
  type DrawingDetail,
  type DrawingDimension,
  isDrawingDimension,
  isDrawingGeometryAnnotation,
  drawingToleranceHostAllowed,
  DRAWING_GEOMETRIC_CHARACTERISTICS,
  DRAWING_DATUM_REQUIRED_CHARACTERISTICS,
  DRAWING_DIAMETER_ZONE_CHARACTERISTICS,
  DRAWING_FORM_CHARACTERISTICS,
  DRAWING_MATERIAL_CHARACTERISTICS,
  DRAWING_DATUM_MATERIAL_CHARACTERISTICS,
  MAX_DRAWING_DATUM_REFERENCES,
  DRAWING_THREAD_CLASSES,
  DRAWING_ISO_GEOMETRIC_CLASSES,
  type DrawingThreadClass,
  type DrawingRadialDimension,
  type DrawingIsoLinearClass,
  type DrawingIsoGeometricClass,
  type DrawingGeometricCharacteristic,
  type DrawingMaterialCondition,
  type UnitSystem,
  type DrawingLineClass,
  type DrawingSheetFormat,
  DRAWING_LINE_CLASSES,
  DRAWING_LINE_CLASS_LABELS,
  MAX_DRAWING_LINE_WIDTH_MM,
  MIN_DRAWING_LINE_WIDTH_MM,
  type DrawingToleranceKind,
  type DrawingAnnotationId,
  DRAWING_PAPER_LABELS,
  DRAWING_PAPER_SIZES_MM,
  DRAWING_SCALE_PRESETS,
  DRAWING_VIEW_LABELS,
  DRAWING_VIEW_ORIENTATIONS,
  drawingPaperMm,
  drawingPaperPerModelUnit,
  drawingSectionOrientations,
  drawingSectionCut,
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
  type DrawingSectionStep,
  type DrawingView,
  type DrawingViewId,
  type DrawingViewOrientation,
  type ProjectDocument,
  hasDraftDisplay
} from '@openzcad/shared';
import {
  WheelGestureClassifier,
  type PointerNavigationMode
} from '@openzcad/viewport/wheel-gesture';
import { DrawingSheetTabs } from './DrawingSheetTabs';
import {
  readWheelDeviceMemory,
  writeWheelDeviceMemory
} from '../lib/wheelDeviceMemory';
import {
  deletedSheetSummary,
  deletedViewSummary,
  duplicateDrawingSheet,
  movedSheets,
  nextSheetName,
  sheetOrderSteps
} from '../lib/drawing/sheetEdits';
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
  detailCaption,
  auxiliaryCaption,
  sectionLineOnPage,
  SHEET_STROKE_ORDER,
  type ComposedView,
  fitViewsToSheet,
  freeViewCenter,
  nextViewOrientation,
  sheetUnprintableCharacters,
  SHEET_STROKE_WIDTH_MM,
  titleBlockAutoDate,
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
  SheetPictureUnavailableError,
  sheetPageToPdf,
  sheetPageToDxf,
  sheetPageToSvg,
  sheetTextStart
} from '../lib/drawing/sheetExport';
import {
  loadPagePictures,
  pagePictures,
  pictureDataUrl,
  pictureJpegBytes
} from '../lib/drawing/sheetPictures';
import {
  annotationAnchor,
  composeSheetAnnotations,
  defaultDimensionDecimals,
  DEFAULT_BOM_COLUMNS,
  sheetMarkLookup,
  sheetNumberFormat,
  type DrawingNumberFormat,
  markHiddenLeaders,
  markBrokenHosts,
  sheetBom,
  sheetPictures,
  balloonComponent,
  previewAnnotationLayer,
  resolveSheetAnnotations,
  drawingDatumLetters,
  type DatumLetters,
  holeCalloutLookup,
  type HoleCalloutLookup,
  type SheetPictureLookup,
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
  isGeometryTool,
  isToleranceTool,
  nextDatumLetter,
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
import { CHARACTERISTIC_LABELS } from '../lib/drawing/toleranceFrames';
import { FIT_GRADES, FIT_LETTERS } from '../lib/drawing/isoTolerances';
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
import {
  ROW_SEPARATOR,
  activeRowSheet,
  projectionSheet,
  projectionViewCacheKey,
  projectionViewRow,
  rowBodyKey,
  rowContentKey,
  viewConfigurationRows
} from '../lib/drawing/viewConfigurations';
import { saveCadBinaryFile, saveCadTextFile } from '../lib/desktopBridge';
import {
  sectionLineFromDrag,
  sectionPlacement,
  sectionSnapPoints,
  sectionSnapTargets,
  sectionSourceAt,
  type SectionLine
} from '../lib/drawing/sectionTool';
import {
  auxiliaryDraft,
  auxiliaryEdgeRefusal
} from '../lib/drawing/auxiliaryTool';
import {
  detailDraft,
  detailRegionFromDrag,
  detailSourceAt
} from '../lib/drawing/detailTool';
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
  /**
   * D02 (v92): a reference image's bytes by checksum, from the project's
   * content-addressed store, for sheet images. Absent: none can be shown.
   */
  loadReferenceImage?: (checksumSha256: string) => Promise<Blob | null>;
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
    /** v93: with a stepped section's steps. */
    plane: ReturnType<typeof drawingSectionCut>,
    signal: AbortSignal
  ) => Promise<Record<string, SectionBodyInput>>;
  /** Why drawing edits are refused, or null. */
  editDisabledReason: string | null;
  onCommand: (command: AnyCommand) => boolean;
  onStatus: (message: string, options?: { immediate?: boolean }) => void;
  /**
   * A notice that offers Undo, for a delete that removes more than was
   * clicked (a sheet's views, a view's sections and dimensions). Absent,
   * it is a plain status.
   */
  onAnnounceUndoable?: (message: string) => void;
  /**
   * What a plain wheel does, as in Build (Settings > Controls): a notch
   * zooms, a trackpad swipe pans. Auto when absent.
   */
  pointerNavigation?: PointerNavigationMode;
  /**
   * D06: the sheet on screen as the assistant reads it, or null when there
   * is none. Called whenever what it measures changes.
   */
  onAssistantSource?: (source: DrawingAssistantSource | null) => void;
  /**
   * The sheet on screen, or null when there is none (and when the workspace
   * closes). The stage's guidance reads it: which sheet is open is this
   * workspace's own state.
   */
  onActiveSheetChange?: (sheetId: DrawingSheetId | null) => void;
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
  const cut = view.section
    ? `|section:${view.section.depth}${
        // D03 (v91): a free section projects in its own frame.
        view.section.frame
          ? `|frame:${[view.section.frame.direction, view.section.frame.x]
              .map((v) => `${v.x},${v.y},${v.z}`)
              .join('|')}`
          : ''
      }${
        // v93: a stepped section's steps.
        view.section.steps?.length
          ? `|steps:${view.section.steps.map((step) => `${step.at}@${step.depth}`).join(',')}`
          : ''
      }`
    : '';
  // D03 (v81): an auxiliary view projects in its own frame.
  const aux = view.auxiliary
    ? `|aux:${[view.auxiliary.direction, view.auxiliary.x]
        .map((v) => `${v.x},${v.y},${v.z}`)
        .join('|')}`
    : '';
  // F06: a view on another configuration row (`projectionSheet`).
  const row = view.configurationId ? `|row:${view.configurationId}` : '';
  return `${view.orientation}|${view.hiddenLines}|${[...view.bodyIds].sort().join(',')}${cut}${aux}${row}`;
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
  selectedSheetId?: DrawingSheetId;
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
  /**
   * M01: the hole callouts of the document it was drawn from, so a kept
   * sheet calls its holes out as drawn until it is Updated.
   */
  holes: HoleCalloutLookup;
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
// D07: the PMI labels draw frames with the drawing's own geometry, loaded
// with this chunk rather than shared out of it.
export {
  datumFeatureLayout,
  featureControlFrameLayout
} from '../lib/drawing/toleranceFrames';

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
    /** By tessellation key (`rowBodyKey`): body id, on its configuration row. */
    bodies: Map<string, ProjectionBodyInput>;
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
    // F06: bodies by tessellation key (`rowBodyKey`): a view on another
    // configuration row meshes that row's bodies, kept apart from the
    // active row's.
    const bodyIds = new Set<string>();
    const bodyOf = new Map<string, { row: string | null; id: BodyId }>();
    /** A section's plane, on its view's configuration row. */
    const planeOf = (view: DrawingView): string | null => {
      const plane = sectionPlaneKey(view);
      const cacheKey = projectionViewCacheKey(view);
      return plane && cacheKey ? `${cacheKey}${ROW_SEPARATOR}${plane}` : plane;
    };
    const cuts = new Map<
      string,
      {
        plane: ReturnType<typeof drawingSectionCut>;
        row: string | null;
        bodyIds: Set<BodyId>;
        views: DrawingView[];
      }
    >();
    const sectionKeys = new Map<string, DrawingView>();
    const passMarkers = new Map<string, ViewState>();
    for (const view of sheet.views) {
      const key = projectionKey(fingerprint, view);
      if (cache.current.has(key) || passMarkers.has(key)) continue;
      const planeKey = planeOf(view);
      const row = projectionViewRow(view);
      if (planeKey && view.section) {
        const cut = cuts.get(planeKey) ?? {
          // v93: a stepped section's steps go with its plane.
          plane: drawingSectionCut(
            { ...view, section: view.section },
            sheet.views.find(
              (entry) => entry.viewId === view.section!.sourceViewId
            )?.orientation
          ),
          row,
          bodyIds: new Set<BodyId>(),
          views: []
        };
        for (const id of view.bodyIds) cut.bodyIds.add(id);
        cut.views.push(view);
        cuts.set(planeKey, cut);
        sectionKeys.set(key, view);
      } else {
        for (const id of view.bodyIds) {
          const key = rowBodyKey(projectionViewCacheKey(view), id);
          bodyIds.add(key);
          bodyOf.set(key, { row, id });
        }
        views.push({
          key,
          orientation: view.orientation,
          ...(view.auxiliary ? { frame: drawingViewFrame(view) } : {}),
          hiddenLines: view.hiddenLines,
          // In the key's order: the lines come out in body order, and a view
          // whose bodies were removed and re-added must export the same bytes
          // whether its projection was cached or made after a reload.
          bodyIds: [...view.bodyIds]
            .sort()
            .map((id) => rowBodyKey(projectionViewCacheKey(view), id))
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
      // F06: a row's meshes and cuts are kept only while a view still draws
      // that row at that model content; a row edit replaces, not adds.
      const rowKeys = new Set(
        sheet.views.flatMap((view) => projectionViewCacheKey(view) ?? [])
      );
      for (const cache of [known.bodies, known.sections])
        for (const key of [...cache.keys()]) {
          const cut = key.lastIndexOf(ROW_SEPARATOR);
          if (cut >= 0 && !rowKeys.has(key.slice(0, cut))) cache.delete(key);
        }
      const missing = [...bodyIds].filter((id) => !known.bodies.has(id));
      const {
        document: current,
        requestTessellation: tessellate,
        requestSection: section
      } = latest.current;
      // F06: each configuration row a view draws, built on its own.
      const rowDocuments = new Map<string, ProjectDocument>();
      const documentFor = (row: string | null): ProjectDocument => {
        if (!row) return current;
        let built = rowDocuments.get(row);
        if (!built) {
          built = documentForConfiguration(current, row);
          rowDocuments.set(row, built);
        }
        return built;
      };
      /** A section refused by the kernel: final, not a transport failure. */
      const refusals = new Map<string, string>();
      const sectioned = [...cuts].map(([planeKey, cut]) => {
        if (known.sections.has(planeKey)) return Promise.resolve();
        if (!section)
          return Promise.resolve(
            refusals.set(planeKey, 'Section views cannot be drawn here.')
          ).then(() => undefined);
        return section(
          documentFor(cut.row),
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
          ? // One request per configuration row, each against that row.
            Promise.all(
              [
                ...missing.reduce((groups, key) => {
                  const row = bodyOf.get(key)!.row ?? '';
                  groups.set(row, [...(groups.get(row) ?? []), key]);
                  return groups;
                }, new Map<string, string[]>())
              ].map(async ([row, keys]) => {
                const meshed = await tessellate(
                  documentFor(row || null),
                  keys.map((key) => bodyOf.get(key)!.id).sort(),
                  signal
                );
                return keys.flatMap((key) => {
                  const input = meshed[bodyOf.get(key)!.id];
                  return input ? [[key, input] as const] : [];
                });
              })
            ).then(
              (entries) =>
                Object.fromEntries(entries.flat()) as Record<
                  string,
                  ProjectionBodyInput
                >
            )
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
            const planeKey = planeOf(view)!;
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
              const inputKey = rowBodyKey(
                projectionViewCacheKey(view),
                sectionInputKey(view, id)
              );
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
              ...(view.section?.frame ? { frame: drawingViewFrame(view) } : {}),
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
            const cut = view && known.sections.get(planeOf(view)!);
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
    : view.detail
      ? `Detail ${view.detail.label}`
      : view.auxiliary
        ? `View ${view.auxiliary.label}`
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
  'distance',
  'radius',
  'diameter',
  'angle',
  'arc-angle',
  'three-point-angle',
  'chamfer',
  'note',
  'center-mark',
  'intersection-mark',
  'centerline',
  'circle-centerline',
  'balloon',
  'parts-list',
  'image',
  'datum-feature',
  'feature-control-frame',
  'general-tolerance'
];

const ANNOTATION_TOOL_ICONS: Readonly<Record<AnnotationToolKind, LucideIcon>> =
  {
    horizontal: MoveHorizontal,
    vertical: MoveVertical,
    aligned: MoveDiagonal2,
    distance: Ruler,
    radius: Radius,
    diameter: Diameter,
    angle: Angle,
    'arc-angle': ChartPie,
    'three-point-angle': DraftingCompass,
    chamfer: TriangleRight,
    note: StickyNote,
    'center-mark': Crosshair,
    'intersection-mark': LocateFixed,
    centerline: SeparatorVertical,
    'circle-centerline': CircleDashed,
    balloon: MessageCircle,
    'parts-list': TableProperties,
    image: ImageIcon,
    'datum-feature': Anchor,
    'feature-control-frame': Columns3,
    'general-tolerance': Diff
  };

/** One key per tool, live while Draw is open and focus is not in a field. */
const ANNOTATION_TOOL_KEYS: Readonly<Record<AnnotationToolKind, string>> = {
  horizontal: 'H',
  vertical: 'V',
  aligned: 'A',
  distance: 'T',
  radius: 'R',
  diameter: 'D',
  angle: 'G',
  'arc-angle': 'E',
  'three-point-angle': 'J',
  chamfer: 'C',
  note: 'N',
  'center-mark': 'M',
  'intersection-mark': 'X',
  centerline: 'L',
  'circle-centerline': 'B',
  balloon: 'O',
  'parts-list': 'P',
  image: 'I',
  'datum-feature': 'Q',
  'feature-control-frame': 'F',
  'general-tolerance': 'W'
};

/**
 * D07 (v98): a new frame's tolerance, by the units the sheet prints in:
 * about a tenth of a millimetre, a round number in each.
 */
const DEFAULT_FRAME_AMOUNT: Readonly<Record<UnitSystem, number>> = {
  mm: 0.1,
  cm: 0.01,
  m: 0.0001,
  inch: 0.004
};

/** D03: the section view tool's key, beside the annotation tools'. */
const SECTION_TOOL_KEY = 'S';
/** D03 (v78): the detail view tool's key. */
const DETAIL_TOOL_KEY = 'K';
/** D03 (v81): the auxiliary view tool's key. */
const AUXILIARY_TOOL_KEY = 'U';

/** D02 (v92): how long before an unavailable sheet picture is asked again. */
const PICTURE_RETRY_MS = 15_000;

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
  distance: 'Distance',
  radius: 'Radius',
  diameter: 'Diameter',
  angle: 'Angle',
  'arc-angle': 'Arc angle',
  'three-point-angle': '3-point angle',
  chamfer: 'Chamfer',
  note: 'Note',
  'center-mark': 'Centre mark',
  'intersection-mark': 'Intersection mark',
  centerline: 'Centreline',
  'bom-table': 'Parts list',
  balloon: 'Balloon',
  image: 'Image',
  'datum-feature': 'Datum feature',
  'feature-control-frame': 'Feature control frame',
  'general-tolerance': 'General tolerances'
};

function annotationTitle(annotation: DrawingAnnotation): string {
  if (annotation.kind === 'centerline')
    return annotation.mode === 'circle'
      ? 'Circular centreline'
      : annotation.mode === 'lines'
        ? 'Centreline between lines'
        : 'Centreline';
  return annotation.kind === 'linear'
    ? `${ANNOTATION_TOOL_LABELS[annotation.direction]} dimension`
    : annotation.kind === 'note' ||
        annotation.kind === 'bom-table' ||
        annotation.kind === 'balloon' ||
        annotation.kind === 'datum-feature' ||
        annotation.kind === 'feature-control-frame' ||
        annotation.kind === 'general-tolerance' ||
        isDrawingGeometryAnnotation(annotation)
      ? ANNOTATION_KIND_LABELS[annotation.kind]
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
  if (!resolution?.ok) return `${title} (broken)`;
  // A mark states no value: its name is its kind.
  return resolution.resolved.label
    ? `${title} ${resolution.resolved.label}`
    : title;
}

/**
 * A list longer than this shows only its first `LIST_PREVIEW` rows until
 * asked; a large assembly otherwise buries the panel under hundreds of rows.
 * The gap keeps a "Show all" from revealing only one or two more.
 */
const LIST_CLIP_AT = 8;
const LIST_PREVIEW = 5;
const BODY_NAMES_CLIP_AT = 4;
const BODY_NAMES_PREVIEW = 3;

/**
 * Rows of a list, clipped to a preview with a toggle when long. `reveal` is
 * the index of a row that must stay visible (the selection): it expands the
 * list when it falls past the preview.
 */
function ClippedList(props: {
  rows: ReactNode[];
  /** Wraps the visible rows in the list element itself. */
  wrap: (rows: ReactNode[], expanded: boolean) => ReactNode;
  /** What the rows are, for the toggle's accessible name. */
  noun: string;
  reveal?: number;
}) {
  const [open, setOpen] = useState(false);
  const { rows } = props;
  const clipped = rows.length > LIST_CLIP_AT;
  const expanded = !clipped || open || (props.reveal ?? -1) >= LIST_PREVIEW;
  return (
    <>
      {props.wrap(
        expanded ? rows : rows.slice(0, LIST_PREVIEW),
        clipped && expanded
      )}
      {clipped && (props.reveal ?? -1) < LIST_PREVIEW && (
        <button
          type="button"
          className="drawing-list-toggle"
          aria-expanded={expanded}
          aria-label={
            expanded
              ? `Show fewer ${props.noun}`
              : `Show all ${rows.length} ${props.noun}`
          }
          onClick={() => setOpen(!expanded)}
        >
          {expanded ? 'Show fewer' : `Show ${rows.length - LIST_PREVIEW} more`}
        </button>
      )}
    </>
  );
}

/** The bodies a sheet draws, named in full only when there are few. */
function SheetBodies(props: { names: string[] }) {
  const [open, setOpen] = useState(false);
  const { names } = props;
  const clipped = names.length > BODY_NAMES_CLIP_AT;
  const shown =
    clipped && !open
      ? `${names.slice(0, BODY_NAMES_PREVIEW).join(', ')} and ${names.length - BODY_NAMES_PREVIEW} more`
      : names.join(', ');
  return (
    <>
      <p
        className={`drawing-hint${clipped && open ? ' drawing-clipped-text' : ''}`}
        aria-label="Sheet bodies"
      >
        {clipped ? `Bodies · ${names.length}: ` : 'Bodies: '}
        {shown}
      </p>
      {clipped && (
        <button
          type="button"
          className="drawing-list-toggle"
          aria-expanded={open}
          aria-label={
            open
              ? 'Show fewer body names'
              : `Show all ${names.length} body names`
          }
          onClick={() => setOpen(!open)}
        >
          {open ? 'Show fewer' : 'Show all'}
        </button>
      )}
    </>
  );
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
        <ClippedList
          noun="annotations"
          reveal={annotations.findIndex(
            (annotation) => annotation.annotationId === selected?.annotationId
          )}
          wrap={(rows, expanded) => (
            <div
              className={`drawing-view-list${expanded ? ' is-scrolling' : ''}`}
              role="listbox"
              aria-label="Annotations on this sheet"
            >
              {rows}
            </div>
          )}
          rows={annotations.map((annotation) => {
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
        />
      ) : (
        <p className="drawing-hint">
          Pick a dimension tool on the sheet&apos;s left. Dimensions read their
          values from the model and follow the sheet&apos;s Update.
        </p>
      )}
    </div>
  );
}

/**
 * D03 (v93): where along its line a stepped section's steps may go: the
 * source's extent along the line (its u for a horizontal line, v for a
 * vertical one), in model units.
 */
function sectionStepRange(
  source: DrawingView,
  section: DrawingView,
  drawn: ViewState | undefined
): [number, number] | null {
  if (drawn?.state !== 'ready' || !drawn.projection.bounds) return null;
  const alignment = drawingViewAlignment(
    source.orientation,
    section.orientation
  );
  if (alignment === null) return null;
  const bounds = drawn.projection.bounds;
  return alignment === 'column'
    ? [bounds.minU, bounds.maxU]
    : [bounds.minV, bounds.maxV];
}

/** D03 (v93): a section's steps: where each starts and its own cut. */
function SectionStepFields(props: {
  steps: readonly DrawingSectionStep[];
  firstDepth: number;
  /** World coordinate per stored depth, as the Cut at field shows it. */
  sign: number;
  axisLabel: string;
  units: string;
  /** The source's extent along the line; null while it is not drawn. */
  bounds: [number, number] | null;
  editable: boolean;
  onCommit: (steps: DrawingSectionStep[]) => void;
}) {
  const { steps, sign } = props;
  const commit = (next: DrawingSectionStep[]) =>
    props.onCommit([...next].sort((a, b) => a.at - b.at));
  const add = () => {
    if (!props.bounds) return;
    const [low, high] = props.bounds;
    const last = steps.at(-1);
    const from = last ? last.at : low;
    const at = Math.round(((from + high) / 2) * 10) / 10;
    commit([...steps, { at, depth: last ? last.depth : props.firstDepth }]);
  };
  return (
    <div className="drawing-section-steps">
      {steps.map((step, index) => (
        <div key={index} className="drawing-field-row">
          <NumberField
            label={`Step ${index + 1} at (${props.units})`}
            value={step.at}
            disabled={!props.editable}
            onCommit={(at) =>
              commit(
                steps.map((entry, i) =>
                  i === index ? { ...entry, at } : entry
                )
              )
            }
          />
          <NumberField
            label={`Step ${index + 1} cut at ${props.axisLabel} (${props.units})`}
            value={step.depth * sign}
            disabled={!props.editable}
            onCommit={(value) =>
              commit(
                steps.map((entry, i) =>
                  i === index ? { ...entry, depth: value * sign } : entry
                )
              )
            }
          />
          <button
            type="button"
            className="secondary"
            disabled={!props.editable}
            aria-label={`Remove step ${index + 1}`}
            onClick={() => commit(steps.filter((_, i) => i !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="secondary"
        disabled={
          !props.editable ||
          !props.bounds ||
          steps.length >= MAX_DRAWING_SECTION_STEPS
        }
        onClick={add}
        title="Step the cutting line to another depth along its run"
      >
        Add step
      </button>
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
  const raw = plan.annotations.filter(
    (annotation) => annotation.provenance?.basis === 'geometry'
  ).length;
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
      {raw > 0 && (
        <p className="drawing-hint">
          {raw === 1 ? '1 is' : `${raw} are`} read from raw geometry: no
          recognized feature of the import states {raw === 1 ? 'it' : 'them'}.
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
          <FindingList
            label="Dimensions Auto-dimension leaves for you"
            findings={left}
          />
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

/** Worded findings, clipped like any long list. */
function FindingList(props: {
  label: string;
  findings: readonly { bodyId: string; message: string }[];
}) {
  return (
    <ClippedList
      noun={props.label.toLowerCase()}
      wrap={(rows, expanded) => (
        <ul
          className={`drawing-audit-list${expanded ? ' is-scrolling' : ''}`}
          aria-label={props.label}
        >
          {rows}
        </ul>
      )}
      rows={props.findings.map((finding, index) => (
        // Keyed by position too: like bodies word findings identically.
        <li key={`${finding.bodyId}:${index}`}>{finding.message}</li>
      ))}
    />
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
              <FindingList
                label="Missing dimensions"
                findings={audit.missing}
              />
            </>
          )}
          {audit.redundant.length > 0 && (
            <>
              <p className="drawing-audit-heading is-warning">
                Repeated · {audit.redundant.length}
              </p>
              <ClippedList
                noun="repeated dimensions"
                wrap={(rows, expanded) => (
                  <div
                    className={`drawing-view-list${expanded ? ' is-scrolling' : ''}`}
                  >
                    {rows}
                  </div>
                )}
                rows={audit.redundant.map((finding) =>
                  entry(finding.annotationId, finding.message)
                )}
              />
            </>
          )}
          {audit.unmeasurable.length > 0 && (
            <>
              <p className="drawing-audit-heading">
                Can&apos;t dimension yet · {audit.unmeasurable.length}
              </p>
              <FindingList
                label="Requirements no dimension can state yet"
                findings={audit.unmeasurable}
              />
            </>
          )}
          {audit.unchecked.length > 0 && (
            <>
              <p className="drawing-audit-heading">
                Not checked · {audit.unchecked.length}
              </p>
              <ClippedList
                noun="unchecked dimensions"
                wrap={(rows, expanded) => (
                  <div
                    className={`drawing-view-list${expanded ? ' is-scrolling' : ''}`}
                  >
                    {rows}
                  </div>
                )}
                rows={audit.unchecked.map((finding) =>
                  entry(finding.annotationId, finding.message)
                )}
              />
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
  /** The sheet's number format: its printed units and default precision. */
  numberFormat: DrawingNumberFormat;
  resolutions: ReadonlyMap<DrawingAnnotationId, AnnotationResolution>;
  /** D02 (v92): the project's pictures a sheet image may show. */
  pictures: SheetPictureLookup;
  /** D07 (v98): datum letters declared across the drawing. */
  datumLetters: DatumLetters;
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
          Broken: {resolution.message}{' '}
          {selected.kind === 'image'
            ? 'Choose another picture, or delete it.'
            : 'Re-pick what it measures, or delete it.'}
        </p>
      ) : resolution?.ok && isDrawingDimension(selected) ? (
        <p className="drawing-annotation-value">
          {resolution.resolved.label}
          {selected.kind === 'angle' ||
          selected.kind === 'arc-angle' ||
          selected.kind === 'three-point-angle' ||
          selected.kind === 'chamfer'
            ? ''
            : ` ${props.numberFormat.units}`}
        </p>
      ) : null}
      {isDrawingGeometryAnnotation(selected) ? (
        <p className="drawing-hint">
          Marks geometry; dimensions may measure to a centre or intersection
          mark.
        </p>
      ) : selected.kind === 'bom-table' ? (
        <BomColumnFields
          selected={selected}
          editable={editable}
          onUpdate={props.onUpdate}
        />
      ) : selected.kind === 'image' ? (
        <>
          <label className="drawing-field">
            <span>Picture</span>
            <select
              value={
                props.pictures.has(selected.referenceImageId)
                  ? selected.referenceImageId
                  : ''
              }
              disabled={!editable}
              onChange={(event) =>
                event.target.value &&
                props.onUpdate(
                  { ...selected, referenceImageId: event.target.value },
                  'Change sheet image'
                )
              }
            >
              {props.pictures.has(selected.referenceImageId) ? null : (
                <option value="">Deleted picture</option>
              )}
              {[...props.pictures].map(([id, picture]) => (
                <option key={id} value={id}>
                  {picture.name}
                </option>
              ))}
            </select>
          </label>
          <NumberField
            label="Width (mm)"
            value={selected.widthMm}
            disabled={!editable}
            onCommit={(value) =>
              props.onUpdate(
                {
                  ...selected,
                  widthMm: Math.min(
                    MAX_DRAWING_IMAGE_WIDTH_MM,
                    Math.max(MIN_DRAWING_IMAGE_WIDTH_MM, value)
                  )
                },
                'Resize sheet image'
              )
            }
          />
          <p className="drawing-hint">
            One of the project&apos;s pictures (Insert image in Build), printed
            at this width; its height keeps the picture&apos;s shape.
          </p>
        </>
      ) : selected.kind === 'balloon' ? (
        <p className="drawing-hint">
          Names the item number its part has in the assembly&apos;s parts list;
          it follows the list&apos;s numbering.
        </p>
      ) : selected.kind === 'general-tolerance' ? (
        <GeneralToleranceFields
          selected={selected}
          editable={editable}
          numberFormat={props.numberFormat}
          onUpdate={props.onUpdate}
        />
      ) : selected.kind === 'datum-feature' ||
        selected.kind === 'feature-control-frame' ? (
        <ToleranceAnnotationFields
          selected={selected}
          editable={editable}
          datumLetters={props.datumLetters}
          numberFormat={props.numberFormat}
          onUpdate={props.onUpdate}
        />
      ) : selected.kind === 'note' ? (
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
              Default (
              {selected.kind === 'angle' ||
              selected.kind === 'arc-angle' ||
              selected.kind === 'three-point-angle'
                ? props.numberFormat.angleDecimals
                : props.numberFormat.lengthDecimals}
              )
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
      {isDrawingDimension(selected) && (
        <DimensionFormat
          selected={selected}
          editable={editable}
          onUpdate={props.onUpdate}
        />
      )}
      {selected.provenance && (
        <p className="drawing-hint">
          {selected.provenance.basis === 'geometry'
            ? 'Placed by Auto-dimension from raw geometry: no recognized feature of this import states it.'
            : 'Placed by Auto-dimension.'}{' '}
          Re-picking it makes it yours.
        </p>
      )}
      <div className="drawing-field-row">
        {selected.kind !== 'bom-table' &&
          selected.kind !== 'image' &&
          selected.kind !== 'general-tolerance' &&
          (selected.kind !== 'note' || selected.leader) && (
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

/** D07 (v98): the single datum letters, A to Z without I, O and Q. */
const DATUM_LETTERS = [...'ABCDEFGHJKLMNPRSTUVWXYZ'];

const MATERIAL_LABELS: Readonly<Record<DrawingMaterialCondition, string>> = {
  mmc: 'MMC (M)',
  lmc: 'LMC (L)'
};

const DATUM_PRECEDENCE = ['Primary', 'Secondary', 'Tertiary'] as const;

/**
 * D07 (v98): a datum symbol's letter, or a frame's characteristic,
 * tolerance, zone, modifier and datum references. Choices the standard
 * forbids for the characteristic are disabled, and changing it drops what
 * it no longer takes, so every update is one the schema accepts.
 */
function ToleranceAnnotationFields(props: {
  selected: Extract<
    DrawingAnnotation,
    { kind: 'datum-feature' | 'feature-control-frame' }
  >;
  editable: boolean;
  datumLetters: DatumLetters;
  numberFormat: DrawingNumberFormat;
  onUpdate: (annotation: DrawingAnnotation, label?: string) => void;
}) {
  const { selected, editable, datumLetters } = props;
  if (selected.kind === 'datum-feature') {
    const free = DATUM_LETTERS.filter(
      (letter) =>
        letter === selected.letter || (datumLetters.get(letter) ?? 0) === 0
    );
    return (
      <>
        <label className="drawing-field">
          <span>Letter</span>
          <select
            value={selected.letter}
            disabled={!editable}
            onChange={(event) =>
              props.onUpdate(
                { ...selected, letter: event.target.value },
                'Change datum letter'
              )
            }
          >
            {free.includes(selected.letter) ? null : (
              <option value={selected.letter}>{selected.letter}</option>
            )}
            {free.map((letter) => (
              <option key={letter} value={letter}>
                {letter}
              </option>
            ))}
          </select>
        </label>
        <p className="drawing-hint">
          Declares datum {selected.letter} for the drawing. Frames that name it
          break if it is renamed or deleted.
        </p>
      </>
    );
  }
  const frame = selected;
  const declared = [...datumLetters]
    .filter(([, count]) => count > 0)
    .map(([letter]) => letter)
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  const datums = frame.datums ?? [];
  const takesDatums = !DRAWING_FORM_CHARACTERISTICS.includes(
    frame.characteristic
  );
  const datumModifiers = DRAWING_DATUM_MATERIAL_CHARACTERISTICS.includes(
    frame.characteristic
  );
  const update = (
    next: Extract<DrawingAnnotation, { kind: 'feature-control-frame' }>,
    label: string
  ) => props.onUpdate(next, label);
  const withDatums = (
    list: { letter: string; material?: DrawingMaterialCondition }[]
  ) => {
    const { datums: _previous, ...rest } = frame;
    return list.length ? { ...rest, datums: list } : rest;
  };
  const chooseCharacteristic = (
    characteristic: DrawingGeometricCharacteristic
  ) => {
    const { diameterZone, material, datums: previous, ...rest } = frame;
    const keepModifiers =
      DRAWING_DATUM_MATERIAL_CHARACTERISTICS.includes(characteristic);
    const nextDatums = DRAWING_FORM_CHARACTERISTICS.includes(characteristic)
      ? []
      : (previous ?? []).map((reference) =>
          keepModifiers ? reference : { letter: reference.letter }
        );
    // Orientation, runout, concentricity and symmetry need a datum: the
    // first declared one, until another is chosen.
    if (
      nextDatums.length === 0 &&
      DRAWING_DATUM_REQUIRED_CHARACTERISTICS.includes(characteristic) &&
      declared[0]
    )
      nextDatums.push({ letter: declared[0] });
    update(
      {
        ...rest,
        characteristic,
        ...(diameterZone &&
        DRAWING_DIAMETER_ZONE_CHARACTERISTICS.includes(characteristic)
          ? { diameterZone }
          : {}),
        ...(material &&
        DRAWING_MATERIAL_CHARACTERISTICS.includes(characteristic)
          ? { material }
          : {}),
        ...(nextDatums.length ? { datums: nextDatums } : {})
      },
      'Change frame characteristic'
    );
  };
  return (
    <>
      <label className="drawing-field">
        <span>Characteristic</span>
        <select
          value={frame.characteristic}
          disabled={!editable}
          onChange={(event) =>
            chooseCharacteristic(
              event.target.value as DrawingGeometricCharacteristic
            )
          }
        >
          {DRAWING_GEOMETRIC_CHARACTERISTICS.map((characteristic) => (
            <option
              key={characteristic}
              value={characteristic}
              disabled={
                declared.length === 0 &&
                DRAWING_DATUM_REQUIRED_CHARACTERISTICS.includes(characteristic)
              }
            >
              {CHARACTERISTIC_LABELS[characteristic]}
              {characteristic === 'concentricity' ||
              characteristic === 'symmetry'
                ? ' (ISO 1101)'
                : ''}
            </option>
          ))}
        </select>
      </label>
      <FrameAmountField
        value={frame.amount}
        units={props.numberFormat.units}
        disabled={!editable}
        onCommit={(amount) =>
          update({ ...frame, amount }, 'Change frame tolerance')
        }
      />
      <label className="drawing-check">
        <input
          type="checkbox"
          checked={frame.diameterZone === true}
          disabled={
            !editable ||
            !DRAWING_DIAMETER_ZONE_CHARACTERISTICS.includes(
              frame.characteristic
            )
          }
          onChange={(event) => {
            const { diameterZone: _previous, ...rest } = frame;
            update(
              event.target.checked ? { ...rest, diameterZone: true } : rest,
              'Change frame zone'
            );
          }}
        />
        Cylindrical zone (Ø)
      </label>
      <label className="drawing-field">
        <span>Material condition</span>
        <select
          value={frame.material ?? ''}
          disabled={
            !editable ||
            !DRAWING_MATERIAL_CHARACTERISTICS.includes(frame.characteristic)
          }
          onChange={(event) => {
            const { material: _previous, ...rest } = frame;
            const value = event.target.value as DrawingMaterialCondition | '';
            update(
              value ? { ...rest, material: value } : rest,
              'Change frame modifier'
            );
          }}
        >
          <option value="">Regardless of size</option>
          <option value="mmc">{MATERIAL_LABELS.mmc}</option>
          <option value="lmc">{MATERIAL_LABELS.lmc}</option>
        </select>
      </label>
      {takesDatums ? (
        <fieldset className="drawing-bodies">
          <legend>Datums</legend>
          {Array.from({ length: MAX_DRAWING_DATUM_REFERENCES }, (_, index) => {
            const reference = datums[index];
            // A later datum waits for the earlier ones.
            const reachable = index <= datums.length;
            const others = datums
              .filter((_, other) => other !== index)
              .map((entry) => entry.letter);
            // Clearing the primary clears every datum, which a
            // characteristic that needs one cannot take.
            const required = DRAWING_DATUM_REQUIRED_CHARACTERISTICS.includes(
              frame.characteristic
            );
            return (
              <div key={index} className="drawing-field-row">
                <label className="drawing-field">
                  <span>{DATUM_PRECEDENCE[index]}</span>
                  <select
                    value={reference?.letter ?? ''}
                    disabled={!editable || !reachable}
                    onChange={(event) => {
                      const letter = event.target.value;
                      const next = letter
                        ? datums.length > index
                          ? datums.map((entry, at) =>
                              at === index ? { ...entry, letter } : entry
                            )
                          : [...datums, { letter }]
                        : datums.slice(0, index);
                      update(withDatums(next), 'Change frame datums');
                    }}
                  >
                    <option value="" disabled={index === 0 && required}>
                      None
                    </option>
                    {reference && !declared.includes(reference.letter) ? (
                      <option value={reference.letter}>
                        {reference.letter} (undeclared)
                      </option>
                    ) : null}
                    {declared
                      .filter((letter) => !others.includes(letter))
                      .map((letter) => (
                        <option key={letter} value={letter}>
                          {letter}
                        </option>
                      ))}
                  </select>
                </label>
                {datumModifiers ? (
                  <label className="drawing-field">
                    <span>Modifier</span>
                    <select
                      value={reference?.material ?? ''}
                      disabled={!editable || !reference}
                      onChange={(event) => {
                        const value = event.target.value as
                          DrawingMaterialCondition | '';
                        update(
                          withDatums(
                            datums.map((entry, at) =>
                              at === index
                                ? value
                                  ? { letter: entry.letter, material: value }
                                  : { letter: entry.letter }
                                : entry
                            )
                          ),
                          'Change frame datums'
                        );
                      }}
                    >
                      <option value="">RMB</option>
                      <option value="mmc">MMB (M)</option>
                      <option value="lmc">LMB (L)</option>
                    </select>
                  </label>
                ) : null}
              </div>
            );
          })}
          {declared.length === 0 ? (
            <p className="drawing-hint">
              Place a datum feature symbol (Q) to declare a datum.
            </p>
          ) : null}
        </fieldset>
      ) : (
        <p className="drawing-hint">
          A form tolerance controls the feature alone and names no datum.
        </p>
      )}
    </>
  );
}

/** D07 (v98): a frame's tolerance, positive, in the sheet's printed units. */
function FrameAmountField(props: {
  value: number;
  units: UnitSystem;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(props.value));
  useEffect(() => setDraft(String(props.value)), [props.value]);
  const commit = () => {
    const value = Number(draft);
    if (
      draft.trim() !== '' &&
      Number.isFinite(value) &&
      value > 0 &&
      value <= MAX_DRAWING_TOLERANCE &&
      Number(value.toFixed(MAX_DRAWING_DIMENSION_DECIMALS)) === value &&
      value !== props.value
    )
      props.onCommit(value);
    setDraft(String(props.value));
  };
  return (
    <label className="drawing-field">
      <span>Tolerance ({props.units === 'inch' ? 'in' : props.units})</span>
      <input
        type="number"
        step="any"
        min={0}
        value={draft}
        disabled={props.disabled}
        aria-label="Frame tolerance"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') setDraft(String(props.value));
        }}
      />
    </label>
  );
}

/**
 * D06 format flags: a count on radial and chamfer dimensions, Ø on a linear
 * span across a cylinder, and reference dimensions in brackets.
 */
function DimensionFormat(props: {
  selected: DrawingDimension;
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
      {selected.kind === 'distance' &&
        [selected.from, selected.to].some((target) => 'circle' in target) && (
          <label className="drawing-field">
            <span>Measure circles to</span>
            <select
              value={selected.extent ?? ''}
              disabled={!editable}
              onChange={(event) => {
                const { extent: _previous, ...rest } = selected;
                const extent = event.target.value;
                props.onUpdate(
                  extent === 'min' || extent === 'max'
                    ? { ...rest, extent }
                    : rest,
                  'Format dimension'
                );
              }}
            >
              <option value="">Centres</option>
              <option value="min">Near sides (minimum)</option>
              <option value="max">Far sides (maximum)</option>
            </select>
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
          onChange={(event) => {
            // A reference dimension is stated for information and takes no
            // tolerance (v68): marking one drops it.
            const marked = flag('reference', event.target.checked);
            if (
              event.target.checked &&
              ('tolerance' in marked || 'fit' in marked)
            ) {
              // v105: nor a fit, which is a tolerance.
              const {
                tolerance: _dropped,
                fit: _fit,
                ...rest
              } = marked as unknown as Record<string, unknown>;
              props.onUpdate(
                rest as unknown as DrawingAnnotation,
                'Format dimension'
              );
            } else props.onUpdate(marked, 'Format dimension');
          }}
        />
        <span>Reference dimension (in brackets)</span>
      </label>
      <TextField
        label="Prefix"
        value={selected.prefix ?? ''}
        placeholder="None"
        maxLength={MAX_DRAWING_DIMENSION_AFFIX_LENGTH}
        printed
        disabled={!editable}
        onCommit={(text) =>
          props.onUpdate(affixed(selected, 'prefix', text), 'Format dimension')
        }
      />
      <TextField
        label="Suffix"
        value={selected.suffix ?? ''}
        placeholder="None"
        maxLength={MAX_DRAWING_DIMENSION_AFFIX_LENGTH}
        printed
        disabled={!editable}
        onCommit={(text) =>
          props.onUpdate(affixed(selected, 'suffix', text), 'Format dimension')
        }
      />
      {selected.kind === 'diameter' &&
        'edge' in selected &&
        !selected.counterbore &&
        !selected.countersink && (
          <FitFields
            selected={selected}
            editable={editable}
            onUpdate={props.onUpdate}
          />
        )}
      <ToleranceFields
        selected={selected}
        editable={editable}
        onUpdate={props.onUpdate}
      />
    </>
  );
}

/**
 * D07 (v105): a diameter's ISO 286 fit class, which is its tolerance, and a
 * tapped hole's thread class on its callout. A fit replaces any tolerance
 * and the callout, so choosing one drops them.
 */
function FitFields(props: {
  selected: DrawingRadialDimension;
  editable: boolean;
  onUpdate: (annotation: DrawingAnnotation, label?: string) => void;
}) {
  const { selected, editable } = props;
  return (
    <>
      <label className="drawing-field">
        <span>Fit (ISO 286)</span>
        <select
          value={selected.fit ?? ''}
          disabled={!editable || selected.reference === true}
          onChange={(event) => {
            const {
              fit: _fit,
              tolerance: _tolerance,
              threadClass: _thread,
              ...rest
            } = selected;
            const fit = event.target.value;
            props.onUpdate(
              fit
                ? { ...rest, fit }
                : {
                    ...rest,
                    ...(selected.threadClass
                      ? { threadClass: selected.threadClass }
                      : {})
                  },
              'Fit diameter'
            );
          }}
        >
          <option value="">None</option>
          <optgroup label="Hole">
            {FIT_LETTERS.hole.flatMap((letter) =>
              FIT_GRADES.map((grade) => (
                <option key={letter + grade} value={`${letter}${grade}`}>
                  {letter}
                  {grade}
                </option>
              ))
            )}
          </optgroup>
          <optgroup label="Shaft">
            {FIT_LETTERS.shaft.flatMap((letter) =>
              FIT_GRADES.map((grade) => (
                <option key={letter + grade} value={`${letter}${grade}`}>
                  {letter}
                  {grade}
                </option>
              ))
            )}
          </optgroup>
        </select>
      </label>
      <label className="drawing-field">
        <span>Thread class</span>
        <select
          value={selected.threadClass ?? ''}
          disabled={!editable || selected.fit !== undefined}
          onChange={(event) => {
            const {
              threadClass: _previous,
              tolerance: _tolerance,
              ...rest
            } = selected;
            const value = event.target.value as DrawingThreadClass | '';
            props.onUpdate(
              value ? { ...rest, threadClass: value } : rest,
              'Class thread'
            );
          }}
        >
          <option value="">None</option>
          <optgroup label="ISO 965 (metric)">
            {DRAWING_THREAD_CLASSES.filter((c) => !c.endsWith('B')).map(
              (threadClass) => (
                <option key={threadClass} value={threadClass}>
                  {threadClass}
                </option>
              )
            )}
          </optgroup>
          <optgroup label="UN (inch)">
            {DRAWING_THREAD_CLASSES.filter((c) => c.endsWith('B')).map(
              (threadClass) => (
                <option key={threadClass} value={threadClass}>
                  {threadClass}
                </option>
              )
            )}
          </optgroup>
        </select>
      </label>
    </>
  );
}

/**
 * D07 (v105): a general-tolerance block's scheme: an ISO 2768-1 class (and
 * ISO 2768-2 class), or ± per number of decimals written and on angles.
 */
function GeneralToleranceFields(props: {
  selected: Extract<DrawingAnnotation, { kind: 'general-tolerance' }>;
  editable: boolean;
  numberFormat: DrawingNumberFormat;
  onUpdate: (annotation: DrawingAnnotation, label?: string) => void;
}) {
  const { selected, editable } = props;
  const base = {
    annotationId: selected.annotationId,
    kind: 'general-tolerance' as const,
    placementMm: selected.placementMm
  };
  const update = (next: DrawingAnnotation) =>
    props.onUpdate(next, 'Format general tolerances');
  const inch = props.numberFormat.units === 'inch';
  return (
    <>
      <label className="drawing-field">
        <span>Scheme</span>
        <select
          value={selected.scheme}
          disabled={!editable}
          onChange={(event) =>
            update(
              event.target.value === 'decimal'
                ? {
                    ...base,
                    scheme: 'decimal',
                    // The usual stated block, in the sheet's units.
                    places: inch
                      ? [
                          { decimals: 2, amount: 0.01 },
                          { decimals: 3, amount: 0.005 }
                        ]
                      : [
                          { decimals: 1, amount: 0.1 },
                          { decimals: 2, amount: 0.05 }
                        ],
                    angle: 0.5
                  }
                : { ...base, scheme: 'iso-2768', linearClass: 'm' }
            )
          }
        >
          <option value="iso-2768">ISO 2768</option>
          <option value="decimal">By decimal places</option>
        </select>
      </label>
      {selected.scheme === 'iso-2768' ? (
        <>
          <label className="drawing-field">
            <span>Linear and angular class</span>
            <select
              value={selected.linearClass}
              disabled={!editable}
              onChange={(event) =>
                update({
                  ...selected,
                  linearClass: event.target.value as DrawingIsoLinearClass
                })
              }
            >
              <option value="f">f (fine)</option>
              <option value="m">m (medium)</option>
              <option value="c">c (coarse)</option>
              <option value="v">v (very coarse)</option>
            </select>
          </label>
          <label className="drawing-field">
            <span>Geometric class (ISO 2768-2)</span>
            <select
              value={selected.geometricClass ?? ''}
              disabled={!editable}
              onChange={(event) => {
                const { geometricClass: _previous, ...rest } = selected;
                const value = event.target.value as
                  DrawingIsoGeometricClass | '';
                update(value ? { ...rest, geometricClass: value } : rest);
              }}
            >
              <option value="">None</option>
              {DRAWING_ISO_GEOMETRIC_CLASSES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : (
        <>
          {[1, 2, 3, 4].map((decimals) => {
            const place = selected.places.find(
              (entry) => entry.decimals === decimals
            );
            const others = selected.places.filter(
              (entry) => entry.decimals !== decimals
            );
            return (
              <OptionalAmountField
                key={decimals}
                label={`X.${'X'.repeat(decimals)} ±`}
                value={place?.amount}
                // The last stated place cannot be cleared.
                required={others.length === 0}
                disabled={!editable}
                onCommit={(amount) =>
                  update({
                    ...selected,
                    places: [
                      ...others,
                      ...(amount === undefined ? [] : [{ decimals, amount }])
                    ].sort((a, b) => a.decimals - b.decimals)
                  })
                }
              />
            );
          })}
          <OptionalAmountField
            label="Angles ± (°)"
            value={selected.angle}
            required={false}
            max={89}
            disabled={!editable}
            onCommit={(angle) => {
              const { angle: _previous, ...rest } = selected;
              update(angle === undefined ? rest : { ...rest, angle });
            }}
          />
        </>
      )}
    </>
  );
}

/** D07 (v105): a positive amount, or blank for none unless `required`. */
function OptionalAmountField(props: {
  label: string;
  value: number | undefined;
  required: boolean;
  max?: number;
  disabled: boolean;
  onCommit: (value: number | undefined) => void;
}) {
  const shown = props.value === undefined ? '' : String(props.value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commit = () => {
    const text = draft.trim();
    if (text === '') {
      if (!props.required && props.value !== undefined)
        props.onCommit(undefined);
      setDraft(shown);
      return;
    }
    const value = Number(text);
    if (
      Number.isFinite(value) &&
      value > 0 &&
      value <= (props.max ?? MAX_DRAWING_TOLERANCE) &&
      Number(value.toFixed(MAX_DRAWING_DIMENSION_DECIMALS)) === value &&
      value !== props.value
    )
      props.onCommit(value);
    setDraft(shown);
  };
  return (
    <label className="drawing-field">
      <span>{props.label}</span>
      <input
        type="number"
        step="any"
        min={0}
        value={draft}
        placeholder="None"
        disabled={props.disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') setDraft(shown);
        }}
      />
    </label>
  );
}

/** v68: `selected` with its prefix or suffix set, or cleared when blank. */
function affixed(
  selected: DrawingDimension,
  key: 'prefix' | 'suffix',
  text: string
): DrawingAnnotation {
  const { [key]: _previous, ...rest } = selected;
  const trimmed = text.trim();
  return trimmed ? { ...rest, [key]: trimmed } : rest;
}

const TOLERANCE_LABELS: Readonly<Record<DrawingToleranceKind, string>> = {
  symmetric: 'Symmetric (±)',
  deviation: 'Deviation (+/−)',
  limits: 'Limits',
  basic: 'Basic (framed)'
};

/**
 * v68: a dimension's tolerance. Amounts are deviations from the measured
 * value in the sheet's printed units (degrees on an angle), so Limits print the
 * value plus each and follow the model through every Update.
 */
function ToleranceFields(props: {
  selected: DrawingDimension;
  editable: boolean;
  onUpdate: (annotation: DrawingAnnotation, label?: string) => void;
}) {
  const { selected, editable } = props;
  const callout =
    selected.kind === 'chamfer' ||
    ('counterbore' in selected && selected.counterbore !== undefined) ||
    ('countersink' in selected && selected.countersink !== undefined);
  if (callout) return null;
  const tolerance = selected.tolerance;
  const set = (next: DrawingTolerance | null) => {
    // v105: a toleranced diameter states its diameter, not a hole's
    // callout, so a thread class goes with the callout.
    const { tolerance: _previous, ...kept } = selected;
    const rest =
      next && 'threadClass' in kept
        ? (({ threadClass: _thread, ...other }) => other)(kept)
        : kept;
    if (next && drawingToleranceError(next)) return;
    props.onUpdate(
      next ? { ...rest, tolerance: next } : rest,
      'Tolerance dimension'
    );
  };
  if (selected.reference)
    return (
      <p className="drawing-hint">A reference dimension takes no tolerance.</p>
    );
  if ('fit' in selected && selected.fit)
    return (
      <p className="drawing-hint">
        The fit states this diameter&apos;s tolerance.
      </p>
    );
  return (
    <>
      <label className="drawing-field">
        <span>Tolerance</span>
        <select
          value={tolerance?.kind ?? ''}
          disabled={!editable}
          onChange={(event) => {
            const kind = event.target.value as DrawingToleranceKind | '';
            const step = 0.1;
            if (kind === '') set(null);
            else if (kind === 'basic') set({ kind });
            else if (kind === 'symmetric')
              set({
                kind,
                value:
                  tolerance && 'upper' in tolerance
                    ? Math.max(
                        Math.abs(tolerance.upper),
                        Math.abs(tolerance.lower)
                      )
                    : step
              });
            else
              set({
                kind,
                ...(tolerance && 'upper' in tolerance
                  ? { upper: tolerance.upper, lower: tolerance.lower }
                  : tolerance?.kind === 'symmetric'
                    ? { upper: tolerance.value, lower: -tolerance.value }
                    : { upper: step, lower: -step })
              });
          }}
        >
          <option value="">None</option>
          {(Object.keys(TOLERANCE_LABELS) as DrawingToleranceKind[]).map(
            (kind) => (
              <option key={kind} value={kind}>
                {TOLERANCE_LABELS[kind]}
              </option>
            )
          )}
        </select>
      </label>
      {tolerance?.kind === 'symmetric' && (
        <AmountField
          label="±"
          value={tolerance.value}
          disabled={!editable}
          onCommit={(value) => set({ kind: 'symmetric', value })}
        />
      )}
      {(tolerance?.kind === 'deviation' || tolerance?.kind === 'limits') && (
        <div className="drawing-field-row">
          <AmountField
            label="Upper"
            value={tolerance.upper}
            disabled={!editable}
            onCommit={(upper) => set({ ...tolerance, upper })}
          />
          <AmountField
            label="Lower"
            value={tolerance.lower}
            disabled={!editable}
            onCommit={(lower) => set({ ...tolerance, lower })}
          />
        </div>
      )}
      {tolerance &&
        tolerance.kind !== 'basic' &&
        drawingToleranceError(tolerance) === null && (
          <p className="drawing-hint">
            {tolerance.kind === 'symmetric'
              ? 'Plus or minus this amount.'
              : tolerance.kind === 'deviation'
                ? 'Signed deviations from the measured value, upper over lower.'
                : 'The measured value plus each deviation, upper over lower.'}
          </p>
        )}
    </>
  );
}

/**
 * A tolerance amount as typed: kept as text until committed, so "-0.05"
 * survives its intermediate "-" and "-0.0"; a value the tolerance refuses
 * (an upper below its lower, a non-positive ±) reverts.
 */
function AmountField(props: {
  label: string;
  value: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(props.value));
  useEffect(() => setDraft(String(props.value)), [props.value]);
  const commit = () => {
    const value = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(value) && value !== props.value)
      props.onCommit(value);
    // Accepted, the new value replaces this on its way back; refused, the
    // stored one does.
    setDraft(String(props.value));
  };
  return (
    <label className="drawing-field">
      <span>{props.label}</span>
      <input
        type="number"
        step="any"
        value={draft}
        disabled={props.disabled}
        aria-label={`Tolerance ${props.label === '±' ? 'amount' : props.label.toLowerCase()}`}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') setDraft(String(props.value));
        }}
      />
    </label>
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
  /** D03 (v78): the detail view tool. */
  detail: {
    active: boolean;
    usable: boolean;
    disabledReason: string;
    onToggle: () => void;
  };
  /** D03 (v81): the auxiliary view tool. */
  auxiliary: {
    active: boolean;
    usable: boolean;
    disabledReason: string;
    onToggle: () => void;
  };
}) {
  const { tool, section, detail, auxiliary } = props;
  const groups: AnnotationToolKind[][] = [
    ['horizontal', 'vertical', 'aligned', 'distance'],
    ['radius', 'diameter', 'chamfer'],
    ['angle', 'arc-angle', 'three-point-angle'],
    ['center-mark', 'intersection-mark', 'centerline', 'circle-centerline'],
    ['note', 'balloon', 'parts-list', 'image'],
    // The general-tolerance block is placed from Sheet Properties (and W):
    // a phone-width rail has no row to spare.
    ['datum-feature', 'feature-control-frame']
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
              kind === 'note' ||
              kind === 'balloon' ||
              kind === 'parts-list' ||
              kind === 'image' ||
              kind === 'general-tolerance' ||
              isToleranceTool(kind) ||
              isGeometryTool(kind)
                ? ANNOTATION_TOOL_LABELS[kind]
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
        <button
          type="button"
          className={`drawing-rail-button${detail.active ? ' active' : ''}`}
          aria-label="Detail view"
          aria-pressed={detail.active}
          aria-keyshortcuts={DETAIL_TOOL_KEY}
          disabled={!detail.usable}
          title={
            detail.usable
              ? `Detail view: drag a circle on a view, from its centre (${DETAIL_TOOL_KEY})`
              : detail.disabledReason
          }
          onClick={detail.onToggle}
        >
          <ZoomIn size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`drawing-rail-button${auxiliary.active ? ' active' : ''}`}
          aria-label="Auxiliary view"
          aria-pressed={auxiliary.active}
          aria-keyshortcuts={AUXILIARY_TOOL_KEY}
          disabled={!auxiliary.usable}
          title={
            auxiliary.usable
              ? `Auxiliary view: pick an inclined edge, then the side to see it from (${AUXILIARY_TOOL_KEY})`
              : auxiliary.disabledReason
          }
          onClick={auxiliary.onToggle}
        >
          <SquareArrowOutUpRight size={16} aria-hidden="true" />
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

/** D02 (v94): the fields only the shop title block prints. */
const SHOP_TITLE_FIELDS: { key: keyof DrawingTitleBlock; label: string }[] = [
  { key: 'material', label: 'Material' },
  { key: 'finish', label: 'Finish' },
  { key: 'checkedBy', label: 'Checked by' },
  { key: 'approvedBy', label: 'Approved by' },
  { key: 'company', label: 'Company' },
  { key: 'tolerances', label: 'General tolerances' }
];

const NO_SHEETS: readonly DrawingSheet[] = [];

/**
 * v80: which BOM columns a parts list shows, in the table's order; at least
 * one stays on.
 */
function BomColumnFields(props: {
  selected: Extract<DrawingAnnotation, { kind: 'bom-table' }>;
  editable: boolean;
  onUpdate: (annotation: DrawingAnnotation, label?: string) => void;
}) {
  const shown = props.selected.columns ?? DEFAULT_BOM_COLUMNS;
  return (
    <fieldset className="drawing-bodies">
      <legend>Columns</legend>
      {ASSEMBLY_BOM_COLUMNS.map((column) => (
        <label key={column.key} className="drawing-check">
          <input
            type="checkbox"
            checked={shown.includes(column.key)}
            disabled={
              !props.editable || (shown.length === 1 && shown[0] === column.key)
            }
            onChange={(event) => {
              const next = ASSEMBLY_BOM_COLUMNS.map(
                (entry) => entry.key
              ).filter((key) =>
                key === column.key ? event.target.checked : shown.includes(key)
              );
              const { columns: _previous, ...rest } = props.selected;
              const same =
                next.length === DEFAULT_BOM_COLUMNS.length &&
                next.every((key, index) => key === DEFAULT_BOM_COLUMNS[index]);
              props.onUpdate(
                same ? rest : { ...rest, columns: next },
                'Format parts list'
              );
            }}
          />
          {column.label}
        </label>
      ))}
    </fieldset>
  );
}

const UNIT_NAMES: Readonly<Record<ProjectDocument['units'], string>> = {
  mm: 'Millimetres',
  cm: 'Centimetres',
  m: 'Metres',
  inch: 'Inches'
};

/**
 * D02 (schema v70): the sheet's drawing properties — the units, precision,
 * angle format and decimal separator its dimensions print in, and its print
 * weights. Each change replaces the whole format; a field set back to its
 * default is left out, so a sheet with every default stores none.
 */
function SheetFormatFields(props: {
  format: DrawingSheetFormat | undefined;
  documentUnits: ProjectDocument['units'];
  editable: boolean;
  onChange: (format: DrawingSheetFormat | null) => void;
}) {
  const format = props.format ?? {};
  const units = format.units ?? props.documentUnits;
  const set = <K extends keyof DrawingSheetFormat>(
    key: K,
    value: DrawingSheetFormat[K] | undefined
  ) => {
    const { [key]: _previous, ...rest } = format;
    const next: DrawingSheetFormat =
      value === undefined ? rest : { ...rest, [key]: value };
    props.onChange(Object.keys(next).length > 0 ? next : null);
  };
  const weights = format.lineWidthsMm ?? {};
  const setWeight = (kind: DrawingLineClass, width: number | undefined) => {
    const { [kind]: _previous, ...rest } = weights;
    const next = width === undefined ? rest : { ...rest, [kind]: width };
    set('lineWidthsMm', Object.keys(next).length > 0 ? next : undefined);
  };
  const decimalsOptions = Array.from(
    { length: MAX_DRAWING_DIMENSION_DECIMALS + 1 },
    (_, decimals) => (
      <option key={decimals} value={decimals}>
        {decimals}
      </option>
    )
  );
  return (
    <div className="drawing-panel-section">
      <h3>Drawing properties</h3>
      <label className="drawing-field">
        <span>Dimension units</span>
        <select
          value={format.units ?? ''}
          disabled={!props.editable}
          onChange={(event) =>
            set(
              'units',
              (event.target.value || undefined) as
                ProjectDocument['units'] | undefined
            )
          }
        >
          <option value="">Document ({UNIT_NAMES[props.documentUnits]})</option>
          {(Object.keys(UNIT_NAMES) as ProjectDocument['units'][]).map(
            (key) => (
              <option key={key} value={key}>
                {UNIT_NAMES[key]}
              </option>
            )
          )}
        </select>
      </label>
      <div className="drawing-field-row">
        <label className="drawing-field">
          <span>Length decimals</span>
          <select
            value={format.decimals ?? ''}
            disabled={!props.editable}
            onChange={(event) =>
              set(
                'decimals',
                event.target.value === ''
                  ? undefined
                  : Number(event.target.value)
              )
            }
          >
            <option value="">
              Default ({defaultDimensionDecimals('linear', units)})
            </option>
            {decimalsOptions}
          </select>
        </label>
        <label className="drawing-field">
          <span>Decimal separator</span>
          <select
            value={format.decimalSeparator ?? ''}
            disabled={!props.editable}
            onChange={(event) =>
              set(
                'decimalSeparator',
                event.target.value === 'comma' ? 'comma' : undefined
              )
            }
          >
            <option value="">Point (12.5)</option>
            <option value="comma">Comma (12,5)</option>
          </select>
        </label>
      </div>
      <div className="drawing-field-row">
        <label className="drawing-field">
          <span>Angles</span>
          <select
            value={format.angleFormat ?? 'decimal'}
            disabled={!props.editable}
            onChange={(event) =>
              set(
                'angleFormat',
                event.target.value === 'dms' ? 'dms' : undefined
              )
            }
          >
            <option value="decimal">Decimal degrees</option>
            <option value="dms">Degrees, minutes, seconds</option>
          </select>
        </label>
        <label className="drawing-field">
          <span>Angle decimals</span>
          <select
            value={format.angleDecimals ?? ''}
            disabled={!props.editable}
            onChange={(event) =>
              set(
                'angleDecimals',
                event.target.value === ''
                  ? undefined
                  : Number(event.target.value)
              )
            }
          >
            <option value="">
              Default ({defaultDimensionDecimals('angle', units)})
            </option>
            {decimalsOptions}
          </select>
        </label>
      </div>
      <details className="drawing-line-weights">
        <summary>Line weights (mm)</summary>
        {DRAWING_LINE_CLASSES.map((kind) => (
          <WeightField
            key={kind}
            label={DRAWING_LINE_CLASS_LABELS[kind]}
            value={weights[kind]}
            fallback={SHEET_STROKE_WIDTH_MM[kind]}
            disabled={!props.editable}
            onCommit={(width) => setWeight(kind, width)}
          />
        ))}
      </details>
    </div>
  );
}

/**
 * One line class's print weight: blank is the ISO 128 default; a weight
 * outside the bounds reverts.
 */
function WeightField(props: {
  label: string;
  value: number | undefined;
  fallback: number;
  disabled: boolean;
  onCommit: (width: number | undefined) => void;
}) {
  const shown = props.value === undefined ? '' : String(props.value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commit = () => {
    const text = draft.trim();
    const width = Number(text);
    if (text === '') {
      if (props.value !== undefined) props.onCommit(undefined);
    } else if (
      Number.isFinite(width) &&
      width >= MIN_DRAWING_LINE_WIDTH_MM &&
      width <= MAX_DRAWING_LINE_WIDTH_MM &&
      width !== props.value
    )
      props.onCommit(width);
    setDraft(shown);
  };
  return (
    <label className="drawing-field">
      <span>{props.label}</span>
      <input
        type="number"
        min={MIN_DRAWING_LINE_WIDTH_MM}
        max={MAX_DRAWING_LINE_WIDTH_MM}
        step={0.05}
        value={draft}
        placeholder={String(props.fallback)}
        disabled={props.disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') setDraft(shown);
        }}
      />
    </label>
  );
}

export function DrawingWorkspace(props: DrawingWorkspaceProps) {
  const { document, bodies, editDisabledReason } = props;
  // A released edit's draft display (`BodyRepresentation.displayQuality`) is
  // geometry still on its way: its box and mesh are refined a moment later,
  // and a sheet's fingerprint and layout must never read them.
  const geometryPending = props.geometryPending || hasDraftDisplay(bodies);
  const sheets = document.drawings?.sheets ?? NO_SHEETS;
  const [selectedSheetId, setSelectedSheetId] = useState<DrawingSheetId | null>(
    () => retainedFor(document.projectId).selectedSheetId ?? null
  );
  // Resolve first entry after geometry is ready too: a project restored in
  // Draw initially has no visible bodies until its rebuild completes.
  const initialSheet = useMemo(() => {
    const visible = new Set(props.defaultBodyIds);
    const matching =
      !geometryPending && visible.size > 0
        ? sheets.filter((entry) => {
            const ids = sheetBodyIds(entry);
            return (
              ids.length === visible.size && ids.every((id) => visible.has(id))
            );
          })
        : [];
    return (matching.length === 1 ? matching[0] : sheets[0]) ?? null;
  }, [sheets, props.defaultBodyIds, geometryPending]);
  const sheet =
    sheets.find((entry) => entry.sheetId === selectedSheetId) ?? initialSheet;
  // Draw unmounts in Build. Keep the chosen sheet with its projections so
  // returning does not silently open a different body's sheet and draw it.
  useEffect(() => {
    if (geometryPending || !sheet) return;
    retainedFor(document.projectId).selectedSheetId = sheet.sheetId;
    if (selectedSheetId !== sheet.sheetId) setSelectedSheetId(sheet.sheetId);
  }, [document.projectId, geometryPending, selectedSheetId, sheet]);
  const { onActiveSheetChange } = props;
  const shownSheetId = sheet?.sheetId ?? null;
  useEffect(() => {
    if (!onActiveSheetChange) return;
    onActiveSheetChange(shownSheetId);
    return () => onActiveSheetChange(null);
  }, [onActiveSheetChange, shownSheetId]);
  const [selectedViewId, setSelectedViewId] = useState<DrawingViewId | null>(
    null
  );
  const selectedView =
    sheet?.views.find((view) => view.viewId === selectedViewId) ?? null;
  // "New view" offers the first orientation the sheet does not show yet
  // (review I65); a pick holds until the sheet's views change.
  const addKey = sheet
    ? `${sheet.sheetId}|${sheet.views.map((view) => view.viewId).join(',')}`
    : '';
  const [addChoice, setAddChoice] = useState<{
    key: string;
    orientation: DrawingViewOrientation;
  } | null>(null);
  const addOrientation: DrawingViewOrientation =
    addChoice?.key === addKey
      ? addChoice.orientation
      : sheet
        ? nextViewOrientation(sheet)
        : 'front';
  const setAddOrientation = (orientation: DrawingViewOrientation) =>
    setAddChoice({ key: addKey, orientation });
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
  /**
   * D03 (v78) detail tool: a circle dragged on a view (`drag`, from its
   * centre), then the detail follows the pointer until a click places it.
   */
  const [detailTool, setDetailTool] = useState<{
    drag: { start: [number, number]; current: [number, number] } | null;
    region: {
      sourceViewId: DrawingViewId;
      center: { u: number; v: number };
      radius: number;
    } | null;
    pointer: [number, number] | null;
  } | null>(null);
  /**
   * D03 (v81) auxiliary tool: the inclined edge picked, then the view
   * follows the pointer, seen from its side of the edge, until a click.
   */
  const [auxiliaryTool, setAuxiliaryTool] = useState<{
    edge: PickableEdge | null;
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
  const wheelClassifier = useRef<WheelGestureClassifier | null>(null);
  const wheelRef = useRef<(event: WheelEvent) => void>(() => undefined);
  wheelRef.current = (event: WheelEvent) => {
    const current = zoomRef.current;
    if (!current || !zoomPaper) return;
    const delta = wheelPixels(event);
    // The wheel means what it means in Build (review I66): a notch, Ctrl/
    // Cmd+wheel and a pinch zoom about the pointer, and a trackpad swipe
    // pans, by the same classifier and the same remembered device. Shift
    // keeps a notch scrolling sideways across a zoomed sheet.
    wheelClassifier.current ??= new WheelGestureClassifier({
      device: readWheelDeviceMemory()
    });
    const { intent, learned } = wheelClassifier.current.classify(
      {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey
      },
      props.pointerNavigation ?? 'auto',
      event.timeStamp
    );
    if (learned) writeWheelDeviceMemory(learned);
    if (
      event.ctrlKey ||
      event.metaKey ||
      (intent === 'zoom' && !event.shiftKey)
    ) {
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
    // A swipe pans a zoomed sheet; a fitted one has nowhere to go.
    event.preventDefault();
    if (current.zoom <= 1) return;
    const rect = canvasRect();
    if (!rect) return;
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
  const [propertiesOpen, setPropertiesOpen] = useState(false);
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
        if (geometryPending) return [entry.sheetId, null];
        // F06: a sheet whose every view draws another row reads nothing of
        // the active build, so it stays as current as it was made. Otherwise
        // the fingerprint covers the sheet's bodies as it was made, leaving
        // out only a body that just views on other rows draw and that the
        // active build does not have; moving a view to a row with its body
        // still built leaves the fingerprint as it was.
        const rows = viewConfigurationRows(entry, document);
        if (rows.size > 0 && rows.size === entry.views.length)
          return [entry.sheetId, entry.source.fingerprint];
        const activeIds = new Set(sheetBodyIds(activeRowSheet(entry, rows)));
        const ids = sheetBodyIds(entry).filter(
          (id) => activeIds.has(id) || (!!bodies[id] && !bodies[id].consumed)
        );
        const key = [...ids].sort().join(',');
        if (!byBodySet.has(key))
          byBodySet.set(key, drawingSourceFingerprint(bodies, ids));
        return [entry.sheetId, byBodySet.get(key)!];
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheets, bodies, geometryPending, document.configurations]);
  // F06: each sheet as projection keys read it, every view carrying the
  // configuration row it draws (a derived view, its source's).
  const configurationKey = useMemo(
    () =>
      sheets.some((entry) => entry.views.some((view) => view.configurationId))
        ? rowContentKey(document)
        : '',
    // The model content, not the document: a drawing edit keeps both.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sheets, document.nodes, document.configurations]
  );
  const keySheets = useMemo(
    () =>
      new Map(
        sheets.map((entry) => [
          entry.sheetId,
          projectionSheet(
            entry,
            viewConfigurationRows(entry, document),
            configurationKey
          )
        ])
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sheets, document.configurations, configurationKey]
  );
  /** A view as its projection key reads it (`projectionSheet`). */
  const keyView = useCallback(
    (sheetId: DrawingSheetId, view: DrawingView): DrawingView => {
      const keyed = keySheets
        .get(sheetId)
        ?.views.find((entry) => entry.viewId === view.viewId);
      const { configurationId: _own, ...rest } = view;
      return keyed?.configurationId
        ? { ...rest, configurationId: keyed.configurationId }
        : rest;
    },
    [keySheets]
  );
  const wanted = useMemo(() => {
    const keys = new Set<string>();
    for (const entry of sheets) {
      const fingerprint = fingerprints.get(entry.sheetId);
      if (fingerprint)
        for (const view of entry.views)
          keys.add(projectionKey(fingerprint, keyView(entry.sheetId, view)));
    }
    return keys;
  }, [sheets, fingerprints, keyView]);
  const status = useMemo(
    () =>
      sheet
        ? sheetStatus(
            document,
            // F06: a body only another row builds is not missing.
            activeRowSheet(sheet, viewConfigurationRows(sheet, document)),
            bodies,
            geometryPending,
            fingerprints.get(sheet.sheetId) ?? null
          )
        : null,
    [document, sheet, bodies, geometryPending, fingerprints]
  );
  const liveProjections = useViewProjections(
    sheet
      ? {
          ...sheet,
          views: sheet.views.map((view) => keyView(sheet.sheetId, view))
        }
      : null,
    wanted,
    status,
    document,
    props.requestTessellation,
    props.requestSection
  );
  const keptDrawings = keptDrawingsFor(document.projectId);
  // M01: a hole's callout data, read from the document by its feature id,
  // for a diameter on its bore to call it out (standard, thread). Bound to
  // this document, so a drawing kept with it keeps reading it.
  // D02 v80: the assembly's BOM table, which parts lists and balloons read.
  const bomTable = useMemo(() => sheetBom(document), [document]);
  // D02 v92: the project's pictures, which sheet images show.
  const pictures = useMemo(() => sheetPictures(document), [document]);
  // D07 v98: datum letters across every sheet, which frames may name.
  const datumLetters = useMemo(
    () => drawingDatumLetters(document.drawings?.sheets ?? []),
    [document.drawings]
  );
  const liveHoleCallouts = useMemo(
    () => holeCalloutLookup(document),
    [document]
  );
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
      const projection = keptDrawing.projections.get(
        viewIntentKey(keyView(sheet.sheetId, view))
      );
      if (projection) states.set(view.viewId, { state: 'ready', projection });
    }
    return states;
  }, [keptDrawing, sheet, liveProjections, keyView]);
  /** The bodies the drawing on screen measures: the kept model's, if kept. */
  const modelBodies = keptDrawing?.bodies ?? bodies;
  /** Its holes' callouts, likewise: the kept document's, if kept. */
  const holeCallouts = keptDrawing?.holes ?? liveHoleCallouts;
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
      projections.set(
        viewIntentKey(keyView(shownSheet.sheetId, view)),
        projection
      );
    keptDrawings.set(
      shownSheet.sheetId,
      [
        {
          fingerprint: status.fingerprint,
          bodies,
          projections,
          holes: liveHoleCallouts
        },
        ...previous.filter((entry) => entry.fingerprint !== status.fingerprint)
      ].slice(0, KEPT_DRAWINGS_PER_SHEET)
    );
  }, [
    shownSheet,
    status,
    drawnViews,
    bodies,
    keptDrawings,
    liveHoleCallouts,
    keyView
  ]);
  // While the model rebuilds the sheet shows its last drawing faded instead
  // of empty outlines; it is only ever seen, never picked from, annotated or
  // exported, since the rebuild may not leave the model it was drawn from.
  const ghostViews: ComposedView[] = useMemo(() => {
    if (!shownSheet || status?.kind !== 'pending') return [];
    const last = keptDrawings.get(shownSheet.sheetId)?.[0]?.projections;
    if (!last) return [];
    return shownSheet.views.flatMap((view) => {
      const projection = last.get(
        viewIntentKey(keyView(shownSheet.sheetId, view))
      );
      return projection ? [{ view, projection }] : [];
    });
  }, [shownSheet, status, keptDrawings, keyView]);
  // Every annotation against the model the sheet draws: the current one, or
  // the kept one of a sheet not yet updated. Only a drawn sheet draws or
  // reports them. A leader whose edge its view no longer draws at all is
  // broken too.
  const resolutions = useMemo(
    () =>
      shownSheet
        ? // v98: a frame whose leader is hidden leaves what hangs from it
          // with nowhere to be drawn.
          markBrokenHosts(
            shownSheet,
            markHiddenLeaders(
              shownSheet,
              resolveSheetAnnotations(
                shownSheet,
                drawBodies,
                document.units,
                holeCallouts,
                bomTable,
                pictures,
                datumLetters
              ),
              drawnViews,
              document.units,
              drawBodies
            )
          )
        : new Map<DrawingAnnotationId, AnnotationResolution>(),
    [
      shownSheet,
      drawBodies,
      document.units,
      drawnViews,
      holeCallouts,
      bomTable,
      pictures,
      datumLetters
    ]
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
    !geometryPending;
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
        })),
      // D06 slice E: the assistant's auto-dimension request runs the same
      // generator as the button, on the sheet's own annotations.
      ...(assistantReady
        ? {
            autoDimension: () =>
              planAutoDimensions(sheet, drawnViews, drawBodies, document.units)
          }
        : {})
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
  // Section references and note leaders cannot be judged until their views
  // finish drawing. A proposal preview must never delete saved annotations.
  const canDeleteBroken =
    editable &&
    sheetReady &&
    !geometryPending &&
    drawnViews.length === sheet?.views.length &&
    props.previewAnnotations?.sheetId !== sheet?.sheetId;
  // Dimensions measure a view's geometry; a note on the paper needs none,
  // so a ready sheet with no views still takes one.
  const canAnnotate = sheetReady && editable && (sheet?.views.length ?? 0) > 0;
  const hasParts = (bomTable?.rows.length ?? 0) > 0;
  const hasPictures = pictures.size > 0;
  const canUseTool = (kind: AnnotationToolKind) =>
    kind === 'image'
      ? sheetReady && editable && hasPictures
      : kind === 'parts-list'
        ? sheetReady && editable && hasParts
        : kind === 'balloon'
          ? canAnnotate && hasParts
          : kind === 'note' || kind === 'general-tolerance'
            ? sheetReady && editable
            : canAnnotate;
  const toolDisabledReason = (kind: AnnotationToolKind) =>
    !editable
      ? (editDisabledReason ?? 'Drawing edits are unavailable.')
      : !sheetReady
        ? 'Update the sheet to annotate it.'
        : kind === 'image' && !hasPictures
          ? 'Add a picture to the project (Insert image in Build) to place it on the sheet.'
          : (kind === 'parts-list' || kind === 'balloon') && !hasParts
            ? 'Add parts to the assembly (Assemble) to list or balloon them.'
            : kind === 'note' || kind === 'parts-list'
              ? 'Notes are unavailable.'
              : 'Add a view to dimension it.';
  const chooseTool = (next: AnnotationTool | null) => {
    setTool(next && pinnedTool(next));
    setSectionTool(null);
    setDetailTool(null);
    setAuxiliaryTool(null);
    setHover(null);
    if (next) {
      setPropertiesOpen(false);
      props.onStatus(
        `${ANNOTATION_TOOL_LABELS[next.kind]} placement started.`,
        { immediate: true }
      );
    } else if (tool || sectionTool || detailTool || auxiliaryTool) {
      props.onStatus('Placement canceled.', { immediate: true });
    }
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
      if (sectionTool || detailTool || auxiliaryTool) chooseTool(null);
      else if (shownAutoPlan) setAutoPlan(null);
      else if (tool) {
        chooseTool(null);
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
    if (event.key.toLowerCase() === DETAIL_TOOL_KEY.toLowerCase()) {
      event.preventDefault();
      event.stopPropagation();
      toggleDetailTool();
      return;
    }
    if (event.key.toLowerCase() === AUXILIARY_TOOL_KEY.toLowerCase()) {
      event.preventDefault();
      event.stopPropagation();
      toggleAuxiliaryTool();
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
    if (!fingerprint || geometryPending) {
      props.onStatus(
        'Wait for the model to finish updating, then make the drawing.'
      );
      return;
    }
    const paper = defaultDrawingPaper(document.units);
    let created: DrawingSheet;
    try {
      created = createStarterSheet({
        name: nextSheetName(sheets),
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

  /** Says what a delete removed, offering Undo where the host can. */
  const announceUndoable = (message: string) =>
    props.onAnnounceUndoable
      ? props.onAnnounceUndoable(message)
      : props.onStatus(message);

  const renameSheet = (sheetId: DrawingSheetId, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    run(
      commandFactories.updateDrawingSheet(
        { sheetId, name: trimmed },
        `Rename drawing to ${trimmed}`
      )
    );
  };

  /**
   * The commands that put the sheets in `next` order, or null (with a
   * status) when a sheet that has to be taken out and put back draws a
   * body no longer in the model: adding it back would be refused.
   */
  const sheetOrderCommands = (next: readonly DrawingSheet[]) => {
    const { remove, add } = sheetOrderSteps(sheets, next);
    const known = new Set(document.bodyOrder);
    const orphaned = add.find((entry) =>
      entry.views.some((view) => view.bodyIds.some((id) => !known.has(id)))
    );
    if (orphaned) {
      props.onStatus(
        `${orphaned.name} draws a body that is no longer in the model. Update or delete it, then move the sheets.`
      );
      return null;
    }
    return [
      ...remove.map((id) =>
        commandFactories.deleteDrawingSheet({ sheetId: id })
      ),
      ...add.map((entry) => commandFactories.addDrawingSheet({ sheet: entry }))
    ];
  };

  const duplicateSheet = (sheetId: DrawingSheetId) => {
    const original = sheets.find((entry) => entry.sheetId === sheetId);
    if (!original) return;
    const copy = duplicateDrawingSheet(original, sheets);
    // Beside its original, not at the end of the strip: one undo step.
    const at = sheets.findIndex((entry) => entry.sheetId === sheetId) + 1;
    const commands = sheetOrderCommands([
      ...sheets.slice(0, at),
      copy,
      ...sheets.slice(at)
    ]);
    if (!commands) return;
    if (!run(composeCommands(`Duplicate ${original.name}`, commands))) return;
    selectSheet(copy.sheetId);
    props.onStatus(`Duplicated ${original.name} as ${copy.name}.`);
  };

  const moveSheet = (sheetId: DrawingSheetId, index: number) => {
    const next = movedSheets(sheets, sheetId, index);
    if (!next) return;
    const commands = sheetOrderCommands(next);
    if (!commands) return;
    const moved = next.findIndex((entry) => entry.sheetId === sheetId);
    if (run(composeCommands('Move sheet', commands)))
      props.onStatus(
        `Moved ${next[moved]!.name} to position ${moved + 1} of ${next.length}.`
      );
  };

  const deleteSheet = (sheetId: DrawingSheetId) => {
    const target = sheets.find((entry) => entry.sheetId === sheetId);
    if (!target) return;
    const message = deletedSheetSummary(target);
    if (!run(commandFactories.deleteDrawingSheet({ sheetId }))) return;
    if (selectedSheetId === sheetId) setSelectedSheetId(null);
    announceUndoable(message);
  };

  const deleteView = (viewId: DrawingViewId) => {
    if (!sheet) return;
    const message = deletedViewSummary(sheet, viewId, viewLabel);
    if (
      !run(
        commandFactories.deleteDrawingView({ sheetId: sheet.sheetId, viewId })
      )
    )
      return;
    if (selectedViewId === viewId) setSelectedViewId(null);
    announceUndoable(message);
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
    const viewBodies = bodyIds.filter((id) => liveBodies.includes(id));
    // A projected view goes beside its base, on the side the projection
    // angle gives it, clear of the base by a gap; anything else goes in the
    // free space nearest the middle of the sheet, clear of the other views.
    let centerMm: { x: number; y: number };
    if (!base) {
      const extent = estimateViewExtent(bodies, viewBodies, addOrientation);
      const k = drawingPaperPerModelUnit(sheet.scale, document.units);
      centerMm = freeViewCenter(sheet, viewExtents, document.units, {
        width: extent ? (extent.maxU - extent.minU) * k : 0,
        height: extent ? (extent.maxV - extent.minV) * k : 0
      });
    } else {
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

  const exportSheet = async (format: 'pdf' | 'svg' | 'dxf') => {
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
      {
        projectName: document.name,
        units: document.units,
        sheetNumber,
        date: autoDate
      },
      composeSheetAnnotations(sheet, drawn, resolutions, document.units)
    );
    const fileName = drawingExportFileName(document.name, sheet.name, format);
    try {
      // D02 (v92): the pictures the page shows, read from the project's
      // store for this export only. DXF leaves them out (R12 has no
      // embedded image), and says so.
      const pictureCount = pagePictures(page.images).size;
      const pdfPictures =
        format === 'pdf'
          ? await loadPagePictures(
              page.images,
              props.loadReferenceImage,
              pictureJpegBytes
            )
          : null;
      const svgPictures =
        format === 'svg'
          ? await loadPagePictures(
              page.images,
              props.loadReferenceImage,
              pictureDataUrl
            )
          : null;
      if (
        pictureCount > 0 &&
        ((format === 'pdf' && !pdfPictures) ||
          (format === 'svg' && !svgPictures))
      )
        throw new SheetPictureUnavailableError();
      const saved =
        format === 'pdf'
          ? await saveCadBinaryFile(
              fileName,
              'pdf',
              sheetPageToPdf(
                page,
                sheet.name,
                pdfPictures ?? undefined
              ) as Uint8Array<ArrayBuffer>
            )
          : await saveCadTextFile(
              fileName,
              format,
              format === 'dxf'
                ? sheetPageToDxf(page)
                : sheetPageToSvg(page, sheet.name, svgPictures ?? undefined)
            );
      props.onStatus(
        saved
          ? `Exported the drawing to ${fileName}${
              format === 'dxf' && pictureCount > 0
                ? ' (its pictures are left out: DXF R12 cannot embed them)'
                : ''
            }.`
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
      deleteView(selectedView.viewId);
    }
  };

  // "2 / 3" in the title block's SHEET cell: where this sheet sits in the
  // set, in tab order (review I63).
  const sheetPosition = sheet
    ? sheets.findIndex((entry) => entry.sheetId === sheet.sheetId) + 1
    : 0;
  // The DATE cell's automatic value until the title block sets one.
  const autoDate = useMemo(
    () => titleBlockAutoDate(document.revisions),
    [document.revisions]
  );
  const sheetNumber = useMemo(
    () => ({ index: Math.max(1, sheetPosition), count: sheets.length }),
    [sheetPosition, sheets.length]
  );

  const composed = useMemo(() => {
    if (!shownSheet) return null;
    if (drawnViews.length === 0 && ghostViews.length > 0)
      return {
        page: composeSheetPage(shownSheet, ghostViews, {
          projectName: document.name,
          units: document.units,
          sheetNumber,
          date: autoDate
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
        {
          projectName: document.name,
          units: document.units,
          sheetNumber,
          date: autoDate
        },
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
    document.units,
    sheetNumber,
    autoDate
  ]);
  const page: SheetPage | null = composed?.page ?? null;
  // D02 (v92): object URLs for the pictures the page shows, loaded from the
  // project's store once each and released with the workspace.
  const [pictureUrls, setPictureUrls] = useState<ReadonlyMap<string, string>>(
    () => new Map()
  );
  const pictureUrlsRef = useRef(new Map<string, string>());
  const pictureKey = [...pagePictures(page?.images).keys()].sort().join(',');
  const loadPicture = props.loadReferenceImage;
  // A picture not on this device yet (still downloading, offline) is asked
  // for again a little later, so its placeholder does not stay for good.
  const [pictureRetry, setPictureRetry] = useState(0);
  useEffect(() => {
    if (!loadPicture || !pictureKey) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const wanted = pictureKey
      .split(',')
      .filter((checksum) => !pictureUrlsRef.current.has(checksum));
    void (async () => {
      let missing = false;
      for (const checksum of wanted) {
        const blob = await loadPicture(checksum).catch(() => null);
        if (cancelled) return;
        if (!blob) {
          missing = true;
          continue;
        }
        if (pictureUrlsRef.current.has(checksum)) continue;
        pictureUrlsRef.current.set(checksum, URL.createObjectURL(blob));
        setPictureUrls(new Map(pictureUrlsRef.current));
      }
      if (missing && !cancelled)
        retry = setTimeout(
          () => setPictureRetry((count) => count + 1),
          PICTURE_RETRY_MS
        );
    })();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [pictureKey, loadPicture, pictureRetry]);
  useEffect(
    () => () => {
      for (const url of pictureUrlsRef.current.values())
        URL.revokeObjectURL(url);
      pictureUrlsRef.current.clear();
    },
    []
  );
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
          : estimateViewExtent(
              bodies,
              view.bodyIds,
              view.orientation,
              view.auxiliary || view.section?.frame
                ? drawingViewFrame(view)
                : undefined
            );
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

  /**
   * The view moves that lay `target` out again, by "Fit views to sheet" or
   * "Auto scale", and the scale they need; null when nothing fits. `target`
   * may carry an edit not yet run, such as a new paper.
   */
  const fittedLayout = (target: DrawingSheet, autoScale: boolean) => {
    const fitted = (autoScale ? autoScaleSheet : fitViewsToSheet)(
      target,
      viewExtents,
      document.units
    );
    if (!fitted) return null;
    const scaled =
      formatDrawingScale(fitted.scale) !== formatDrawingScale(target.scale);
    // Bases first: moving one carries its projected views, which are then
    // set to their own fitted centres.
    const depth = (view: DrawingView): number => {
      // A section follows its source as a projected view its base.
      const baseOf = (entry: DrawingView | undefined) =>
        entry?.parentViewId ?? entry?.section?.sourceViewId;
      let count = 0;
      let parent = baseOf(view);
      while (parent && count < target.views.length) {
        count += 1;
        parent = baseOf(target.views.find((entry) => entry.viewId === parent));
      }
      return count;
    };
    const byId = new Map(target.views.map((view) => [view.viewId, view]));
    const moves = [...fitted.centers]
      .sort((a, b) => depth(byId.get(a.viewId)!) - depth(byId.get(b.viewId)!))
      .map(({ viewId, centerMm }) =>
        commandFactories.updateDrawingView({
          sheetId: target.sheetId,
          viewId,
          centerMm
        })
      );
    return { scale: fitted.scale, scaled, moves };
  };

  const fitViews = (autoScale = false) => {
    if (!sheet) return;
    const label = autoScale ? 'Auto scale' : 'Fit views to sheet';
    const layout = fittedLayout(sheet, autoScale);
    if (!layout) {
      props.onStatus(
        sheet.views.length === 0
          ? `Add a view to ${autoScale ? 'scale it' : 'fit it'} to the sheet.`
          : 'These views do not fit this paper at any scale. Pick a larger paper.'
      );
      return;
    }
    const { scale, scaled, moves } = layout;
    const commands = [
      ...(scaled
        ? [
            commandFactories.updateDrawingSheet({
              sheetId: sheet.sheetId,
              scale
            })
          ]
        : []),
      ...moves
    ];
    if (run(composeCommands(label, commands)))
      props.onStatus(
        autoScale
          ? scaled
            ? `Scaled the views to ${formatDrawingScale(scale)}, the largest scale that fits the sheet.`
            : `${formatDrawingScale(scale)} is already the largest scale that fits the sheet.`
          : scaled
            ? `Fitted the views to the sheet at ${formatDrawingScale(scale)}.`
            : 'Fitted the views to the sheet.'
      );
  };

  /**
   * A new paper size or orientation, with the views laid out again on it in
   * the same undo step: the old centres sit wherever the old paper put them,
   * so a smaller sheet left views off the page and export refused (review
   * I64). The fit keeps the views' arrangement and scale, and lowers the
   * scale only when they do not fit.
   */
  const changePaper = (paper: DrawingSheet['paper']) => {
    if (!sheet) return;
    const name = `${DRAWING_PAPER_LABELS[paper.size]} ${paper.orientation}`;
    const layout =
      sheet.views.length > 0 ? fittedLayout({ ...sheet, paper }, false) : null;
    const commands = [
      commandFactories.updateDrawingSheet({
        sheetId: sheet.sheetId,
        paper,
        ...(layout?.scaled ? { scale: layout.scale } : {})
      }),
      ...(layout?.moves ?? [])
    ];
    if (!run(composeCommands(`Paper ${name}`, commands))) return;
    if (sheet.views.length === 0) return;
    props.onStatus(
      !layout
        ? `Changed the paper to ${name}. These views do not fit it at any scale; pick a larger paper.`
        : layout.scaled
          ? `Changed the paper to ${name} and fitted the views at ${formatDrawingScale(layout.scale)}.`
          : `Changed the paper to ${name} and fitted the views to it.`
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
  /**
   * v98: the healthy dimension (or, for a datum symbol, frame) whose box
   * holds `point`: what a datum symbol or frame may attach to.
   */
  const toleranceHostAt = (
    point: [number, number],
    kind: AnnotationToolKind
  ): DrawingAnnotation | null => {
    if (!composed || composed.ghost || !shownSheet) return null;
    for (const annotation of shownSheet.annotations ?? []) {
      if (
        (kind !== 'datum-feature' && kind !== 'feature-control-frame') ||
        !drawingToleranceHostAllowed(kind, annotation) ||
        !resolutions.get(annotation.annotationId)?.ok
      )
        continue;
      const box = composed.boxes.get(annotation.annotationId);
      if (
        box &&
        point[0] >= box.x &&
        point[0] <= box.x + box.width &&
        point[1] >= box.y &&
        point[1] <= box.y + box.height
      )
        return annotation;
    }
    return null;
  };
  /**
   * v73: the centre or intersection mark (or, v75, the straight centreline)
   * whose box holds `point`, if any.
   */
  const markAt = (point: [number, number]) => {
    if (!composed || composed.ghost || !shownSheet) return null;
    for (const annotation of shownSheet.annotations ?? []) {
      const centerline =
        annotation.kind === 'centerline' && annotation.mode !== 'circle';
      if (
        annotation.kind !== 'center-mark' &&
        annotation.kind !== 'intersection-mark' &&
        !centerline
      )
        continue;
      if (!resolutions.get(annotation.annotationId)?.ok) continue;
      const box = composed.boxes.get(annotation.annotationId);
      if (
        box &&
        point[0] >= box.x &&
        point[0] <= box.x + box.width &&
        point[1] >= box.y &&
        point[1] <= box.y + box.height
      )
        return {
          annotationId: annotation.annotationId,
          viewId: annotation.viewId,
          ...(centerline ? { centerline: true } : {})
        };
    }
    return null;
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

  /**
   * v98: a new datum symbol takes the drawing's next free letter, and a new
   * frame about a tenth of a millimetre in the sheet's printed units.
   */
  const toleranceDefaults = () => ({
    letter: nextDatumLetter(datumLetters.keys()),
    amount:
      DEFAULT_FRAME_AMOUNT[sheetNumberFormat(sheet ?? {}, document.units).units]
  });
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
    // v80: a balloon names the assembly component its edge belongs to.
    let componentId: string | undefined;
    if (finished.kind === 'balloon') {
      componentId = balloonComponent(bomTable, finished.edges[0]?.bodyId);
      if (!componentId) {
        props.onStatus('That body is not a part of the assembly.');
        setTool(startAnnotationTool(finished.kind));
        return;
      }
    }
    // v92: an image shows the project's newest picture until another is
    // chosen in Properties.
    const placed =
      finished.kind === 'image' && !finished.pictureId
        ? { ...finished, pictureId: [...pictures.keys()].at(-1) }
        : finished;
    const annotation = draftAnnotation(
      placed,
      createDrawingAnnotationId(),
      placementMm,
      undefined,
      componentId,
      toleranceDefaults()
    );
    if (!annotation) return;
    const refusal = draftRefusal(
      annotation,
      view,
      drawBodies,
      document.units,
      sheetMarkLookup(sheet),
      bomTable
    );
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
      if (
        finished.kind === 'note' ||
        finished.kind === 'image' ||
        finished.kind === 'feature-control-frame' ||
        finished.kind === 'general-tolerance'
      )
        setPropertiesOpen(true);
      props.onStatus(
        finished.kind === 'note'
          ? 'Note added. Edit its text in Properties.'
          : finished.kind === 'image'
            ? 'Image added. Choose its picture and width in Properties.'
            : finished.kind === 'general-tolerance'
              ? 'General tolerances added (ISO 2768-m). Choose the class or a stated block in Properties.'
              : finished.kind === 'feature-control-frame'
                ? 'Feature control frame added. Choose its characteristic, tolerance and datums in Properties.'
                : finished.kind === 'datum-feature'
                  ? `Datum ${annotation.kind === 'datum-feature' ? annotation.letter : ''} added.`
                  : isGeometryTool(finished.kind) ||
                      finished.kind === 'balloon' ||
                      finished.kind === 'parts-list'
                    ? `${ANNOTATION_TOOL_LABELS[finished.kind]} added.`
                    : `${ANNOTATION_TOOL_LABELS[finished.kind]} dimension added.`,
        { immediate: true }
      );
      // A note is placed and then typed; dimensions keep their tool for the
      // next one.
      setTool(
        finished.kind === 'note' ||
          finished.kind === 'parts-list' ||
          finished.kind === 'image' ||
          finished.kind === 'feature-control-frame' ||
          finished.kind === 'general-tolerance'
          ? null
          : startAnnotationTool(finished.kind)
      );
    }
  };
  const commitRepair = (finished: AnnotationTool) => {
    const previous = sheet?.annotations?.find(
      (entry) => entry.annotationId === finished.repairId
    );
    setTool(null);
    if (!sheet || !previous) return;
    // v80: a balloon re-picked onto another part names that part.
    const componentId =
      previous.kind === 'balloon'
        ? balloonComponent(bomTable, finished.edges[0]?.bodyId)
        : undefined;
    if (previous.kind === 'balloon' && !componentId) {
      props.onStatus('That body is not a part of the assembly.');
      return;
    }
    const repaired = repairedAnnotation(previous, finished, componentId);
    if (!repaired) {
      props.onStatus('Re-pick in the view this annotation belongs to.');
      return;
    }
    const view = sheet.views.find((entry) => entry.viewId === repaired.viewId);
    const refusal = draftRefusal(
      repaired,
      view,
      drawBodies,
      document.units,
      sheetMarkLookup(sheet),
      bomTable
    );
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
    // v98: a datum symbol or frame attaches to a size dimension (a datum
    // symbol also to a frame) clicked before any edge is picked.
    if (
      isToleranceTool(tool.kind) &&
      tool.edges.length === 0 &&
      tool.hostId === undefined
    ) {
      const host = toleranceHostAt(at.point, tool.kind);
      if (host) {
        const next: AnnotationTool = {
          ...tool,
          hostId: host.annotationId,
          viewId: host.viewId
        };
        if (next.repairId) {
          if (tool.viewId && tool.viewId !== host.viewId) {
            props.onStatus('Re-pick in the view this annotation belongs to.');
            return;
          }
          commitRepair(next);
          return;
        }
        setTool(pinnedTool(next));
        setHover({ edge: null, face: null, point: at.point });
        props.onStatus(
          `${ANNOTATION_TOOL_LABELS[tool.kind]}: click where it goes.`
        );
        return;
      }
    }
    const hit = edgeAt(at.point, at.pxPerMm);
    const result = applyAnnotationPick(
      tool,
      hit,
      at.point,
      viewAt(at.point),
      drawBodies,
      faceAt(at.point, at.pxPerMm),
      markAt(at.point)
    );
    if (!result.ok) {
      props.onStatus(result.message);
      return;
    }
    if (result.tool.repairId && pickedEnough(result.tool)) {
      commitRepair(result.tool);
      return;
    }
    // A note on empty paper, and a mark or centreline, has nowhere further
    // to be placed: it is made as soon as its picks are in.
    if (
      result.tool.placed ||
      (isGeometryTool(result.tool.kind) && pickedEnough(result.tool))
    ) {
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
  // D03 (v81) auxiliary tool.
  const canAuxiliary = canSection;
  const auxiliaryDisabledReason = sectionDisabledReason.replace(
    'a section',
    'an auxiliary view'
  );
  function toggleAuxiliaryTool() {
    if (auxiliaryTool) {
      chooseTool(null);
      return;
    }
    if (!canAuxiliary) {
      props.onStatus(auxiliaryDisabledReason);
      return;
    }
    setTool(null);
    setSectionTool(null);
    setDetailTool(null);
    setHover(null);
    setPropertiesOpen(false);
    setAuxiliaryTool({ edge: null, pointer: null });
    props.onStatus('Auxiliary view placement started.', { immediate: true });
    canvasRef.current?.focus();
  }
  /** The auxiliary view the tool would place now, as a preview. */
  const auxiliaryPreview =
    auxiliaryTool?.edge && auxiliaryTool.pointer && shownSheet
      ? auxiliaryDraft(shownSheet, auxiliaryTool.edge, auxiliaryTool.pointer)
      : null;
  const onAuxiliaryPointerDown = (event: ReactPointerEvent<SVGRectElement>) => {
    if (event.button !== 0 || !auxiliaryTool || !shownSheet) return;
    const at = paperPoint(event);
    if (!at) return;
    if (auxiliaryTool.edge) {
      const draft = auxiliaryDraft(shownSheet, auxiliaryTool.edge, at.point);
      setAuxiliaryTool(null);
      if (!draft) return;
      const view: DrawingView = { ...draft, viewId: createDrawingViewId() };
      if (
        run(
          commandFactories.addDrawingView({ sheetId: shownSheet.sheetId, view })
        )
      )
        setSelectedViewId(view.viewId);
      return;
    }
    const hit = edgeAt(at.point, at.pxPerMm);
    if (!hit) {
      props.onStatus('Pick an inclined straight edge of a view.');
      return;
    }
    const refusal = auxiliaryEdgeRefusal(hit);
    if (refusal) {
      props.onStatus(refusal);
      return;
    }
    setAuxiliaryTool({ edge: hit, pointer: at.point });
  };
  const onAuxiliaryPointerMove = (event: ReactPointerEvent<SVGRectElement>) => {
    if (!auxiliaryTool?.edge) return;
    const at = paperPoint(event);
    if (at) setAuxiliaryTool({ ...auxiliaryTool, pointer: at.point });
  };

  // D03 (v78) detail tool.
  const canDetail =
    sheetReady &&
    editable &&
    drawnViews.some(({ view }) => !view.section && !view.detail);
  const detailDisabledReason = !editable
    ? (editDisabledReason ?? 'Drawing edits are unavailable.')
    : !sheetReady
      ? 'Update the sheet to add a detail.'
      : 'Add a view to take a detail from.';
  function toggleDetailTool() {
    if (detailTool) {
      chooseTool(null);
      return;
    }
    if (!canDetail) {
      props.onStatus(detailDisabledReason);
      return;
    }
    setTool(null);
    setSectionTool(null);
    setAuxiliaryTool(null);
    setHover(null);
    setPropertiesOpen(false);
    setDetailTool({ drag: null, region: null, pointer: null });
    props.onStatus('Detail view placement started.', { immediate: true });
    canvasRef.current?.focus();
  }
  const detailSourceView = (viewId: DrawingViewId | undefined) =>
    viewId
      ? shownSheet?.views.find((entry) => entry.viewId === viewId)
      : undefined;
  /** The detail view the tool would place now, as a preview. */
  const detailPreview =
    detailTool?.region && detailTool.pointer && shownSheet
      ? (() => {
          const source = detailSourceView(detailTool.region.sourceViewId);
          return source
            ? detailDraft(
                shownSheet,
                source,
                detailTool.region,
                detailTool.pointer
              )
            : null;
        })()
      : null;
  const onDetailPointerDown = (event: ReactPointerEvent<SVGRectElement>) => {
    if (event.button !== 0 || !detailTool || !shownSheet) return;
    const at = paperPoint(event);
    if (!at) return;
    if (detailTool.region) {
      const source = detailSourceView(detailTool.region.sourceViewId);
      if (!source) return;
      const view: DrawingView = {
        ...detailDraft(shownSheet, source, detailTool.region, at.point),
        viewId: createDrawingViewId()
      };
      setDetailTool(null);
      if (
        run(
          commandFactories.addDrawingView({ sheetId: shownSheet.sheetId, view })
        )
      )
        setSelectedViewId(view.viewId);
      return;
    }
    if (!detailSourceAt(shownSheet, drawnViews, at.point, document.units)) {
      props.onStatus('Start the detail circle inside a view, at its centre.');
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDetailTool({
      drag: { start: at.point, current: at.point },
      region: null,
      pointer: null
    });
  };
  const onDetailPointerMove = (event: ReactPointerEvent<SVGRectElement>) => {
    if (!detailTool) return;
    const at = paperPoint(event);
    if (!at) return;
    if (detailTool.drag)
      setDetailTool({
        ...detailTool,
        drag: { ...detailTool.drag, current: at.point }
      });
    else if (detailTool.region)
      setDetailTool({ ...detailTool, pointer: at.point });
  };
  const onDetailPointerUp = (event: ReactPointerEvent<SVGRectElement>) => {
    if (!detailTool?.drag || !shownSheet) return;
    const at = paperPoint(event);
    const end = at?.point ?? detailTool.drag.current;
    const source = detailSourceAt(
      shownSheet,
      drawnViews,
      detailTool.drag.start,
      document.units
    );
    const region =
      source &&
      detailRegionFromDrag(
        shownSheet,
        source,
        detailTool.drag.start,
        end,
        document.units
      );
    if (!source || !region) {
      setDetailTool({ drag: null, region: null, pointer: null });
      props.onStatus(
        'Drag out from the centre of the region to its edge to circle it.'
      );
      return;
    }
    setDetailTool({
      drag: null,
      region: { sourceViewId: source.view.viewId, ...region },
      pointer: end
    });
  };
  function toggleSectionTool() {
    if (sectionTool) {
      chooseTool(null);
      return;
    }
    if (!canSection) {
      props.onStatus(sectionDisabledReason);
      return;
    }
    setTool(null);
    setDetailTool(null);
    setAuxiliaryTool(null);
    setHover(null);
    setPropertiesOpen(false);
    setSectionTool({ drag: null, line: null, pointer: null });
    props.onStatus('Section view placement started.', { immediate: true });
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
    // A free section (v91) is placed where the pointer is.
    if (!shownSheet || line.axis === 'free') return 0;
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
        sectionSnapTargets(source, drawBodies, axis),
        3,
        sectionSnapPoints(source, drawBodies)
      );
    if (!line) {
      setSectionTool({ drag: null, line: null, pointer: null });
      props.onStatus('Drag across the view to draw the section line.');
      return;
    }
    if (
      line.axis !== 'free' &&
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
  const deleteBrokenAnnotations = () => {
    if (!sheet || !canDeleteBroken) return;
    const broken = (sheet.annotations ?? []).filter(
      (annotation) => resolutions.get(annotation.annotationId)?.ok === false
    );
    if (broken.length === 0) return;
    if (
      run(
        composeCommands(
          'Delete broken annotations',
          broken.map((annotation) =>
            commandFactories.deleteDrawingAnnotation({
              sheetId: sheet.sheetId,
              annotationId: annotation.annotationId
            })
          )
        )
      )
    ) {
      if (broken.some((entry) => entry.annotationId === selectedAnnotationId))
        setSelectedAnnotationId(null);
      props.onStatus(
        `Deleted ${broken.length} broken ${broken.length === 1 ? 'annotation' : 'annotations'}. Undo to restore.`
      );
    }
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
            disabled={!editable || geometryPending}
            title={
              editDisabledReason ??
              (geometryPending
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
          document.units,
          holeCallouts
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
    // The same defaults the placement commits, so the preview shows it.
    const draft = draftAnnotation(
      tool,
      'dann_preview' as DrawingAnnotationId,
      placementMm,
      undefined,
      undefined,
      toleranceDefaults()
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
        : 'Drawing up to date';
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
      className={`drawing-workspace${darkPaper ? ' is-dark-paper' : ''}${propertiesOpen ? ' is-properties-open' : ''}`}
      aria-label="Drawings"
    >
      <div className="drawing-stage">
        <div className="drawing-stage-bar">
          <DrawingSheetTabs
            sheets={sheets}
            activeId={sheet.sheetId}
            onSelect={selectSheet}
            onCreate={createSheet}
            onRename={renameSheet}
            onDuplicate={duplicateSheet}
            onMove={moveSheet}
            onDelete={deleteSheet}
            editDisabledReason={editable ? null : editDisabledReason}
            createDisabled={!editable || geometryPending}
            createTitle={
              editDisabledReason ??
              (geometryPending
                ? 'Waiting for the model to finish updating.'
                : 'New sheet with the four standard views')
            }
          />
          <div className="drawing-stage-actions">
            <button
              type="button"
              className="secondary drawing-properties-toggle"
              aria-expanded={propertiesOpen}
              aria-controls="drawing-properties"
              onClick={() => {
                if (!propertiesOpen && (tool || sectionTool)) {
                  chooseTool(null);
                  props.onStatus(
                    'Placement canceled. Drawing properties opened.',
                    { immediate: true }
                  );
                } else {
                  props.onStatus(
                    propertiesOpen
                      ? 'Drawing properties closed.'
                      : 'Drawing properties opened.',
                    { immediate: true }
                  );
                }
                setPropertiesOpen((open) => !open);
              }}
            >
              {propertiesOpen ? 'Hide properties' : 'Properties'}
            </button>
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
                title="Zoom out (scroll wheel or pinch on the sheet)"
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
                title="Zoom in (scroll wheel or pinch on the sheet)"
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
              <button
                type="button"
                className="secondary"
                aria-label="Export DXF"
                disabled={exportReason !== null}
                title={
                  exportReason ??
                  (outdated
                    ? 'Export this sheet as DXF, as drawn before the latest model change'
                    : 'Export this sheet as DXF (R12, paper millimetres, a layer per line kind)')
                }
                onClick={() => void exportSheet('dxf')}
              >
                DXF
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
            {brokenCount > 0 && (
              <button
                type="button"
                className="secondary"
                disabled={!canDeleteBroken}
                title={
                  editDisabledReason ??
                  'Delete all broken dimensions and notes on this sheet. Undo restores them together.'
                }
                onClick={deleteBrokenAnnotations}
              >
                <Trash2 size={13} aria-hidden="true" /> Delete all broken
              </button>
            )}
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
            {/* D02 (v92): sheet images, beneath the lines. */}
            {(page.images ?? []).map((image, index) => {
              const href = pictureUrls.get(image.checksumSha256);
              const y = paper.height - image.y - image.height;
              return href ? (
                <image
                  key={index}
                  className="drawing-sheet-image"
                  href={href}
                  x={image.x}
                  y={y}
                  width={image.width}
                  height={image.height}
                  preserveAspectRatio="none"
                />
              ) : (
                <rect
                  key={index}
                  className="drawing-sheet-image-pending"
                  x={image.x}
                  y={y}
                  width={image.width}
                  height={image.height}
                />
              );
            })}
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
                    estimateViewExtent(
                      bodies,
                      view.bodyIds,
                      view.orientation,
                      view.auxiliary || view.section?.frame
                        ? drawingViewFrame(view)
                        : undefined
                    ));
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
                    y={Math.max(
                      labelSizeMm + 2,
                      paper.height - box.y - box.height - pad
                    )}
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
                      : annotation.kind === 'bom-table'
                        ? 'Empty parts list'
                        : annotation.kind === 'balloon'
                          ? 'Broken balloon'
                          : isDrawingGeometryAnnotation(annotation)
                            ? 'Broken mark'
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
                  sectionDraft.orientation,
                  sectionDraft.section?.frame
                    ? drawingViewFrame(sectionDraft)
                    : undefined
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
            {detailTool?.drag && (
              <circle
                className="drawing-section-preview"
                cx={detailTool.drag.start[0]}
                cy={paper.height - detailTool.drag.start[1]}
                r={Math.hypot(
                  detailTool.drag.current[0] - detailTool.drag.start[0],
                  detailTool.drag.current[1] - detailTool.drag.start[1]
                )}
              />
            )}
            {detailPreview?.detail &&
              (() => {
                const r =
                  detailPreview.detail.radius *
                  drawingPaperPerModelUnit(
                    detailPreview.detail.scale,
                    document.units
                  );
                return (
                  <g className="drawing-section-draft">
                    <circle
                      className="drawing-section-ghost"
                      cx={detailPreview.centerMm.x}
                      cy={paper.height - detailPreview.centerMm.y}
                      r={r}
                    />
                    <text
                      className="drawing-view-label"
                      x={detailPreview.centerMm.x - r}
                      y={paper.height - detailPreview.centerMm.y + r + 4}
                      fontSize={3}
                    >
                      {detailCaption(
                        detailPreview.detail.label,
                        detailPreview.detail.scale
                      )}
                    </text>
                  </g>
                );
              })()}
            {auxiliaryPreview?.auxiliary &&
              (() => {
                const extent = estimateViewExtent(
                  bodies,
                  auxiliaryPreview.bodyIds,
                  auxiliaryPreview.orientation,
                  drawingViewFrame(auxiliaryPreview)
                );
                const k = drawingPaperPerModelUnit(
                  shownSheet.scale,
                  document.units
                );
                const width = extent ? (extent.maxU - extent.minU) * k : 20;
                const height = extent ? (extent.maxV - extent.minV) * k : 20;
                return (
                  <g className="drawing-section-draft">
                    <rect
                      className="drawing-section-ghost"
                      x={auxiliaryPreview.centerMm.x - width / 2}
                      y={
                        paper.height - auxiliaryPreview.centerMm.y - height / 2
                      }
                      width={width}
                      height={height}
                    />
                    <text
                      className="drawing-view-label"
                      x={auxiliaryPreview.centerMm.x - width / 2}
                      y={
                        paper.height -
                        auxiliaryPreview.centerMm.y +
                        height / 2 +
                        4
                      }
                      fontSize={3}
                    >
                      {auxiliaryCaption(auxiliaryPreview.auxiliary.label)}
                    </text>
                  </g>
                );
              })()}
            {auxiliaryTool && (
              <rect
                className="drawing-section-surface"
                aria-label="Auxiliary view edge"
                width={paper.width}
                height={paper.height}
                onPointerDown={onAuxiliaryPointerDown}
                onPointerMove={onAuxiliaryPointerMove}
              />
            )}
            {detailTool && (
              <rect
                className="drawing-section-surface"
                aria-label="Detail circle"
                width={paper.width}
                height={paper.height}
                onPointerDown={onDetailPointerDown}
                onPointerMove={onDetailPointerMove}
                onPointerUp={onDetailPointerUp}
              />
            )}
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
            detail={{
              active: detailTool !== null,
              usable: canDetail,
              disabledReason: detailDisabledReason,
              onToggle: toggleDetailTool
            }}
            auxiliary={{
              active: auxiliaryTool !== null,
              usable: canAuxiliary,
              disabledReason: auxiliaryDisabledReason,
              onToggle: toggleAuxiliaryTool
            }}
          />
          {auxiliaryTool && (
            <div className="drawing-tool-hint" role="status">
              <span>
                {auxiliaryTool.edge
                  ? 'Move to the side to see the edge from, then click to place the view.'
                  : 'Pick an inclined straight edge of a front, top or side view.'}
              </span>
              <button
                type="button"
                className="drawing-tool-hint-cancel"
                onClick={() => chooseTool(null)}
              >
                Cancel
              </button>
            </div>
          )}
          {detailTool && (
            <div className="drawing-tool-hint" role="status">
              <span>
                {detailTool.region
                  ? 'Move the detail into place, then click.'
                  : 'Drag a circle on a view, out from its centre.'}
              </span>
              <button
                type="button"
                className="drawing-tool-hint-cancel"
                onClick={() => chooseTool(null)}
              >
                Cancel
              </button>
            </div>
          )}
          {sectionTool && (
            <div className="drawing-tool-hint" role="status">
              <span>
                {sectionTool.line
                  ? sectionTool.line.axis === 'free'
                    ? 'Click on a side of the line to place the section seen from there.'
                    : 'Move the section view into place along its arrows, then click.'
                  : 'Drag across a view to draw the section line; at an angle for a free section.'}
              </span>
              <button
                type="button"
                className="drawing-tool-hint-cancel"
                onClick={() => chooseTool(null)}
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
      <aside
        id="drawing-properties"
        className="drawing-panel"
        aria-label="Drawing properties"
      >
        {selection === 'annotation' && selectedAnnotation ? (
          <AnnotationProperties
            selected={selectedAnnotation}
            ready={sheetReady}
            canRepick={canAnnotate}
            editable={editable}
            numberFormat={sheetNumberFormat(sheet, document.units)}
            resolutions={resolutions}
            pictures={pictures}
            onTool={chooseTool}
            onDeselect={deselect}
            datumLetters={datumLetters}
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
                // D03 (v91): a free section's plane is inclined: its offset
                // is along its own normal, from the model origin.
                const free = section.frame !== undefined;
                const sign = free ? 1 : normal[axis];
                const drawn = projections.get(selectedView.viewId);
                const approximate =
                  drawn?.state === 'ready'
                    ? drawn.projection.sectionApproximate
                    : undefined;
                return (
                  <>
                    <NumberField
                      label={
                        free
                          ? `Plane offset (${document.units})`
                          : `Cut at ${axis.toUpperCase()} (${document.units})`
                      }
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
                    {!free && source && (
                      <SectionStepFields
                        steps={section.steps ?? []}
                        firstDepth={section.depth}
                        sign={sign}
                        axisLabel={axis.toUpperCase()}
                        units={document.units}
                        bounds={
                          projections.get(source.viewId)?.state === 'ready'
                            ? (sectionStepRange(
                                source,
                                selectedView,
                                projections.get(source.viewId)
                              ) ?? null)
                            : null
                        }
                        editable={editable}
                        onCommit={(steps) =>
                          run(
                            commandFactories.updateDrawingView(
                              {
                                sheetId: sheet.sheetId,
                                viewId: selectedView.viewId,
                                sectionSteps: steps
                              },
                              steps.length > 0
                                ? 'Edit section steps'
                                : 'Remove section steps'
                            )
                          )
                        }
                      />
                    )}
                    <p className="drawing-hint">
                      Cut from the{' '}
                      {source
                        ? DRAWING_VIEW_LABELS[source.orientation].toLowerCase()
                        : 'source'}{' '}
                      view along its line {section.label}-{section.label}
                      {free
                        ? ', at an angle: it is placed freely.'
                        : ': it stays aligned with it.'}{' '}
                      Cut faces are hatched.
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
            {selectedView.detail &&
              (() => {
                const detail = selectedView.detail;
                const source = sheet.views.find(
                  (view) => view.viewId === detail.sourceViewId
                );
                const update = (
                  patch: Partial<Pick<DrawingDetail, 'radius' | 'scale'>>,
                  label: string
                ) =>
                  run(
                    commandFactories.updateDrawingView(
                      {
                        sheetId: sheet.sheetId,
                        viewId: selectedView.viewId,
                        detail: patch
                      },
                      label
                    )
                  );
                return (
                  <>
                    <label className="drawing-field">
                      <span>Detail scale</span>
                      <select
                        value={formatDrawingScale(detail.scale)}
                        disabled={!editable}
                        onChange={(event) => {
                          const scale = DRAWING_SCALE_PRESETS.find(
                            (preset) =>
                              formatDrawingScale(preset) === event.target.value
                          );
                          if (scale)
                            update({ scale: { ...scale } }, 'Scale detail');
                        }}
                      >
                        {DRAWING_SCALE_PRESETS.map((preset) => (
                          <option
                            key={formatDrawingScale(preset)}
                            value={formatDrawingScale(preset)}
                          >
                            {formatDrawingScale(preset)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <NumberField
                      label={`Circle radius (${document.units})`}
                      value={detail.radius}
                      disabled={!editable}
                      onCommit={(value) =>
                        value > 0 && update({ radius: value }, 'Resize detail')
                      }
                    />
                    <p className="drawing-hint">
                      The part of the{' '}
                      {source ? viewLabel(source).toLowerCase() : 'source'} view
                      inside circle {detail.label}, at its own scale. It moves
                      freely; the circle stays on its source.
                    </p>
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
            {document.configurations &&
              (selectedView.parentViewId ||
              selectedView.section ||
              selectedView.detail ||
              selectedView.auxiliary ? (
                <p className="drawing-hint">
                  Draws its source view’s configuration.
                </p>
              ) : (
                <label className="drawing-field">
                  <span>Configuration</span>
                  <select
                    value={selectedView.configurationId ?? ''}
                    disabled={!editable}
                    onChange={(event) =>
                      run(
                        commandFactories.updateDrawingView({
                          sheetId: sheet.sheetId,
                          viewId: selectedView.viewId,
                          configurationId: event.target.value || null
                        })
                      )
                    }
                  >
                    <option value="">{`Active (${
                      document.configurations.rows.find(
                        (row) => row.id === document.configurations!.activeRowId
                      )?.name ?? 'none'
                    })`}</option>
                    {document.configurations.rows.map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
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
                      // A detail or auxiliary view draws its source's bodies.
                      selectedView.detail !== undefined ||
                      selectedView.auxiliary !== undefined ||
                      // Not offered for removal until the rebuild says
                      // whether it is really gone.
                      (geometryPending && !liveBodies.includes(id)) ||
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
                    : geometryPending
                      ? `${bodies[id]?.name ?? 'Body'} (updating…)`
                      : `${bodies[id]?.name ?? 'Deleted body'} (no longer in the model)`}
                </label>
              ))}
            </fieldset>
            <button
              type="button"
              className="secondary"
              disabled={!editable}
              onClick={() => deleteView(selectedView.viewId)}
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
                    changePaper({
                      ...sheet.paper,
                      size: event.target.value as DrawingPaperSize
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
                    changePaper({
                      ...sheet.paper,
                      orientation: event.target
                        .value as DrawingSheet['paper']['orientation']
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
          <SheetBodies
            key={sheet.sheetId}
            names={sheetBodyIds(sheet).map(
              (id) =>
                bodies[id]?.name ??
                Object.values(document.nodes).find(
                  (node) => node.kind === 'body' && node.bodyId === id
                )?.name ??
                'Missing body'
            )}
          />
          {sheetBodyIds(sheet).some(
            (id) => !props.defaultBodyIds.includes(id)
          ) && (
            <p className="drawing-hint">
              This sheet keeps its saved bodies when you hide or isolate in
              Build. Select a view to change its bodies.
            </p>
          )}
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
            <SheetFormatFields
              format={sheet.format}
              documentUnits={document.units}
              editable={editable}
              onChange={(format) =>
                updateSheet({ format }, 'Change drawing properties')
              }
            />
            <div className="drawing-panel-section">
              <h3>General tolerances</h3>
              <button
                type="button"
                className="secondary"
                disabled={!canUseTool('general-tolerance')}
                title="Place a block stating ISO 2768 or per-decimal general tolerances (W)"
                onClick={() =>
                  chooseTool(startAnnotationTool('general-tolerance'))
                }
              >
                <Diff size={13} aria-hidden="true" /> Add general tolerances
              </button>
            </div>
            <div className="drawing-panel-section">
              <h3>Title block</h3>
              <label className="drawing-field">
                <span>Layout</span>
                <select
                  value={sheet.titleBlockLayout ?? ''}
                  disabled={!editable}
                  onChange={(event) =>
                    updateSheet(
                      {
                        titleBlockLayout:
                          event.target.value === 'shop' ? 'shop' : null
                      },
                      'Change title-block layout'
                    )
                  }
                >
                  <option value="">Compact</option>
                  <option value="shop">Shop</option>
                </select>
              </label>
              {sheet.titleBlockLayout === 'shop' && (
                <p className="drawing-hint">
                  Adds material, finish, checked and approved, the company and a
                  general-tolerance note.
                </p>
              )}
              {[
                ...TITLE_FIELDS,
                ...(sheet.titleBlockLayout === 'shop' ? SHOP_TITLE_FIELDS : [])
              ].map(({ key, label }) => (
                <TextField
                  key={key}
                  label={label}
                  value={sheet.titleBlock[key] ?? ''}
                  placeholder={
                    key === 'title'
                      ? document.name
                      : key === 'date'
                        ? autoDate
                        : undefined
                  }
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
                onClick={() => deleteSheet(sheet.sheetId)}
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
