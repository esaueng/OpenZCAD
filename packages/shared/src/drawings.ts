import { millimetresPerUnit } from './index';
import type { BodyId, Brand, UnitSystem, Vector3 } from './index';
import {
  drawingAnnotationError,
  drawingAnnotationCenterlines,
  drawingAnnotationMarks,
  drawingToleranceHostAllowed,
  isDrawingToleranceAnnotation,
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
  return (scale.numerator / scale.denominator) * millimetresPerUnit(units);
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
  /**
   * D02 (schema v94): the shop layout's fields. Stored with any layout, so
   * switching back and forth loses nothing; only the shop layout prints them.
   */
  company?: string;
  material?: string;
  finish?: string;
  checkedBy?: string;
  approvedBy?: string;
  /** The general-tolerance note ("UNLESS STATED ±0.1 mm, ±0.5°"). */
  tolerances?: string;
}

/** v94: the title-block fields only the shop layout prints. */
export const DRAWING_TITLE_BLOCK_SHOP_FIELDS = [
  'company',
  'material',
  'finish',
  'checkedBy',
  'approvedBy',
  'tolerances'
] as const satisfies readonly (keyof DrawingTitleBlock)[];

export const DRAWING_TITLE_BLOCK_FIELDS = [
  'title',
  'drawingNumber',
  'revision',
  'author',
  'date',
  ...DRAWING_TITLE_BLOCK_SHOP_FIELDS
] as const satisfies readonly (keyof DrawingTitleBlock)[];

/**
 * D02 (schema v94): a sheet's title-block layout. Absent is the compact
 * block; `shop` adds material, finish, checked and approved, the company
 * and a general-tolerance note.
 */
export type DrawingTitleBlockLayout = 'shop';

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
   * D03 (schema v47): this view is a section, cut from the model by a plane
   * drawn as a section line on its source view. Absent on every other view.
   */
  section?: DrawingSectionCut;
  /**
   * D03 (schema v78): this view is a detail of its source, enlarged: the
   * part of the source inside a circle, at its own scale. Absent on every
   * other view.
   */
  detail?: DrawingDetail;
  /**
   * D03 (schema v81): this view is an auxiliary view of its source, looking
   * square onto a face the source sees edge-on. Absent on every other view.
   */
  auxiliary?: DrawingAuxiliary;
  /**
   * F06 (schema v89): the configuration row this view draws, built on its
   * own, while the document's active row stays the model being edited.
   * Only a base view names one; a view folded from it, cut from it or
   * detailed from it draws its source's row. Absent: the active row.
   */
  configurationId?: string;
  /**
   * AS03 (schema v114): this view draws the assembly exploded: each part's
   * body at its solved pose with the stored exploded-view offset applied
   * (`T(offset) · pose`, `assembly.explode`), a body in no part where it was
   * modelled. Set on a base view and carried by the views projected from
   * it; never on a section, detail or auxiliary view, nor on a view of
   * another configuration row. Only notes and balloons go on it: parts are
   * placed for presentation, so dimensions belong on an assembled view.
   * Absent: bodies are drawn where they were modelled.
   */
  exploded?: true;
}

/** Annotation kinds an exploded view (v114) carries: it is presentation. */
export const DRAWING_EXPLODED_VIEW_ANNOTATIONS: readonly string[] = [
  'note',
  'balloon'
];

/**
 * An auxiliary view (D03, schema v81): seen along a direction in its source
 * view's plane, square to an edge the source draws true length, so a face
 * inclined to every principal view is drawn true size. Its frame is stored
 * (`direction` of sight and page-right `x`, unit and square to each other;
 * page-up is the source's own direction of sight), so moving either view
 * never turns it. It keeps its source's orientation and bodies and is placed
 * freely, labelled VIEW A with an arrow on the source.
 */
export interface DrawingAuxiliary {
  /** A principal view: not the isometric, a section, a detail or another auxiliary. */
  sourceViewId: DrawingViewId;
  /** One or two capitals, in the sequence sections and details share. */
  label: string;
  direction: Vector3;
  x: Vector3;
}

