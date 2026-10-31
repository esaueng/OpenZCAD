import { UNIT_TO_MM } from './index';
import type { BodyId, Brand, UnitSystem, Vector3 } from './index';
import {
  drawingAnnotationError,
  MAX_DRAWING_ANNOTATIONS,
  type DrawingAnnotation
} from './drawing-annotations';

/**
 * D01 drawing sheets — the persisted, command-free half shared by the
 * document, the projection worker, the sheet preview and the PDF/SVG writers.
 *
 * A sheet is canonical user content: paper, scale, title-block text and, per
 * view, which bodies it shows from which standard direction and where its
 * centre sits on the paper. Projected lines are derived and disposable; they
 * are never stored. `source.fingerprint` fences the model a sheet was last
 * drawn from: when the source bodies change, the sheet reads as stale until
 * an explicit Update rebinds it, and nothing silently redraws or exports it.
 */

export type DrawingSheetId = Brand<string, 'DrawingSheetId'>;
export type DrawingViewId = Brand<string, 'DrawingViewId'>;

export const DRAWING_SHEET_ID_PREFIX = 'dsht_';
export const DRAWING_VIEW_ID_PREFIX = 'dvw_';

export function createDrawingSheetId(): DrawingSheetId {
  return `${DRAWING_SHEET_ID_PREFIX}${crypto.randomUUID()}` as DrawingSheetId;
}

export function createDrawingViewId(): DrawingViewId {
  return `${DRAWING_VIEW_ID_PREFIX}${crypto.randomUUID()}` as DrawingViewId;
}

/** ISO 216 A sizes and ANSI Y14.1 A–D sizes. */
export type DrawingPaperSize =
  'A4' | 'A3' | 'A2' | 'A1' | 'A0' | 'ANSI-A' | 'ANSI-B' | 'ANSI-C' | 'ANSI-D';

export type DrawingPaperOrientation = 'landscape' | 'portrait';

/** Paper boxes in millimetres, short side first (portrait). */
export const DRAWING_PAPER_SIZES_MM: Readonly<
  Record<DrawingPaperSize, { readonly width: number; readonly height: number }>
> = {
  A4: { width: 210, height: 297 },
  A3: { width: 297, height: 420 },
  A2: { width: 420, height: 594 },
  A1: { width: 594, height: 841 },
  A0: { width: 841, height: 1189 },
  'ANSI-A': { width: 215.9, height: 279.4 },
  'ANSI-B': { width: 279.4, height: 431.8 },
  'ANSI-C': { width: 431.8, height: 558.8 },
  'ANSI-D': { width: 558.8, height: 863.6 }
};

export const DRAWING_PAPER_LABELS: Readonly<Record<DrawingPaperSize, string>> =
  {
    A4: 'A4',
    A3: 'A3',
    A2: 'A2',
    A1: 'A1',
    A0: 'A0',
    'ANSI-A': 'ANSI A (Letter)',
    'ANSI-B': 'ANSI B (Tabloid)',
    'ANSI-C': 'ANSI C',
    'ANSI-D': 'ANSI D'
  };

/**
 * Which side of the base view a projected view is placed on. First angle
 * (ISO) puts the top view below the front; third angle (ANSI) puts it above.
 */
export type DrawingProjectionAngle = 'first' | 'third';

/** The six principal orthographic views and the true isometric. */
export type DrawingViewOrientation =
  'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso';

export const DRAWING_VIEW_ORIENTATIONS: readonly DrawingViewOrientation[] = [
  'front',
  'top',
  'right',
  'left',
  'bottom',
  'back',
  'iso'
];

export const DRAWING_VIEW_LABELS: Readonly<
  Record<DrawingViewOrientation, string>
> = {
  front: 'Front',
  back: 'Back',
  left: 'Left',
  right: 'Right',
  top: 'Top',
  bottom: 'Bottom',
  iso: 'Isometric'
};

/**
 * A view's orthographic frame in the Z-up world. `direction` points from the
 * camera into the model, `x` is page-right and `up` is page-up, with
 * `up = x × direction` — the same handedness the kernel's `projectEdges`
 * uses. The principal views follow the glass-box fold about the front view's
 * edges, so a projected view shares its axis with the base it is folded from:
 * top and bottom keep the front's x, the side views and back keep its up.
 */
export interface DrawingViewFrame {
  readonly direction: Vector3;
  readonly x: Vector3;
  readonly up: Vector3;
}

const SQRT2 = Math.SQRT2;
const SQRT3 = Math.sqrt(3);
const SQRT6 = Math.sqrt(6);

export const DRAWING_VIEW_FRAMES: Readonly<
  Record<DrawingViewOrientation, DrawingViewFrame>
> = {
  front: {
    direction: { x: 0, y: 1, z: 0 },
    x: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 }
  },
  back: {
    direction: { x: 0, y: -1, z: 0 },
    x: { x: -1, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 }
  },
  right: {
    direction: { x: -1, y: 0, z: 0 },
    x: { x: 0, y: 1, z: 0 },
    up: { x: 0, y: 0, z: 1 }
  },
  left: {
    direction: { x: 1, y: 0, z: 0 },
    x: { x: 0, y: -1, z: 0 },
    up: { x: 0, y: 0, z: 1 }
  },
  top: {
    direction: { x: 0, y: 0, z: -1 },
    x: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 }
  },
  bottom: {
    direction: { x: 0, y: 0, z: 1 },
    x: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: -1, z: 0 }
  },
  // Seen from front-right-top, (1, -1, 1) toward the camera.
  iso: {
    direction: { x: -1 / SQRT3, y: 1 / SQRT3, z: -1 / SQRT3 },
    x: { x: 1 / SQRT2, y: 1 / SQRT2, z: 0 },
    up: { x: -1 / SQRT6, y: 1 / SQRT6, z: 2 / SQRT6 }
  }
};

/** Projects a model point into a view's page-aligned (u right, v up) plane. */
export function projectToView(
  frame: DrawingViewFrame,
  point: Vector3
): { u: number; v: number; depth: number } {
  return {
    u: frame.x.x * point.x + frame.x.y * point.y + frame.x.z * point.z,
    v: frame.up.x * point.x + frame.up.y * point.y + frame.up.z * point.z,
    depth:
      frame.direction.x * point.x +
      frame.direction.y * point.y +
      frame.direction.z * point.z
  };
}

/**
 * How a projected view stays aligned with its base: `row` shares the base's
 * page-y centre (side views and back), `column` its page-x centre (top and
 * bottom). Null when neither is folded from the other, including any pair
 * with the isometric.
 */
export function drawingViewAlignment(
  base: DrawingViewOrientation,
  child: DrawingViewOrientation
): 'row' | 'column' | null {
  if (base === child || base === 'iso' || child === 'iso') return null;
  const a = DRAWING_VIEW_FRAMES[base];
  const b = DRAWING_VIEW_FRAMES[child];
  const dot = (p: Vector3, q: Vector3) => p.x * q.x + p.y * q.y + p.z * q.z;
  if (Math.abs(dot(a.up, b.up) - 1) < 1e-9) return 'row';
  if (Math.abs(dot(a.x, b.x) - 1) < 1e-9) return 'column';
  return null;
}

/**
 * Which side of its base a projected view belongs on, along their shared
 * axis: +1 right (row) or above (column), −1 left or below. Third angle
 * places a view on the side its camera looks from (the top view above the
 * front, the right view to its right); first angle places it opposite. A
 * view looking from neither side (the back, beside the front) goes right in
 * third angle and left in first, so switching convention mirrors every
 * projected view consistently. 0 when the two do not fold.
 */