/**
 * The frame a view projects in: its named orientation's, or an auxiliary
 * view's or free section's stored one (page-up `x × direction`).
 */
export function drawingViewFrame(
  view: Pick<DrawingView, 'orientation' | 'auxiliary'> & {
    section?: Pick<DrawingSectionCut, 'frame'> | undefined;
  }
): DrawingViewFrame {
  const stored = view.auxiliary ?? view.section?.frame;
  if (!stored) return DRAWING_VIEW_FRAMES[view.orientation];
  const { direction: d, x } = stored;
  return {
    direction: { ...d },
    x: { ...x },
    up: {
      x: x.y * d.z - x.z * d.y,
      y: x.z * d.x - x.x * d.z,
      z: x.x * d.y - x.y * d.x
    }
  };
}

/**
 * Whether a view projects in a stored frame rather than its orientation's:
 * an auxiliary view (v81) or a free section (v91). Its axes are not model
 * axes, so axis-bound tools (auto-dimensioning, the audit) pass over it.
 */
export function drawingViewHasOwnFrame(
  view: Pick<DrawingView, 'auxiliary' | 'section'>
): boolean {
  return view.auxiliary !== undefined || view.section?.frame !== undefined;
}

/**
 * A detail view (D03, schema v78): the region of its source view inside a
 * circle, drawn at its own scale and cropped to the circle, with its own
 * hidden-line setting. It looks the way its source looks (same orientation
 * and bodies), stores the circle in the source's model (u, v) so moving
 * either view never moves the region, and is placed freely on the sheet.
 */
export interface DrawingDetail {
  /** A principal or isometric view, not a section or another detail. */
  sourceViewId: DrawingViewId;
  /** One or two capitals naming the detail ("A" for DETAIL A), unique per sheet with sections. */
  label: string;
  /** The circle's centre in the source view's model (u, v), model units. */
  center: { u: number; v: number };
  /** The circle's radius in model units. */
  radius: number;
  /** The detail's own scale, paper : model. */
  scale: DrawingScale;
}

/**
 * A section view's cut (D03, schema v47). The cutting plane is normal to
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
  /**
   * D03 (schema v91): a free section, cut by a plane at any angle across
   * its source. Its frame is stored like an auxiliary view's (`direction`
   * of sight, the plane's normal, in the source's plane, and page-right
   * `x`; page-up is the source's direction of sight), the view keeps its
   * source's orientation and is placed freely. Absent: the plane is normal
   * to a principal direction and the view stays aligned with its source.
   */
  frame?: DrawingSectionFrame;
  /**
   * D03 (schema v93): a stepped (offset) section of an aligned one. The
   * cutting line on the source runs at `depth` and steps, at each `at`
   * along it (the source's u for a horizontal line, v for a vertical one,
   * model units, ascending), to that step's own `depth`; each segment cuts
   * its own strip. Absent or empty: one plane. A free section takes none.
   */
  steps?: DrawingSectionStep[];
}

/** One step of a stepped section (D03, schema v93). */
export interface DrawingSectionStep {
  at: number;
  depth: number;
}

export const MAX_DRAWING_SECTION_STEPS = 8;

/**
 * D03 (v93): the world axis a stepped section's line runs along on its
 * source (the source's page-right for a horizontal line, page-up for a
 * vertical one), so each step's `at` is a coordinate on it. Null when the
 * two views do not fold.
 */
export function drawingSectionStepAxis(
  source: DrawingViewOrientation,
  section: DrawingViewOrientation
): Vector3 | null {
  const alignment = drawingViewAlignment(source, section);
  if (alignment === null) return null;
  const frame = DRAWING_VIEW_FRAMES[source];
  // A column pair shares page-up, so the line across it is horizontal.
  return { ...(alignment === 'column' ? frame.x : frame.up) };
}

/**
 * A section view's whole cut for the geometry worker: its plane, and
 * (v93) its steps with the axis they are measured along. `source` is the
 * view it is cut from (its orientation places the steps).
 */