export function projectedViewSide(
  base: DrawingViewOrientation,
  child: DrawingViewOrientation,
  angle: DrawingProjectionAngle
): 1 | -1 | 0 {
  const alignment = drawingViewAlignment(base, child);
  if (alignment === null) return 0;
  const frame = DRAWING_VIEW_FRAMES[base];
  const toward = DRAWING_VIEW_FRAMES[child].direction;
  const axis = alignment === 'row' ? frame.x : frame.up;
  // The child's camera sits at −direction.
  const along = -(axis.x * toward.x + axis.y * toward.y + axis.z * toward.z);
  const third = along < -1e-9 ? -1 : 1;
  return angle === 'third' ? third : third === 1 ? -1 : 1;
}

/** A sheet scale `numerator : denominator` — paper length : model length. */
export interface DrawingScale {
  numerator: number;
  denominator: number;
}

/**
 * Pickable sheet scales, largest first: the ISO 5455 series plus the common
 * intermediates (4:1, 1:4, 1:8, 1:25, 1:250). The starter, "Fit views to
 * sheet" and "Auto scale" walk this list in order and take the first that
 * fits, so it must stay sorted from largest to smallest.
 */
export const DRAWING_SCALE_PRESETS: readonly DrawingScale[] = [
  { numerator: 50, denominator: 1 },
  { numerator: 20, denominator: 1 },
  { numerator: 10, denominator: 1 },
  { numerator: 5, denominator: 1 },
  { numerator: 4, denominator: 1 },
  { numerator: 2, denominator: 1 },
  { numerator: 1, denominator: 1 },
  { numerator: 1, denominator: 2 },
  { numerator: 1, denominator: 4 },
  { numerator: 1, denominator: 5 },
  { numerator: 1, denominator: 8 },
  { numerator: 1, denominator: 10 },
  { numerator: 1, denominator: 20 },
  { numerator: 1, denominator: 25 },
  { numerator: 1, denominator: 50 },
  { numerator: 1, denominator: 100 },
  // Large models: the starter falls back to these, and they must stay
  // pickable after the user tries another scale.
  { numerator: 1, denominator: 200 },
  { numerator: 1, denominator: 250 },
  { numerator: 1, denominator: 500 },
  { numerator: 1, denominator: 1000 }
];

export const MAX_DRAWING_SCALE_TERM = 1000;

export function formatDrawingScale(scale: DrawingScale): string {
  return `${scale.numerator}:${scale.denominator}`;
}

/** Paper millimetres per model unit at `scale`. */
export function drawingPaperPerModelUnit(
  scale: DrawingScale,
  units: UnitSystem
): number {
  return (scale.numerator / scale.denominator) * UNIT_TO_MM[units];
}

/**
 * Title-block text the user typed. Every field is optional: an absent field
 * shows its automatic value (the project name for the title, nothing for the
 * rest). Scale, sheet size, units and projection angle are never stored —
 * they are read from the sheet so they cannot disagree with it.
 */
export interface DrawingTitleBlock {
  title?: string;
  drawingNumber?: string;
  revision?: string;
  author?: string;
  date?: string;
}

export const DRAWING_TITLE_BLOCK_FIELDS = [
  'title',
  'drawingNumber',
  'revision',
  'author',
  'date'
] as const satisfies readonly (keyof DrawingTitleBlock)[];

export const MAX_DRAWING_TEXT_LENGTH = 120;
export const MAX_DRAWING_SHEETS = 50;
export const MAX_DRAWING_VIEWS = 24;
export const MAX_DRAWING_VIEW_BODIES = 256;
/** How far a projected view may sit off its base's axis, in paper mm. */
const ALIGNMENT_TOLERANCE_MM = 1e-6;
/** Placement bound, in paper millimetres: generous, but finite. */
export const MAX_DRAWING_COORDINATE_MM = 10_000;