export function drawingSectionCut(
  view: Pick<DrawingView, 'orientation'> & {
    section: Pick<DrawingSectionCut, 'depth' | 'frame' | 'steps'>;
  },
  source: DrawingViewOrientation | undefined
): {
  normal: Vector3;
  depth: number;
  steps?: { along: Vector3; at: number; depth: number }[];
} {
  const plane = drawingSectionPlane(view);
  const steps = view.section.steps ?? [];
  const along =
    steps.length > 0 && source && !view.section.frame
      ? drawingSectionStepAxis(source, view.orientation)
      : null;
  return along
    ? {
        ...plane,
        steps: steps.map((step) => ({
          along: { ...along },
          at: step.at,
          depth: step.depth
        }))
      }
    : plane;
}

/** A free section's frame (D03, schema v91), unit and square. */
export interface DrawingSectionFrame {
  direction: Vector3;
  x: Vector3;
}

export const MAX_DRAWING_SECTION_DEPTH = 1e7;
const SECTION_LABEL = /^[A-Z]{1,2}$/;

/** The cutting plane of a section view: `dot(normal, p) = depth`. */
export function drawingSectionPlane(
  view: Pick<DrawingView, 'orientation'> & {
    section: Pick<DrawingSectionCut, 'depth' | 'frame'>;
  }
): { normal: Vector3; depth: number } {
  return {
    normal: {
      ...(view.section.frame?.direction ??
        DRAWING_VIEW_FRAMES[view.orientation].direction)
    },
    depth: view.section.depth
  };
}

/**
 * Where a free section's plane crosses its source view (D03, v91): the
 * line `sight · (u, v) = depth` in the source's model (u, v), `sight` the
 * plane's normal there (unit), the way the section line's arrows point.
 */