/**
 * The model state a sheet was last drawn from: an opaque fingerprint of its
 * source bodies' exact topology and extents. Set when the sheet is created
 * and by an explicit Update, never on load.
 */
export interface DrawingSheetSource {
  fingerprint: string;
}

export interface DrawingView {
  viewId: DrawingViewId;
  orientation: DrawingViewOrientation;
  /** The bodies this view projects; they occlude one another. */
  bodyIds: BodyId[];
  /** Where the centre of the view's projected extent sits, in paper mm (y up). */
  centerMm: { x: number; y: number };
  /** Draw occluded edges as dashed hidden lines. */
  hiddenLines: boolean;
  /**
   * The base view this projected view is folded from. It stays aligned with
   * it: moving the base carries it along, and it moves only along the shared
   * axis. Absent on a base view and on the isometric.
   */
  parentViewId?: DrawingViewId;
  /**
   * D03 (schema v45): this view is a section, cut from the model by a plane
   * drawn as a section line on its source view. Absent on every other view.
   */
  section?: DrawingSectionCut;
}

/**
 * A section view's cut (D03, schema v45). The cutting plane is normal to
 * the section view's own direction of sight and stores only its depth along
 * it, in model units, so moving either view never moves the cut. Material
 * nearer the camera than the plane (`dot(direction, p) < depth`) is removed;
 * the rest is drawn, its cut faces hatched. The view stays aligned with its
 * source like a projected view folded from it (`drawingViewAlignment`), on
 * the side the sheet's projection angle gives its direction of sight, so the
 * section line on the source is horizontal or vertical there.
 */
export interface DrawingSectionCut {
  /** The view the section line is drawn on: a principal view, not a section. */
  sourceViewId: DrawingViewId;
  /** One or two capital letters naming the section ("A" for A–A). */
  label: string;
  /** The plane's depth along this view's direction, in model units. */
  depth: number;
}

export const MAX_DRAWING_SECTION_DEPTH = 1e7;
const SECTION_LABEL = /^[A-Z]{1,2}$/;

/** The cutting plane of a section view: `dot(normal, p) = depth`. */
export function drawingSectionPlane(
  view: Pick<DrawingView, 'orientation'> & {
    section: Pick<DrawingSectionCut, 'depth'>;
  }
): { normal: Vector3; depth: number } {
  return {
    normal: { ...DRAWING_VIEW_FRAMES[view.orientation].direction },
    depth: view.section.depth
  };
}

/**
 * Where a section view's cutting plane crosses its source view: a line
 * across the source at page coordinate `at` (model units, in the source's
 * own u or v), horizontal when the two share a column and vertical when they
 * share a row. `sight` is the direction of sight in the source's page
 * (u, v), the way the section line's arrows point. Null when the two do not
 * fold.
 */
export function drawingSectionLine(
  source: DrawingViewOrientation,
  section: DrawingViewOrientation,
  depth: number
): {
  axis: 'horizontal' | 'vertical';
  at: number;
  sight: [number, number];
} | null {
  const alignment = drawingViewAlignment(source, section);
  if (alignment === null) return null;
  const from = DRAWING_VIEW_FRAMES[source];
  const d = DRAWING_VIEW_FRAMES[section].direction;
  const along = alignment === 'column' ? from.up : from.x;
  const sign = along.x * d.x + along.y * d.y + along.z * d.z;
  // `along` is ±d for a folded pair, so the plane sits at ±depth on it.
  return alignment === 'column'
    ? { axis: 'horizontal', at: sign * depth, sight: [0, sign] }
    : { axis: 'vertical', at: sign * depth, sight: [sign, 0] };
}

/**
 * The section orientations a line drawn across `source` can make, looking
 * either way across it: each must fold from the source so the section view
 * can stay aligned with it. A horizontal line cuts along the source's up
 * axis, a vertical one along its x axis.
 */