export function drawingFreeSectionLine(
  source: DrawingViewOrientation,
  frame: DrawingSectionFrame,
  depth: number
): { sight: [number, number]; depth: number } {
  const from = DRAWING_VIEW_FRAMES[source];
  const d = frame.direction;
  const a = d.x * from.x.x + d.y * from.x.y + d.z * from.x.z;
  const b = d.x * from.up.x + d.y * from.up.y + d.z * from.up.z;
  const length = Math.hypot(a, b);
  return { sight: [a / length, b / length], depth: depth / length };
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

/**
 * The first section or detail label the sheet does not use yet: A, B, … Z,
 * AA, AB … (sections and details share one sequence, as on a print).
 */
export function nextDrawingSectionLabel(
  sheet: Pick<DrawingSheet, 'views'>
): string {
  const used = new Set(
    sheet.views.flatMap((view) =>
      view.section
        ? [view.section.label]
        : view.detail
          ? [view.detail.label]
          : view.auxiliary
            ? [view.auxiliary.label]
            : []
    )
  );
  // I, O and Q read as digits on a print; drafting practice skips them.
  const letters = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  for (const a of ['', ...letters])
    for (const b of letters) if (!used.has(a + b)) return a + b;
  throw new Error('No section labels left on this sheet.');
}

/**
 * D02 (schema v70): the line classes a sheet prints, each with its own
 * weight in paper millimetres (ISO 128 defaults when absent).
 */
export const DRAWING_LINE_CLASSES = [
  'visible',
  'hidden',
  'thin',
  'border',
  'dimension',
  'hatch',
  'chain',
  'cutting'
] as const;
export type DrawingLineClass = (typeof DRAWING_LINE_CLASSES)[number];

export const DRAWING_LINE_CLASS_LABELS: Readonly<
  Record<DrawingLineClass, string>
> = {
  visible: 'Visible edges',
  hidden: 'Hidden edges',
  thin: 'Title block rules',
  border: 'Borders',
  dimension: 'Dimensions and notes',
  hatch: 'Section hatching',
  chain: 'Centre and cutting-plane lines',
  cutting: 'Cutting-plane ends'
};

export const MIN_DRAWING_LINE_WIDTH_MM = 0.05;
export const MAX_DRAWING_LINE_WIDTH_MM = 2;

/** How a sheet writes angles: decimal degrees, or degrees, minutes and seconds. */
export type DrawingAngleFormat = 'decimal' | 'dms';

/**
 * D02 (schema v70): a sheet's drawing properties. Every field is optional
 * and absent keeps the document's units, the units' default precision, a
 * decimal point, decimal degrees and the ISO 128 line weights, so an older
 * sheet draws and exports exactly as before.
 *
 * Dimension values and their tolerances are printed in `units`: a value is
 * measured in the document's units and converted, and a tolerance's
 * deviations are amounts in `units` (degrees on an angle).
 */
export interface DrawingSheetFormat {
  /** The units dimensions are printed in; absent is the document's. */
  units?: UnitSystem;
  /** Decimal places for lengths, trailing zeros trimmed; absent is the units' default. */
  decimals?: number;
  /** Decimal places for decimal degrees, or for the seconds of D°M'S". */
  angleDecimals?: number;
  angleFormat?: DrawingAngleFormat;
  /** Absent is a point. */
  decimalSeparator?: 'comma';
  /** Print weights by line class, in paper millimetres. */
  lineWidthsMm?: Partial<Record<DrawingLineClass, number>>;
}

export interface DrawingSheet {
  sheetId: DrawingSheetId;
  name: string;
  paper: { size: DrawingPaperSize; orientation: DrawingPaperOrientation };
  scale: DrawingScale;
  projectionAngle: DrawingProjectionAngle;
  titleBlock: DrawingTitleBlock;
  /** D02 (schema v94): absent is the compact title block. */
  titleBlockLayout?: DrawingTitleBlockLayout;
  source: DrawingSheetSource;
  views: DrawingView[];
  /**
   * D02 dimensions and notes (schema v31). Absent when the sheet has none;
   * never synthesized on load.
   */
  annotations?: DrawingAnnotation[];
  /** D02 drawing properties (schema v70); absent keeps every default. */
  format?: DrawingSheetFormat;
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
  if (view.configurationId !== undefined) {
    if (
      typeof view.configurationId !== 'string' ||
      view.configurationId.length === 0 ||
      view.configurationId.length > 128
    )
      return `${where} names no usable configuration.`;
    if (
      view.parentViewId !== undefined ||
      view.section !== undefined ||
      view.detail !== undefined ||
      view.auxiliary !== undefined
    )
      return `${where} draws its source view's configuration and cannot name its own.`;
  }
  if (view.exploded !== undefined) {
    if (view.exploded !== true)
      return `${where} has an invalid exploded setting.`;
    if (
      view.section !== undefined ||
      view.detail !== undefined ||
      view.auxiliary !== undefined
    )
      return `${where} cannot be drawn exploded: only a base view and the views projected from it can.`;
    if (view.configurationId !== undefined)
      return `${where} draws another configuration and cannot be drawn exploded.`;
  }
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
        (key) =>
          !['sourceViewId', 'label', 'depth', 'frame', 'steps'].includes(key)
      )
    )
      return `${where} has an invalid section.`;
    if (section.steps !== undefined) {
      const steps = section.steps;
      if (
        !Array.isArray(steps) ||
        steps.length > MAX_DRAWING_SECTION_STEPS ||
        !steps.every(
          (step) =>
            isRecord(step) &&
            Object.keys(step).length === 2 &&
            [step.at, step.depth].every(
              (value) =>
                typeof value === 'number' &&
                Number.isFinite(value) &&
                Math.abs(value) <= MAX_DRAWING_SECTION_DEPTH
            )
        )
      )
        return `${where} has invalid section steps (at most ${MAX_DRAWING_SECTION_STEPS}).`;
      const ats = (steps as DrawingSectionStep[]).map((step) => step.at);
      if (ats.some((at, index) => index > 0 && !(at > ats[index - 1]!)))
        return `${where} has section steps out of order along the line.`;
      if (section.frame !== undefined && steps.length > 0)
        return `${where} is a free section, which takes no steps.`;
    }
    if (section.frame !== undefined) {
      const frame = section.frame;
      const unit = (value: unknown) =>
        isRecord(value) &&
        Object.keys(value).length === 3 &&
        [value.x, value.y, value.z].every(
          (component) =>
            typeof component === 'number' && Number.isFinite(component)
        ) &&
        Math.abs(
          Math.hypot(value.x as number, value.y as number, value.z as number) -
            1
        ) <= 1e-9;
      if (
        !isRecord(frame) ||
        !unit(frame.direction) ||
        !unit(frame.x) ||
        Object.keys(frame).some((key) => !['direction', 'x'].includes(key))
      )
        return `${where} has an invalid section frame.`;
      const d = frame.direction as Vector3;
      const x = frame.x as Vector3;
      if (Math.abs(d.x * x.x + d.y * x.y + d.z * x.z) > 1e-9)
        return `${where} has a section frame whose axes are not square.`;
    }
    if (view.parentViewId !== undefined)
      return `${where} cannot be both a section and a projected view.`;
  }
  if (view.auxiliary !== undefined) {
    const auxiliary = view.auxiliary;
    const unit = (value: unknown) =>
      isRecord(value) &&
      Object.keys(value).length === 3 &&
      [value.x, value.y, value.z].every(
        (component) =>
          typeof component === 'number' && Number.isFinite(component)
      ) &&
      Math.abs(
        Math.hypot(value.x as number, value.y as number, value.z as number) - 1
      ) <= 1e-9;
    if (
      !isRecord(auxiliary) ||
      typeof auxiliary.sourceViewId !== 'string' ||
      typeof auxiliary.label !== 'string' ||
      !SECTION_LABEL.test(auxiliary.label) ||
      !unit(auxiliary.direction) ||
      !unit(auxiliary.x) ||
      Object.keys(auxiliary).some(
        (key) => !['sourceViewId', 'label', 'direction', 'x'].includes(key)
      )
    )
      return `${where} has an invalid auxiliary view.`;
    const d = auxiliary.direction as Vector3;
    const x = auxiliary.x as Vector3;
    if (Math.abs(d.x * x.x + d.y * x.y + d.z * x.z) > 1e-9)
      return `${where} has an auxiliary frame whose axes are not square.`;
    if (
      view.parentViewId !== undefined ||
      view.section !== undefined ||
      view.detail !== undefined
    )
      return `${where} cannot be an auxiliary view and a projected, section or detail view.`;
  }
  if (view.detail !== undefined) {
    const detail = view.detail;
    if (
      !isRecord(detail) ||
      typeof detail.sourceViewId !== 'string' ||
      typeof detail.label !== 'string' ||
      !SECTION_LABEL.test(detail.label) ||
      !isRecord(detail.center) ||
      !isCoordinateValue(detail.center.u) ||
      !isCoordinateValue(detail.center.v) ||
      Object.keys(detail.center).length !== 2 ||
      typeof detail.radius !== 'number' ||
      !Number.isFinite(detail.radius) ||
      detail.radius <= 0 ||
      detail.radius > MAX_DRAWING_SECTION_DEPTH ||
      !isRecord(detail.scale) ||
      !isScaleTerm(detail.scale.numerator) ||
      !isScaleTerm(detail.scale.denominator) ||
      Object.keys(detail.scale).length !== 2 ||
      Object.keys(detail).some(
        (key) =>
          !['sourceViewId', 'label', 'center', 'radius', 'scale'].includes(key)
      )
    )
      return `${where} has an invalid detail.`;
    if (view.parentViewId !== undefined || view.section !== undefined)
      return `${where} cannot be a detail and a projected or section view.`;
  }
  return null;
}