export function drawingSectionOrientations(
  source: DrawingViewOrientation,
  axis: 'horizontal' | 'vertical'
): DrawingViewOrientation[] {
  if (source === 'iso') return [];
  const frame = DRAWING_VIEW_FRAMES[source];
  const along = axis === 'horizontal' ? frame.up : frame.x;
  return DRAWING_VIEW_ORIENTATIONS.filter((orientation) => {
    if (orientation === 'iso' || orientation === source) return false;
    const d = DRAWING_VIEW_FRAMES[orientation].direction;
    const dot = along.x * d.x + along.y * d.y + along.z * d.z;
    return (
      Math.abs(Math.abs(dot) - 1) < 1e-9 &&
      drawingViewAlignment(source, orientation) ===
        (axis === 'horizontal' ? 'column' : 'row')
    );
  });
}

/** The first section label the sheet does not use yet: A, B, … Z, AA, AB … */
export function nextDrawingSectionLabel(
  sheet: Pick<DrawingSheet, 'views'>
): string {
  const used = new Set(
    sheet.views.flatMap((view) => (view.section ? [view.section.label] : []))
  );
  // I, O and Q read as digits on a print; drafting practice skips them.
  const letters = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  for (const a of ['', ...letters])
    for (const b of letters) if (!used.has(a + b)) return a + b;
  throw new Error('No section labels left on this sheet.');
}

export interface DrawingSheet {
  sheetId: DrawingSheetId;
  name: string;
  paper: { size: DrawingPaperSize; orientation: DrawingPaperOrientation };
  scale: DrawingScale;
  projectionAngle: DrawingProjectionAngle;
  titleBlock: DrawingTitleBlock;
  source: DrawingSheetSource;
  views: DrawingView[];
  /**
   * D02 dimensions and notes (schema v31). Absent when the sheet has none;
   * never synthesized on load.
   */
  annotations?: DrawingAnnotation[];
}

/** The document's drawing section (schema v30). Absent means no drawings. */
export interface DrawingSet {
  sheets: DrawingSheet[];
}

export function drawingPaperMm(paper: DrawingSheet['paper']): {
  width: number;
  height: number;
} {
  const box = DRAWING_PAPER_SIZES_MM[paper.size];
  return paper.orientation === 'portrait'
    ? { width: box.width, height: box.height }
    : { width: box.height, height: box.width };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max = MAX_DRAWING_TEXT_LENGTH): boolean {
  return typeof value === 'string' && value.length <= max;
}

function isScaleTerm(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_DRAWING_SCALE_TERM
  );
}

function isCoordinate(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= MAX_DRAWING_COORDINATE_MM
  );
}

function drawingViewError(view: unknown, where: string): string | null {
  if (!isRecord(view)) return `${where} is not a view record.`;
  if (
    typeof view.viewId !== 'string' ||
    !view.viewId.startsWith(DRAWING_VIEW_ID_PREFIX) ||
    view.viewId.length > 64
  )
    return `${where} has an invalid id.`;
  if (
    typeof view.orientation !== 'string' ||
    !(DRAWING_VIEW_ORIENTATIONS as readonly string[]).includes(view.orientation)
  )
    return `${where} has an unknown orientation.`;
  if (
    !Array.isArray(view.bodyIds) ||
    view.bodyIds.length === 0 ||
    view.bodyIds.length > MAX_DRAWING_VIEW_BODIES ||
    !view.bodyIds.every(
      (id) => typeof id === 'string' && id.length > 0 && id.length <= 128
    ) ||
    new Set(view.bodyIds).size !== view.bodyIds.length
  )
    return `${where} must name its bodies once each.`;
  if (
    !isRecord(view.centerMm) ||
    !isCoordinate(view.centerMm.x) ||
    !isCoordinate(view.centerMm.y)
  )
    return `${where} has an invalid placement.`;
  if (typeof view.hiddenLines !== 'boolean')
    return `${where} has an invalid hidden-line setting.`;
  if (view.parentViewId !== undefined && typeof view.parentViewId !== 'string')
    return `${where} has an invalid base view.`;
  if (view.section !== undefined) {
    const section = view.section;
    if (
      !isRecord(section) ||
      typeof section.sourceViewId !== 'string' ||
      typeof section.label !== 'string' ||
      !SECTION_LABEL.test(section.label) ||
      typeof section.depth !== 'number' ||
      !Number.isFinite(section.depth) ||
      Math.abs(section.depth) > MAX_DRAWING_SECTION_DEPTH ||
      Object.keys(section).some(
        (key) => !['sourceViewId', 'label', 'depth'].includes(key)
      )
    )
      return `${where} has an invalid section.`;
    if (view.parentViewId !== undefined)
      return `${where} cannot be both a section and a projected view.`;
  }
  return null;
}

/** Why `value` is not a valid sheet, or null. Shape only; bodies may be gone. */
export function drawingSheetError(value: unknown): string | null {
  if (!isRecord(value)) return 'A drawing sheet is not a record.';
  const where = `Drawing sheet ${String(value.sheetId)}`;
  if (
    typeof value.sheetId !== 'string' ||
    !value.sheetId.startsWith(DRAWING_SHEET_ID_PREFIX) ||
    value.sheetId.length > 64
  )
    return 'A drawing sheet has an invalid id.';
  if (
    typeof value.name !== 'string' ||
    value.name.trim().length === 0 ||
    !isText(value.name)
  )
    return `${where} needs a name of at most ${MAX_DRAWING_TEXT_LENGTH} characters.`;
  const paper = value.paper;
  if (
    !isRecord(paper) ||
    typeof paper.size !== 'string' ||
    !Object.hasOwn(DRAWING_PAPER_SIZES_MM, paper.size) ||
    (paper.orientation !== 'landscape' && paper.orientation !== 'portrait')
  )
    return `${where} has an unknown paper size.`;
  const scale = value.scale;
  if (
    !isRecord(scale) ||
    !isScaleTerm(scale.numerator) ||
    !isScaleTerm(scale.denominator)
  )
    return `${where} needs a scale of whole numbers from 1 to ${MAX_DRAWING_SCALE_TERM}.`;
  if (value.projectionAngle !== 'first' && value.projectionAngle !== 'third')
    return `${where} has an unknown projection angle.`;
  const titleBlock = value.titleBlock;
  if (!isRecord(titleBlock)) return `${where} has no title block.`;
  for (const key of Object.keys(titleBlock)) {
    if (
      !(DRAWING_TITLE_BLOCK_FIELDS as readonly string[]).includes(key) ||
      !isText(titleBlock[key])
    )
      return `${where} has an invalid title-block field "${key}".`;
  }
  if (
    !isRecord(value.source) ||
    typeof value.source.fingerprint !== 'string' ||
    value.source.fingerprint.length > 256
  )
    return `${where} has an invalid model fence.`;
  if (!Array.isArray(value.views) || value.views.length > MAX_DRAWING_VIEWS)
    return `${where} holds at most ${MAX_DRAWING_VIEWS} views.`;
  const views = new Map<string, Record<string, unknown>>();
  for (const [index, view] of value.views.entries()) {
    const error = drawingViewError(view, `${where} view ${index + 1}`);
    if (error) return error;
    const record = view as Record<string, unknown>;
    if (views.has(record.viewId as string))
      return `${where} names view ${String(record.viewId)} twice.`;
    views.set(record.viewId as string, record);
  }
  for (const view of views.values()) {
    if (view.parentViewId === undefined) continue;
    const parent = views.get(view.parentViewId as string);
    const alignment = parent
      ? drawingViewAlignment(
          parent.orientation as DrawingViewOrientation,
          view.orientation as DrawingViewOrientation
        )
      : null;
    if (!parent || parent.parentViewId !== undefined || alignment === null)
      return `${where} has a projected view that cannot fold from its base.`;
    // Aligned on the shared axis, on the side the projection angle gives
    // it: anything else contradicts the projection the title block names.
    const child = view.centerMm as { x: number; y: number };
    const base = parent.centerMm as { x: number; y: number };
    const side = projectedViewSide(
      parent.orientation as DrawingViewOrientation,
      view.orientation as DrawingViewOrientation,
      value.projectionAngle
    );
    const [shared, free] =
      alignment === 'row'
        ? [child.y - base.y, child.x - base.x]
        : [child.x - base.x, child.y - base.y];
    if (
      Math.abs(shared) > ALIGNMENT_TOLERANCE_MM ||
      side * free < -ALIGNMENT_TOLERANCE_MM
    )
      return `${where} has a projected view out of line with its base or on the wrong side for its projection angle.`;
  }
  const labels = new Set<string>();
  for (const view of views.values()) {
    const section = view.section as DrawingSectionCut | undefined;
    if (!section) continue;
    if (labels.has(section.label))
      return `${where} names section ${section.label} twice.`;
    labels.add(section.label);
    const source = views.get(section.sourceViewId);
    if (
      !source ||
      source.section !== undefined ||
      source.orientation === 'iso' ||
      drawingViewAlignment(
        source.orientation as DrawingViewOrientation,
        view.orientation as DrawingViewOrientation
      ) === null
    )
      return `${where} has a section that cannot be cut from its source view.`;
    const child = view.centerMm as { x: number; y: number };
    const base = source.centerMm as { x: number; y: number };
    const alignment = drawingViewAlignment(
      source.orientation as DrawingViewOrientation,
      view.orientation as DrawingViewOrientation
    );
    const side = projectedViewSide(
      source.orientation as DrawingViewOrientation,
      view.orientation as DrawingViewOrientation,
      value.projectionAngle
    );
    const [shared, free] =
      alignment === 'row'
        ? [child.y - base.y, child.x - base.x]
        : [child.x - base.x, child.y - base.y];
    if (
      Math.abs(shared) > ALIGNMENT_TOLERANCE_MM ||
      side * free < -ALIGNMENT_TOLERANCE_MM
    )
      return `${where} has a section view out of line with its source or on the wrong side for its projection angle.`;
  }
  if (value.annotations !== undefined) {
    if (
      !Array.isArray(value.annotations) ||
      value.annotations.length > MAX_DRAWING_ANNOTATIONS
    )
      return `${where} holds at most ${MAX_DRAWING_ANNOTATIONS} annotations.`;
    const ids = new Set<string>();
    const viewIds = new Set(views.keys());
    for (const [index, annotation] of value.annotations.entries()) {
      const error = drawingAnnotationError(
        annotation,
        viewIds,
        `${where} annotation ${index + 1}`
      );
      if (error) return error;
      const id = (annotation as DrawingAnnotation).annotationId;
      if (ids.has(id)) return `${where} names annotation ${id} twice.`;
      ids.add(id);
    }
  }
  return null;
}

/** Why `value` is not a valid drawing section, or null. */
export function drawingSetError(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.sheets))
    return 'The drawing section is not a sheet list.';
  if (value.sheets.length > MAX_DRAWING_SHEETS)
    return `A project holds at most ${MAX_DRAWING_SHEETS} drawing sheets.`;
  const ids = new Set<string>();
  for (const sheet of value.sheets) {
    const error = drawingSheetError(sheet);
    if (error) return error;
    const id = (sheet as DrawingSheet).sheetId;
    if (ids.has(id)) return `Drawing sheet ${id} is listed twice.`;
    ids.add(id);
  }
  return null;
}

/** Fails closed on a malformed drawing section; absent is valid. */
export function assertDrawingSet(value: unknown): void {
  if (value === undefined) return;
  const error = drawingSetError(value);
  if (error) throw new Error(error);
}