/** A model coordinate a detail's circle may sit at. */
function isCoordinateValue(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= MAX_DRAWING_SECTION_DEPTH
  );
}

const UNIT_SYSTEMS: readonly unknown[] = ['mm', 'cm', 'm', 'inch'];

function isDecimals(value: unknown): boolean {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 6
  );
}

/** Why `value` is not a stored {@link DrawingSheetFormat}, or null. */
export function drawingSheetFormatError(value: unknown): string | null {
  if (!isRecord(value)) return 'has drawing properties that are not a record';
  for (const key of Object.keys(value))
    if (
      ![
        'units',
        'decimals',
        'angleDecimals',
        'angleFormat',
        'decimalSeparator',
        'lineWidthsMm'
      ].includes(key)
    )
      return `has an unknown drawing property "${key}"`;
  if (value.units !== undefined && !UNIT_SYSTEMS.includes(value.units))
    return 'prints dimensions in unknown units';
  if (value.decimals !== undefined && !isDecimals(value.decimals))
    return 'shows lengths to other than 0 to 6 decimals';
  if (value.angleDecimals !== undefined && !isDecimals(value.angleDecimals))
    return 'shows angles to other than 0 to 6 decimals';
  if (
    value.angleFormat !== undefined &&
    value.angleFormat !== 'decimal' &&
    value.angleFormat !== 'dms'
  )
    return 'has an unknown angle format';
  if (
    value.decimalSeparator !== undefined &&
    value.decimalSeparator !== 'comma'
  )
    return 'has an unknown decimal separator';
  if (value.lineWidthsMm !== undefined) {
    const widths = value.lineWidthsMm;
    if (!isRecord(widths)) return 'has line weights that are not a record';
    for (const [key, width] of Object.entries(widths)) {
      if (!(DRAWING_LINE_CLASSES as readonly string[]).includes(key))
        return `has a weight for an unknown line class "${key}"`;
      if (
        typeof width !== 'number' ||
        !Number.isFinite(width) ||
        width < MIN_DRAWING_LINE_WIDTH_MM ||
        width > MAX_DRAWING_LINE_WIDTH_MM
      )
        return `has a ${key} line weight outside ${MIN_DRAWING_LINE_WIDTH_MM}–${MAX_DRAWING_LINE_WIDTH_MM} mm`;
    }
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
  if (value.titleBlockLayout !== undefined && value.titleBlockLayout !== 'shop')
    return `${where} has an unknown title-block layout.`;
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
    if (
      !parent ||
      parent.parentViewId !== undefined ||
      parent.detail !== undefined ||
      parent.auxiliary !== undefined ||
      alignment === null
    )
      return `${where} has a projected view that cannot fold from its base.`;
    // v114: a projected view draws the assembly as its base does.
    if ((view.exploded === true) !== (parent.exploded === true))
      return `${where} has a projected view that is not drawn exploded the way its base is.`;
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
  // v114: sections, details and auxiliary views are cut and looked at on
  // the modelled bodies, so their source is never an exploded view.
  for (const view of views.values()) {
    const source =
      (view.section as DrawingSectionCut | undefined)?.sourceViewId ??
      (view.detail as DrawingDetail | undefined)?.sourceViewId ??
      (view.auxiliary as DrawingAuxiliary | undefined)?.sourceViewId;
    if (source !== undefined && views.get(source)?.exploded === true)
      return `${where} has a section, detail or auxiliary view taken from an exploded view.`;
  }
  const labels = new Set<string>();
  for (const view of views.values()) {
    const auxiliary = view.auxiliary as DrawingAuxiliary | undefined;
    if (!auxiliary) continue;
    if (labels.has(auxiliary.label))
      return `${where} names view ${auxiliary.label} twice.`;
    labels.add(auxiliary.label);
    const source = views.get(auxiliary.sourceViewId);
    const sight = source
      ? DRAWING_VIEW_FRAMES[source.orientation as DrawingViewOrientation]
          .direction
      : null;
    const d = auxiliary.direction;
    if (
      !source ||
      !sight ||
      source.orientation === 'iso' ||
      source.section !== undefined ||
      source.detail !== undefined ||
      source.auxiliary !== undefined ||
      source.orientation !== view.orientation ||
      [...(source.bodyIds as string[])].sort().join('\u0000') !==
        [...(view.bodyIds as string[])].sort().join('\u0000') ||
      Math.abs(d.x * sight.x + d.y * sight.y + d.z * sight.z) > 1e-9
    )
      return `${where} has an auxiliary view that is not seen square from its source.`;
  }
  for (const view of views.values()) {
    const detail = view.detail as DrawingDetail | undefined;
    if (!detail) continue;
    if (labels.has(detail.label))
      return `${where} names view ${detail.label} twice.`;
    labels.add(detail.label);
    const source = views.get(detail.sourceViewId);
    const sameBodies = (a: unknown, b: unknown) =>
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      [...(a as string[])].sort().join('\u0000') ===
        [...(b as string[])].sort().join('\u0000');
    if (
      !source ||
      source.section !== undefined ||
      source.detail !== undefined ||
      source.auxiliary !== undefined ||
      source.orientation !== view.orientation ||
      !sameBodies(source.bodyIds, view.bodyIds)
    )
      return `${where} has a detail that does not look as its source view does.`;
  }
  for (const view of views.values()) {
    const section = view.section as DrawingSectionCut | undefined;
    if (!section) continue;
    if (labels.has(section.label))
      return `${where} names section ${section.label} twice.`;
    labels.add(section.label);
    const source = views.get(section.sourceViewId);
    if (section.frame) {
      // A free section: seen along a direction in its source's plane,
      // keeping the source's orientation, placed anywhere.
      const sight =
        source && source.orientation !== 'iso'
          ? DRAWING_VIEW_FRAMES[source.orientation as DrawingViewOrientation]
              .direction
          : null;
      const d = section.frame.direction;
      if (
        !source ||
        !sight ||
        source.section !== undefined ||
        source.detail !== undefined ||
        source.auxiliary !== undefined ||
        source.orientation !== view.orientation ||
        Math.abs(d.x * sight.x + d.y * sight.y + d.z * sight.z) > 1e-9
      )
        return `${where} has a section that cannot be cut from its source view.`;
      continue;
    }
    if (
      !source ||
      source.section !== undefined ||
      source.detail !== undefined ||
      source.auxiliary !== undefined ||
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
  if (value.format !== undefined) {
    const error = drawingSheetFormatError(value.format);
    if (error) return `${where} ${error}.`;
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
    // v114: an exploded view carries notes and balloons only.
    for (const annotation of value.annotations as DrawingAnnotation[]) {
      const viewId = (annotation as { viewId?: string }).viewId;
      if (
        viewId !== undefined &&
        views.get(viewId)?.exploded === true &&
        !DRAWING_EXPLODED_VIEW_ANNOTATIONS.includes(annotation.kind)
      )
        return `${where} annotation ${annotation.annotationId} is a ${annotation.kind} on an exploded view, which carries notes and balloons only.`;
    }
    // v73: a mark measured to is a centre or intersection mark of the same
    // view. A missing one is not refused here: deleting a mark leaves what
    // measured to it broken until it is re-picked, like a lost edge.
    const annotations = value.annotations as DrawingAnnotation[];
    const byId = new Map(
      annotations.map((entry) => [entry.annotationId, entry])
    );
    for (const annotation of annotations)
      for (const markId of drawingAnnotationMarks(annotation)) {
        const mark = byId.get(markId);
        if (
          mark &&
          ((mark.kind !== 'center-mark' && mark.kind !== 'intersection-mark') ||
            mark.viewId !== annotation.viewId)
        )
          return `${where} annotation ${annotation.annotationId} measures to ${markId}, which is not a mark on its view.`;
      }
    // v98: a datum symbol or frame is attached to a dimension (a datum
    // symbol also to a frame) on its own view. A missing host is not
    // refused here: deleting it leaves the attachment broken, like a mark.
    for (const annotation of annotations) {
      if (!isDrawingToleranceAnnotation(annotation)) continue;
      const hostId = annotation.attachedTo;
      const host = hostId ? byId.get(hostId) : undefined;
      if (
        host &&
        (!drawingToleranceHostAllowed(annotation.kind, host) ||
          host.viewId !== annotation.viewId)
      )
        return `${where} annotation ${annotation.annotationId} is attached to ${hostId}, which is not a dimension${annotation.kind === 'datum-feature' ? ' or feature control frame' : ''} on its view.`;
    }
    // v75: a centreline measured to is a straight one on the same view.
    for (const annotation of annotations)
      for (const lineId of drawingAnnotationCenterlines(annotation)) {
        const line = byId.get(lineId);
        if (
          line &&
          (line.kind !== 'centerline' ||
            line.mode === 'circle' ||
            line.viewId !== annotation.viewId)
        )
          return `${where} annotation ${annotation.annotationId} measures to ${lineId}, which is not a straight centreline on its view.`;
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
