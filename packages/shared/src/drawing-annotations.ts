import type {
  BodyId,
  Brand,
  EdgeTopologyReferenceV5,
  FaceTopologyReferenceV5
} from './index';
import type { DrawingViewId } from './drawings';

/**
 * D02 drawing annotations (schema v31): dimensions and notes placed on a
 * sheet. Like the sheet itself they store intent only — which model edges a
 * dimension measures and where its text sits — never a value. Every value
 * is read from the current model each time the sheet is drawn, and only
 * when the sheet's fence says the model is the one it was last drawn from,
 * so a dimension follows the same explicit Update as the views.
 *
 * An edge is held the way a stored measurement holds one: its ADR-013
 * lineage name first, then its ADR-011 hash. A reference that no longer
 * resolves to exactly one edge leaves the annotation where it is, marked
 * broken, until someone re-picks or deletes it; nothing ever rebinds to a
 * nearby edge.
 *
 * D06 slice B (schema v48) adds what a turned or chamfered part needs and
 * D02 could not say: a circular edge's silhouette extreme and two faces'
 * virtual sharp as dimension points, a chamfer dimension (`size × angle`),
 * a count (`4×`) on radial and chamfer dimensions, a Ø prefix on a linear
 * span, reference dimensions shown in brackets, and provenance for an
 * annotation the auto-dimensioner placed. All are additive and absent on
 * every older annotation; faces are held like edges, by lineage then hash.
 *
 * D06 slice D (schema v49) adds what a history-less turned import needs:
 * the corner a step chamfer cuts, sized like a sibling chamfer, as a
 * dimension point; a radius on a revolved blend's face seen side-on; and
 * provenance marking a dimension placed from raw geometry rather than a
 * recognized feature.
 *
 * Schema v50 adds a counterbored hole's callout: a diameter that also names
 * the counterbore's rim, read as one "Ø THRU, CBORE Ø × depth DEEP" note.
 *
 * Schema v51 adds a countersunk hole's callout ("Ø THRU, CSK Ø × 90°", the
 * cone's outer rim) and the outside angle: one ray of an angle dimension
 * turned onto its edge's extension.
 *
 * Schema v68 (D02) adds a tolerance and a prefix and suffix to a dimension
 * (see {@link DrawingTolerance}). Each is optional and absent on every older
 * annotation.
 *
 * Schema v73 (D02) adds geometry annotations — centre marks, intersection
 * marks and centrelines (through two points, midway between two lines, or a
 * circle through three points) — and a mark as a dimension point.
 *
 * Schema v80 (D02) adds an assembly's parts list (`bom-table`) on the paper
 * and balloons naming a part's item number, both read from the AS03 BOM
 * table each time the sheet is drawn.
 *
 * Schema v75 (D02) adds the distance dimension: point to line, line to
 * line, and to a circle's centre or its near or far side (min/max), where a
 * line may be a straight edge or a centreline.
 *
 * Schema v82 (D02) adds the arc angle (an arc's included angle at its
 * centre) and the three-point angle (at a vertex point between two others).
 *
 * Schema v98 (D07) adds geometric tolerancing: datum feature symbols and
 * feature control frames (ASME Y14.5-2018 and ISO 1101 symbols), each
 * pointing at an edge with a leader or attached to the dimension of a
 * feature of size (a datum symbol may also hang from a frame). Like every
 * annotation they store intent only, and break by name rather than rebind.
 *
 * Schema v105 (D07 slice B) adds an ISO 286 fit class and an ISO 965 / UN
 * thread class on a diameter, and the general-tolerance block on the paper
 * (ISO 2768-1 classes, or a stated decimal-place block).
 */

export type DrawingAnnotationId = Brand<string, 'DrawingAnnotationId'>;

export const DRAWING_ANNOTATION_ID_PREFIX = 'dann_';

export function createDrawingAnnotationId(): DrawingAnnotationId {
  return `${DRAWING_ANNOTATION_ID_PREFIX}${crypto.randomUUID()}` as DrawingAnnotationId;
}

/** One model edge, resolved by lineage, then by hash. */
export interface DrawingEdgeRef {
  bodyId: BodyId;
  /** ADR-011 fingerprint when the edge was picked. */
  hash: number;
  /** ADR-013 persistent reference, when the kernel proved one. */
  reference?: EdgeTopologyReferenceV5;
}

/** One model face, resolved by lineage, then by hash (schema v48). */
export interface DrawingFaceRef {
  bodyId: BodyId;
  /** ADR-011 fingerprint when the face was picked. */
  hash: number;
  /** ADR-013 persistent reference, when the kernel proved one. */
  reference?: FaceTopologyReferenceV5;
}

/**
 * A point on an edge. `first` and `second` are an open edge's two ends in
 * the view's page order — the end further left, or lower when the two are
 * level, is `first` — so the choice does not depend on which way the kernel
 * happens to run the edge. `center` is a circular edge's centre.
 */
export type DrawingPointAnchor = 'first' | 'second' | 'center';

/**
 * Which extreme of a curve a horizontal or vertical dimension measures to:
 * the one lower along its measuring direction on the page (further left, or
 * further down) or the higher one.
 */
export type DrawingExtremeSide = 'low' | 'high';

/** A D02 point: an open edge's end, or a circle's centre. */
export interface DrawingEdgePointRef {
  edge: DrawingEdgeRef;
  anchor: DrawingPointAnchor;
}

/**
 * v48: a circular edge's extreme along the dimension's measuring direction.
 * A turned part's rims are closed circles with no ends, and seen side-on
 * they draw as lines whose ends are the part's silhouette: this is how its
 * height and its side-view diameter are dimensioned.
 */
export interface DrawingSilhouettePointRef {
  edge: DrawingEdgeRef;
  anchor: 'silhouette';
  side: DrawingExtremeSide;
}

/**
 * v48: where two faces' underlying surfaces meet, though the part rounds or
 * chamfers that corner away — a chamfer's virtual sharp with the body. Two
 * coaxial surfaces of revolution, or one and a plane square to their axis,
 * meet in a circle, measured at its extreme on `side`; two planes meet in a
 * line, which the view must see end-on as a point.
 */
export interface DrawingVirtualSharpRef {
  faces: [DrawingFaceRef, DrawingFaceRef];
  anchor: 'virtual-sharp';
  side: DrawingExtremeSide;
}

/**
 * v49: the sharp corner a chamfer between two diameters cuts away, when it
 * is the same chamfer as `like` (one of equal angle on the same diameter,
 * cut at an end face): from its virtual sharp with the larger diameter,
 * `like`'s size along the axis, away from that diameter. A shoulder
 * chamfer running into a neck has no end face of its own, so this is where
 * the body it was cut from ended — the foot's 29 to the shoulder. Measured
 * at the larger diameter's extreme on `side`, like a rim.
 */
export interface DrawingChamferCornerRef {
  face: DrawingFaceRef;
  like: DrawingFaceRef;
  anchor: 'chamfer-corner';
  side: DrawingExtremeSide;
}

/**
 * v73: the point a centre mark or an intersection mark on the same view
 * marks, read through it each time it is drawn. Deleting the mark breaks
 * what measures to it.
 */
export interface DrawingMarkPointRef {
  anchor: 'mark';
  annotationId: DrawingAnnotationId;
}

export type DrawingPointRef =
  | DrawingEdgePointRef
  | DrawingSilhouettePointRef
  | DrawingVirtualSharpRef
  | DrawingChamferCornerRef
  | DrawingMarkPointRef;

/**
 * Which way a two-point dimension measures in its view: along the page
 * (`horizontal`), up it (`vertical`), or along the line through both points
 * (`aligned`).
 */
export type DrawingLinearDirection = 'horizontal' | 'vertical' | 'aligned';

/**
 * v48: an annotation the auto-dimensioner placed, and the requirement it
 * states, so a rerun replaces its own and leaves a person's alone. Absent
 * means a person placed it.
 */
export interface DrawingAnnotationProvenance {
  generated: true;
  /** The checker's key for the requirement this states. */
  requirement: string;
  /**
   * v49: read from raw geometry, not a recognized feature — on an import
   * with no history, a face no feature explains. Absent means a feature.
   */
  basis?: 'geometry';
}

interface DrawingAnnotationBase {
  annotationId: DrawingAnnotationId;
  /**
   * Where the annotation's text sits, in paper millimetres (y up): relative
   * to its view's centre when it belongs to a view, so moving the view
   * carries it along, and from the paper's corner when it does not.
   */
  placementMm: { x: number; y: number };
  provenance?: DrawingAnnotationProvenance;
}

/**
 * v68: a dimension's tolerance. Deviations are signed amounts from the
 * measured value, in the units the dimension is printed in (the sheet's
 * units from v70, else the document's; degrees on an angle), so
 * a toleranced dimension stays associative: `limits` prints the measured
 * value plus each deviation, read from the model each time it is drawn.
 *
 * - `symmetric`: `10 ±0.05`; `value` is positive.
 * - `deviation`: `10` with `+0.1` over `-0.05` stacked after it.
 * - `limits`: `10.1` over `9.95`, the value plus `upper` over plus `lower`.
 * - `basic`: the theoretically exact value, framed.
 *
 * `upper` is strictly greater than `lower`. A reference dimension takes no
 * tolerance, and a chamfer's `size × angle` callout takes none.
 */
export type DrawingTolerance =
  | { kind: 'symmetric'; value: number }
  | { kind: 'deviation'; upper: number; lower: number }
  | { kind: 'limits'; upper: number; lower: number }
  | { kind: 'basic' };

export type DrawingToleranceKind = DrawingTolerance['kind'];

interface DrawingDimensionBase extends DrawingAnnotationBase {
  viewId: DrawingViewId;
  /** Decimal places shown, trailing zeros trimmed; absent uses the units' default. */
  decimals?: number;
  /**
   * v48: a reference dimension, shown in brackets: a value stated for
   * information although others already fix it. Absent is a dimension.
   */
  reference?: true;
  /** v68: the dimension's tolerance; absent states the value alone. */
  tolerance?: DrawingTolerance;
  /** v68: text printed before the value, separated by a space ("4×", "SR"). */
  prefix?: string;
  /** v68: text printed after the value and tolerance, after a space ("TYP"). */
  suffix?: string;
}

export interface DrawingLinearDimension extends DrawingDimensionBase {
  kind: 'linear';
  direction: DrawingLinearDirection;
  from: DrawingPointRef;
  to: DrawingPointRef;
  /** v48: a span across a cylinder seen side-on, labelled Ø. */
  diameter?: true;
}

export interface DrawingRadialDimension extends DrawingDimensionBase {
  kind: 'radius' | 'diameter';
  /** A circular edge seen face-on in the view. */
  edge: DrawingEdgeRef;
  /** v48: how many like features this states, shown "4×". */
  count?: number;
  /**
   * v50: a counterbored hole's callout on a diameter. This is the
   * counterbore's rim, coaxial with `edge` and larger; the callout reads the
   * counterbore's Ø and depth, and the hole's depth or THRU, from the model
   * each time it is drawn ("2× Ø5 THRU, CBORE Ø8 × 1.5 DEEP").
   */
  counterbore?: DrawingEdgeRef;
  /**
   * v51: a countersunk hole's callout on a diameter. This is the
   * countersink cone's outer rim, coaxial with `edge` and larger; the callout
   * reads its Ø and included angle, and the hole's depth or THRU, from the
   * model each time it is drawn ("2× Ø6 THRU, CSK Ø12 × 90°").
   */
  countersink?: DrawingEdgeRef;
  /**
   * v105 (D07): an ISO 286 fit class on a diameter ("H7", "g6"): the
   * diameter prints it with the limit deviations its tables state for the
   * measured size. It replaces a tolerance, and a hole's callout.
   */
  fit?: DrawingFitClass;
  /**
   * v105 (D07): a tapped hole's thread class on its callout: ISO 965
   * ("6H") for a metric thread, UN ("2B") for an inch one, printed after
   * the designation ("M6×1-6H").
   */
  threadClass?: DrawingThreadClass;
}

/**
 * v105: the ISO 286 fit classes a diameter may state: holes F, G, H and JS,
 * shafts f, g, h, js, k, m, n and p, grades 5 to 11, whose limits ISO 286-1
 * tables state without the Δ correction or subdivided size ranges.
 */
export const DRAWING_FIT_CLASS_PATTERN =
  /^(?:F|G|H|JS|f|g|h|js|k|m|n|p)(?:[5-9]|10|11)$/;
export type DrawingFitClass = string;

/** v105: internal thread classes, ISO 965-1 then UN (ASME B1.1). */
export const DRAWING_THREAD_CLASSES = [
  '4H',
  '5H',
  '6H',
  '7H',
  '8H',
  '4G',
  '5G',
  '6G',
  '7G',
  '8G',
  '1B',
  '2B',
  '3B'
] as const;
export type DrawingThreadClass = (typeof DRAWING_THREAD_CLASSES)[number];

/** v105: ISO 2768-1 linear and angular classes, fine to very coarse. */
export const DRAWING_ISO_LINEAR_CLASSES = ['f', 'm', 'c', 'v'] as const;
export type DrawingIsoLinearClass = (typeof DRAWING_ISO_LINEAR_CLASSES)[number];
/** v105: ISO 2768-2 geometric classes. */
export const DRAWING_ISO_GEOMETRIC_CLASSES = ['H', 'K', 'L'] as const;
export type DrawingIsoGeometricClass =
  (typeof DRAWING_ISO_GEOMETRIC_CLASSES)[number];

/** v105: a stated block's tolerance for values written to `decimals` places. */
export interface DrawingDecimalTolerance {
  decimals: number;
  /** ± amount, in the units the sheet prints in. */
  amount: number;
}

/**
 * v105 (D07): the sheet's general tolerances, a ruled block on the paper
 * that states what an untoleranced dimension may deviate: ISO 2768-1 class
 * (`linearClass`, with an ISO 2768-2 `geometricClass`), its table printed
 * from the standard, or (`decimal`) a block stating ± per number of
 * decimals written and for angles, as a title block's tolerance box does.
 */
export type DrawingGeneralTolerance = DrawingAnnotationBase & {
  kind: 'general-tolerance';
  /** On the paper, never in a view: the validator refuses one. */
  viewId?: DrawingViewId;
} & (
    | {
        scheme: 'iso-2768';
        linearClass: DrawingIsoLinearClass;
        geometricClass?: DrawingIsoGeometricClass;
      }
    | {
        scheme: 'decimal';
        places: DrawingDecimalTolerance[];
        /** ± on angles, degrees. */
        angle?: number;
      }
  );

/**
 * v49: a revolved blend's radius, read from its torus face seen side-on,
 * where it draws as two arcs of its tube; `side` picks the one at the
 * axis's extreme on that side across the page. No edge states it: the
 * blend's boundary circles are its tangent lines, not its radius.
 */
export interface DrawingBlendRadiusDimension extends DrawingDimensionBase {
  kind: 'radius';
  face: DrawingFaceRef;
  side: DrawingExtremeSide;
  count?: number;
}

/**
 * v48: a chamfer stated as `size × angle`. The face is a cone about the
 * part's axis or a plane, seen side-on or edge-on in the view. Its two ends
 * are its virtual sharps with the faces either side (through any blend), so
 * a blended chamfer reads the same as a sharp one: on a cone the size is
 * its length along the axis and the angle its half-angle; on a plane the
 * size is its leg along the neighbour it makes the smaller angle with, and
 * the angle is that one.
 */
export interface DrawingChamferDimension extends DrawingDimensionBase {
  kind: 'chamfer';
  face: DrawingFaceRef;
  count?: number;
}

export interface DrawingAngleDimension extends DrawingDimensionBase {
  kind: 'angle';
  /** Two straight edges; the angle is the one between their far ends. */
  edges: [DrawingEdgeRef, DrawingEdgeRef];
  /**
   * v51: the outside angle. The ray of `edges[outside]` runs from the vertex
   * along that edge's line away from it, so the dimension states the
   * supplement (45° beside a 135° corner) on an extension line, off the part.
   */
  outside?: 0 | 1;
}

export interface DrawingNote extends DrawingAnnotationBase {
  kind: 'note';
  text: string;
  /** The view the note belongs to; absent for a note placed on the paper. */
  viewId?: DrawingViewId;
  /** An edge of that view the note's leader arrow points at. */
  leader?: DrawingEdgeRef;
}

/**
 * v73: a centre mark on a circle or arc the view sees face-on: a cross at
 * its centre with centre lines run past its rim.
 */
export interface DrawingCenterMark extends DrawingAnnotationBase {
  kind: 'center-mark';
  viewId: DrawingViewId;
  edge: DrawingEdgeRef;
}

/**
 * v73: where two straight edges' lines cross in the view (a virtual sharp
 * of a rounded or chamfered corner), drawn as their thin extensions.
 */
export interface DrawingIntersectionMark extends DrawingAnnotationBase {
  kind: 'intersection-mark';
  viewId: DrawingViewId;
  edges: [DrawingEdgeRef, DrawingEdgeRef];
}

/**
 * v73: a centreline, drawn as a thin chain line: through two points
 * (`points`), midway between two parallel straight edges (`lines`), or the
 * circle through three points (`circle`, a bolt circle through three hole
 * centres).
 */
export type DrawingCenterline = DrawingAnnotationBase & {
  kind: 'centerline';
  viewId: DrawingViewId;
} & (
    | { mode: 'points'; from: DrawingPointRef; to: DrawingPointRef }
    | { mode: 'lines'; edges: [DrawingEdgeRef, DrawingEdgeRef] }
    | {
        mode: 'circle';
        through: [DrawingPointRef, DrawingPointRef, DrawingPointRef];
      }
  );

/**
 * v75: what a distance dimension measures from or to: a point (an edge end,
 * a circle's centre or a mark), a straight edge seen true length, a
 * `points` or `lines` centreline of the same view, or a circle seen face-on
 * (its centre, or with `extent` its near or far side).
 */
export type DrawingDistanceTarget =
  | { point: DrawingPointRef }
  | { line: DrawingEdgeRef }
  | { centerline: DrawingAnnotationId }
  | { circle: DrawingEdgeRef };

/**
 * v75: the distance between two targets in the view, measured square to a
 * line when there is one, else along the line between the two. `extent`
 * measures to each circle's near (`min`) or far (`max`) side instead of its
 * centre: two holes' wall gap, or their overall span.
 */
export interface DrawingDistanceDimension extends DrawingDimensionBase {
  kind: 'distance';
  from: DrawingDistanceTarget;
  to: DrawingDistanceTarget;
  extent?: 'min' | 'max';
}

/**
 * v82: an arc's included angle, at its centre between its two ends. The
 * edge is a circular arc the view sees face-on; the angle may pass 180°.
 */
export interface DrawingArcAngleDimension extends DrawingDimensionBase {
  kind: 'arc-angle';
  edge: DrawingEdgeRef;
}

/**
 * v82: the angle at `vertex` between the lines to `from` and to `to` (at
 * most 180°). Each point is an edge end, a circle's centre or a mark.
 */
export interface DrawingThreePointAngleDimension extends DrawingDimensionBase {
  kind: 'three-point-angle';
  vertex: DrawingPointRef;
  from: DrawingPointRef;
  to: DrawingPointRef;
}

/** v80: the BOM columns a parts list may show, by their CSV key. */
export const DRAWING_BOM_COLUMN_KEYS = [
  'item',
  'quantity',
  'part',
  'instances',
  'source_body',
  'status'
] as const;
export type DrawingBomColumnKey = (typeof DRAWING_BOM_COLUMN_KEYS)[number];

/**
 * v80: the assembly's parts list on the paper, its top-left corner at
 * `placementMm`. Rows, cells and item numbers come from the AS03 BOM table
 * each time the sheet is drawn; only the choice and order of columns is
 * stored (absent: item, quantity and part).
 */
export interface DrawingBomTable extends DrawingAnnotationBase {
  kind: 'bom-table';
  /** On the paper, never in a view: the validator refuses one. */
  viewId?: DrawingViewId;
  columns?: DrawingBomColumnKey[];
}

/**
 * v80: a balloon naming the item number of the part an edge belongs to,
 * with a leader to that edge. `componentId` is the assembly component the
 * edge was picked on; its row's item number is read from the BOM table each
 * time the sheet is drawn, so it follows the table's numbering.
 */
export interface DrawingBalloon extends DrawingAnnotationBase {
  kind: 'balloon';
  viewId: DrawingViewId;
  leader: DrawingEdgeRef;
  componentId: string;
}

/**
 * v92: a picture on the paper (a logo, a photograph of the part, a sketch
 * from the shop): one of the project's reference images (I05), named by
 * its id, so the pixels stay in the content-addressed store and travel the
 * way reference images do. `placementMm` is its centre from the paper's
 * corner and `widthMm` its printed width; its height keeps the picture's
 * aspect. A picture deleted from the project leaves the image broken
 * (`image-missing`) until it is pointed at another one or deleted.
 */
export interface DrawingSheetImage extends DrawingAnnotationBase {
  kind: 'image';
  /** On the paper, never in a view: the validator refuses one. */
  viewId?: DrawingViewId;
  referenceImageId: string;
  widthMm: number;
}

/** v92: the narrowest and widest a sheet image prints, paper mm. */
export const MIN_DRAWING_IMAGE_WIDTH_MM = 2;
export const MAX_DRAWING_IMAGE_WIDTH_MM = 1200;

/**
 * v98 (D07): the geometric characteristics a feature control frame states,
 * in the ASME Y14.5-2018 / ISO 1101 order: form, profile, orientation,
 * location, runout. Concentricity and symmetry are ISO 1101's; Y14.5-2018
 * dropped them, so a sheet in that standard states position or profile
 * instead (the UI says so; the schema keeps both).
 */
export const DRAWING_GEOMETRIC_CHARACTERISTICS = [
  'straightness',
  'flatness',
  'circularity',
  'cylindricity',
  'profile-line',
  'profile-surface',
  'parallelism',
  'perpendicularity',
  'angularity',
  'position',
  'concentricity',
  'symmetry',
  'circular-runout',
  'total-runout'
] as const;
export type DrawingGeometricCharacteristic =
  (typeof DRAWING_GEOMETRIC_CHARACTERISTICS)[number];

/** v98: form tolerances, which control a feature alone and take no datum. */
export const DRAWING_FORM_CHARACTERISTICS: readonly DrawingGeometricCharacteristic[] =
  ['straightness', 'flatness', 'circularity', 'cylindricity'];

/**
 * v98: characteristics that are meaningless without a datum: orientation
 * is to a datum, runout about one, and concentricity and symmetry to one.
 */
export const DRAWING_DATUM_REQUIRED_CHARACTERISTICS: readonly DrawingGeometricCharacteristic[] =
  [
    'parallelism',
    'perpendicularity',
    'angularity',
    'concentricity',
    'symmetry',
    'circular-runout',
    'total-runout'
  ];

/**
 * v98: characteristics whose zone may be cylindrical (a Ø before the
 * tolerance): those that can control an axis.
 */
export const DRAWING_DIAMETER_ZONE_CHARACTERISTICS: readonly DrawingGeometricCharacteristic[] =
  [
    'straightness',
    'parallelism',
    'perpendicularity',
    'angularity',
    'position',
    'concentricity'
  ];

/**
 * v98: characteristics whose tolerance may carry a material condition
 * modifier (Ⓜ, Ⓛ): those that may apply to a feature of size and are not
 * defined regardless of feature size by the standard.
 */
export const DRAWING_MATERIAL_CHARACTERISTICS: readonly DrawingGeometricCharacteristic[] =
  ['straightness', 'parallelism', 'perpendicularity', 'angularity', 'position'];

/** v98: characteristics whose datum references may carry Ⓜ or Ⓛ. */
export const DRAWING_DATUM_MATERIAL_CHARACTERISTICS: readonly DrawingGeometricCharacteristic[] =
  [
    'parallelism',
    'perpendicularity',
    'angularity',
    'position',
    'profile-line',
    'profile-surface'
  ];

/** v98: maximum (Ⓜ) or least (Ⓛ) material condition. */
export type DrawingMaterialCondition = 'mmc' | 'lmc';

/** v98: a datum reference in a frame: its letter and an optional modifier. */
export interface DrawingDatumReference {
  letter: string;
  material?: DrawingMaterialCondition;
}

/**
 * v98: datum letters. Both standards skip I, O and Q (they read as 1, 0
 * and a circle); after Z, letters double (AA, AB, …).
 */
export const DRAWING_DATUM_LETTER_PATTERN = /^[A-HJ-NPR-Z]{1,2}$/;

/** v98: a frame names a primary, secondary and tertiary datum at most. */
export const MAX_DRAWING_DATUM_REFERENCES = 3;

/**
 * v98: what a datum symbol or frame applies to. A leader to an edge points
 * at a surface (seen edge-on) or a feature's outline; `attachedTo` names
 * the dimension of a feature of size (a frame below its value, a datum
 * symbol on it) or, for a datum symbol, the frame it hangs from. Exactly
 * one of the two is stored; the host is on the same view, and a missing
 * one leaves the annotation broken (`host-missing`), never reattached.
 */
interface DrawingToleranceAnnotationBase extends DrawingAnnotationBase {
  viewId: DrawingViewId;
  leader?: DrawingEdgeRef;
  attachedTo?: DrawingAnnotationId;
}

/** v98: a datum feature symbol: its letter in a frame, on a triangle. */
export interface DrawingDatumFeature extends DrawingToleranceAnnotationBase {
  kind: 'datum-feature';
  letter: string;
}

/**
 * v98: a feature control frame: the characteristic's symbol, the tolerance
 * (a cylindrical zone's Ø, then the amount and any material modifier),
 * then up to three datum references in order of precedence. `amount`, the
 * tolerance zone's size, is in the units the sheet prints in, like a
 * dimension's tolerance.
 */
export interface DrawingFeatureControlFrame extends DrawingToleranceAnnotationBase {
  kind: 'feature-control-frame';
  characteristic: DrawingGeometricCharacteristic;
  amount: number;
  diameterZone?: true;
  material?: DrawingMaterialCondition;
  datums?: DrawingDatumReference[];
}

/** v98: the geometric tolerancing annotations. */
export type DrawingToleranceAnnotation =
  DrawingDatumFeature | DrawingFeatureControlFrame;

export function isDrawingToleranceAnnotation(
  annotation: DrawingAnnotation
): annotation is DrawingToleranceAnnotation {
  return (
    annotation.kind === 'datum-feature' ||
    annotation.kind === 'feature-control-frame'
  );
}

/**
 * v98: the annotation kinds each tolerancing kind may attach to: a frame to
 * a dimension; a datum symbol to a dimension or a frame. A datum symbol is
 * never a host, so attachments nest at most two deep and never cycle.
 */
export function drawingToleranceHostAllowed(
  kind: DrawingToleranceAnnotation['kind'],
  host: DrawingAnnotation
): boolean {
  if (isDrawingDimension(host)) return true;
  return kind === 'datum-feature' && host.kind === 'feature-control-frame';
}

/** v73: the annotations that mark geometry rather than state a value. */
export type DrawingGeometryAnnotation =
  DrawingCenterMark | DrawingIntersectionMark | DrawingCenterline;

export const DRAWING_GEOMETRY_ANNOTATION_KINDS: readonly DrawingGeometryAnnotation['kind'][] =
  ['center-mark', 'intersection-mark', 'centerline'];

export function isDrawingGeometryAnnotation(
  annotation: DrawingAnnotation
): annotation is DrawingGeometryAnnotation {
  return (
    annotation.kind === 'center-mark' ||
    annotation.kind === 'intersection-mark' ||
    annotation.kind === 'centerline'
  );
}

/** Whether `annotation` states a value: not a note, not a mark. */
export function isDrawingDimension(
  annotation: DrawingAnnotation
): annotation is DrawingDimension {
  return (
    annotation.kind !== 'note' &&
    annotation.kind !== 'bom-table' &&
    annotation.kind !== 'balloon' &&
    annotation.kind !== 'image' &&
    annotation.kind !== 'datum-feature' &&
    annotation.kind !== 'feature-control-frame' &&
    annotation.kind !== 'general-tolerance' &&
    !isDrawingGeometryAnnotation(annotation)
  );
}

export type DrawingDimension =
  | DrawingDistanceDimension
  | DrawingLinearDimension
  | DrawingRadialDimension
  | DrawingBlendRadiusDimension
  | DrawingAngleDimension
  | DrawingArcAngleDimension
  | DrawingThreePointAngleDimension
  | DrawingChamferDimension;

export type DrawingAnnotation =
  | DrawingDimension
  | DrawingNote
  | DrawingGeometryAnnotation
  | DrawingBomTable
  | DrawingBalloon
  | DrawingSheetImage
  | DrawingToleranceAnnotation
  | DrawingGeneralTolerance;

export type DrawingAnnotationKind = DrawingAnnotation['kind'];

export const MAX_DRAWING_ANNOTATIONS = 500;
export const MAX_DRAWING_NOTE_LENGTH = 200;
export const MAX_DRAWING_DIMENSION_DECIMALS = 6;
/** A count is at least two like features; the bound keeps it a label. */
export const MAX_DRAWING_DIMENSION_COUNT = 999;
/** v68: a prefix or suffix is a short label, not a note. */
export const MAX_DRAWING_DIMENSION_AFFIX_LENGTH = 40;
/** v68: a tolerance's deviations, in document units or degrees. */
export const MAX_DRAWING_TOLERANCE = 1e6;
const MAX_REQUIREMENT_LENGTH = 200;
/** Placement bound, in paper millimetres. */
const MAX_PLACEMENT_MM = 10_000;
/** A stored edge reference's witness is small; this bounds a hostile one. */
/**
 * A stored edge reference's whole size, lineage name included. The kernel
 * names an edge that survives booleans by prefixing its source's name, so
 * names have no length of their own to bound; this budget does it once. A
 * reference over it is stored hash-only instead (see `drawingEdgeRefError`).
 */
const MAX_REFERENCE_JSON_LENGTH = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isShortText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** ADR-011 fingerprints are positive safe integers. */
function isTopologyHash(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isQuantizedPoint(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((coordinate) => Number.isSafeInteger(coordinate))
  );
}

/** Lexicographic order of two quantized points. */
function comparePoints(left: number[], right: number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Whether `value` is a canonical `EdgeWitnessV1`: the shape and every rule
 * the kernel adapter's witness inspection calls invalid (a non-empty curve
 * type, a non-negative quantized length, quantized points, open endpoints
 * in lexicographic order, a non-zero sign-canonical closed axis). Its hash
 * is checked where the fingerprint lives, when the annotation resolves.
 */
function isEdgeWitness(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.curveType !== 'string' ||
    value.curveType.trim().length === 0 ||
    value.curveType.length > 64 ||
    !Number.isSafeInteger(value.length) ||
    (value.length as number) < 0
  )
    return false;
  if (value.closed === false)
    return (
      Array.isArray(value.endpoints) &&
      value.endpoints.length === 2 &&
      value.endpoints.every(isQuantizedPoint) &&
      isQuantizedPoint(value.midpoint) &&
      comparePoints(
        value.endpoints[0] as number[],
        value.endpoints[1] as number[]
      ) <= 0
    );
  if (value.closed === true) {
    if (!isQuantizedPoint(value.center)) return false;
    if (value.axis === null) return true;
    if (!isQuantizedPoint(value.axis)) return false;
    const first = (value.axis as number[]).find((component) => component !== 0);
    return first !== undefined && first > 0;
  }
  return false;
}

const CLOSURES: readonly unknown[] = ['open', 'closed', 'unknown'];

/**
 * Whether `value` is a well-formed `FaceWitnessV1`: a non-empty surface
 * type, a non-negative quantized perimeter, a quantized centroid or null,
 * one of the analytic carrier terms, and a closure per direction. Its hash
 * is checked when the annotation resolves, as an edge witness's is.
 */
function isFaceWitness(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.surfaceType !== 'string' ||
    value.surfaceType.trim().length === 0 ||
    value.surfaceType.length > 64 ||
    !Number.isSafeInteger(value.perimeter) ||
    (value.perimeter as number) < 0 ||
    (value.centroid !== null && !isQuantizedPoint(value.centroid)) ||
    !isRecord(value.closure) ||
    !CLOSURES.includes(value.closure.u) ||
    !CLOSURES.includes(value.closure.v)
  )
    return false;
  const analytic = value.analytic;
  if (!isRecord(analytic)) return false;
  switch (analytic.kind) {
    case 'none':
      return true;
    case 'plane':
      return (
        isQuantizedPoint(analytic.normal) &&
        Number.isSafeInteger(analytic.offset)
      );
    case 'cylinder':
      return (
        isQuantizedPoint(analytic.axis) &&
        isQuantizedPoint(analytic.axisFoot) &&
        Number.isSafeInteger(analytic.radius) &&
        (analytic.radius as number) >= 0
      );
    default:
      return false;
  }
}

function topologyReferenceError(
  value: unknown,
  hash: number,
  kind: 'edge' | 'face'
): string | null {
  if (!isRecord(value) || value.kind !== kind)
    return `is not ${kind === 'edge' ? 'an edge' : 'a face'} reference`;
  if (
    !isShortText(value.producingFeatureId, 128) ||
    typeof value.lineageName !== 'string' ||
    value.lineageName.length === 0 ||
    !isTopologyHash(value.currentHash) ||
    value.witnessVersion !== 1 ||
    !(kind === 'edge' ? isEdgeWitness : isFaceWitness)(value.witness)
  )
    return `has a malformed ${kind} reference`;
  if (JSON.stringify(value).length > MAX_REFERENCE_JSON_LENGTH)
    return `has an oversized ${kind} reference`;
  // The reference names the edge the hash fingerprints; one that disagrees
  // would resolve by its lineage to some other edge.
  if (value.currentHash !== hash)
    return `has ${kind === 'edge' ? 'an edge' : 'a face'} reference that contradicts its hash`;
  return null;
}

/**
 * Why `ref` would be refused in a stored annotation, or null. A picker uses
 * it to keep a pick hash-only rather than write a reference the document
 * cannot hold.
 */
export function drawingEdgeRefError(ref: DrawingEdgeRef): string | null {
  return edgeRefError(ref);
}

/** {@link drawingEdgeRefError} for a picked face. */
export function drawingFaceRefError(ref: DrawingFaceRef): string | null {
  return topologyRefError(ref, 'face');
}

function edgeRefError(value: unknown): string | null {
  return topologyRefError(value, 'edge');
}

function topologyRefError(
  value: unknown,
  kind: 'edge' | 'face'
): string | null {
  if (!isRecord(value)) return `names no ${kind}`;
  if (!isShortText(value.bodyId, 128)) return 'names no body';
  if (!isTopologyHash(value.hash)) return `has an invalid ${kind} hash`;
  if (value.reference !== undefined)
    return topologyReferenceError(value.reference, value.hash, kind);
  return null;
}

function pointRefError(value: unknown): string | null {
  if (!isRecord(value)) return 'names no point';
  switch (value.anchor) {
    case 'first':
    case 'second':
    case 'center':
      if ('side' in value) return 'has a side on a point that takes none';
      return edgeRefError(value.edge);
    case 'silhouette':
      if (value.side !== 'low' && value.side !== 'high')
        return 'has an unknown extreme side';
      return edgeRefError(value.edge);
    case 'virtual-sharp': {
      if (value.side !== 'low' && value.side !== 'high')
        return 'has an unknown extreme side';
      const faces = value.faces;
      if (!Array.isArray(faces) || faces.length !== 2)
        return 'needs two faces for a virtual sharp';
      const error =
        topologyRefError(faces[0], 'face') ??
        topologyRefError(faces[1], 'face');
      if (error) return error;
      const [a, b] = faces as DrawingFaceRef[];
      if (a!.bodyId === b!.bodyId && a!.hash === b!.hash)
        return 'needs two different faces for a virtual sharp';
      return null;
    }
    case 'chamfer-corner': {
      if (value.side !== 'low' && value.side !== 'high')
        return 'has an unknown extreme side';
      const error =
        topologyRefError(value.face, 'face') ??
        topologyRefError(value.like, 'face');
      if (error) return error;
      const face = value.face as DrawingFaceRef;
      const like = value.like as DrawingFaceRef;
      if (face.bodyId !== like.bodyId)
        return 'sizes a chamfer corner like a chamfer on another body';
      if (face.hash === like.hash) return 'sizes a chamfer corner like itself';
      return null;
    }
    case 'mark':
      if (Object.keys(value).length !== 2)
        return 'has a mark point with unknown fields';
      return typeof value.annotationId === 'string' &&
        value.annotationId.startsWith(DRAWING_ANNOTATION_ID_PREFIX) &&
        value.annotationId.length <= 64
        ? null
        : 'names no mark';
    default:
      return 'has an unknown point anchor';
  }
}

/** Why `value` is not a stored {@link DrawingDistanceTarget}, or null. */
function distanceTargetError(value: unknown): string | null {
  if (!isRecord(value) || Object.keys(value).length !== 1)
    return 'names a distance target that is not one point, line, centreline or circle';
  if ('point' in value) return centerlinePointError(value.point);
  if ('line' in value) return edgeRefError(value.line);
  if ('circle' in value) return edgeRefError(value.circle);
  if ('centerline' in value)
    return typeof value.centerline === 'string' &&
      value.centerline.startsWith(DRAWING_ANNOTATION_ID_PREFIX) &&
      value.centerline.length <= 64
      ? null
      : 'names no centreline';
  return 'names a distance target that is not one point, line, centreline or circle';
}

/** v75: the edges and faces a distance target refers to. */
function distanceTargetReferences(
  target: DrawingDistanceTarget
): (DrawingEdgeRef | DrawingFaceRef)[] {
  if ('point' in target) return pointReferences(target.point);
  if ('line' in target) return [target.line];
  if ('circle' in target) return [target.circle];
  return [];
}

/** A point a centreline may pass through: an end, a centre or a mark. */
function centerlinePointError(value: unknown): string | null {
  const error = pointRefError(value);
  if (error) return error;
  const anchor = (value as DrawingPointRef).anchor;
  return anchor === 'first' ||
    anchor === 'second' ||
    anchor === 'center' ||
    anchor === 'mark'
    ? null
    : 'passes a centreline through an extreme, which has no place without a direction';
}

/** Absent, or the literal `true`: a stored `false` would not be byte-stable. */
function isFlag(value: unknown): boolean {
  return value === undefined || value === true;
}

function countError(value: unknown, kind: unknown, where: string) {
  if (value === undefined) return null;
  if (kind !== 'radius' && kind !== 'diameter' && kind !== 'chamfer')
    return `${where} has a count, which only radius, diameter and chamfer dimensions take.`;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 2 ||
    (value as number) > MAX_DRAWING_DIMENSION_COUNT
  )
    return `${where} counts from 2 to ${MAX_DRAWING_DIMENSION_COUNT} features.`;
  return null;
}

/**
 * A tolerance amount: finite, bounded, and stated to at most
 * {@link MAX_DRAWING_DIMENSION_DECIMALS} decimals, the most a label prints.
 * A finer amount would print as zero (`±0.000000`), or limits as two equal
 * bounds, while the sheet stores a tolerance.
 */
function isDeviation(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= MAX_DRAWING_TOLERANCE &&
    Math.abs(Number(value.toFixed(MAX_DRAWING_DIMENSION_DECIMALS)) - value) <=
      1e-9 * Math.max(1, Math.abs(value))
  );
}

/** Why `value` is not a stored {@link DrawingTolerance}, or null. */
export function drawingToleranceError(value: unknown): string | null {
  if (!isRecord(value)) return 'has a tolerance that is not a record';
  switch (value.kind) {
    case 'symmetric':
      if (Object.keys(value).length !== 2)
        return 'has a symmetric tolerance with unknown fields';
      return isDeviation(value.value) && value.value > 0
        ? null
        : 'has a symmetric tolerance that is not a positive amount of at most six decimals';
    case 'deviation':
    case 'limits':
      if (Object.keys(value).length !== 3)
        return `has a ${value.kind} tolerance with unknown fields`;
      if (!isDeviation(value.upper) || !isDeviation(value.lower))
        return `has a ${value.kind} tolerance with an invalid deviation (finite, at most six decimals)`;
      return value.upper > value.lower
        ? null
        : `has a ${value.kind} tolerance whose upper deviation is not above its lower`;
    case 'basic':
      return Object.keys(value).length === 1
        ? null
        : 'has a basic tolerance with unknown fields';
    default:
      return 'has an unknown tolerance kind';
  }
}

/** A prefix or suffix: printable, trimmed, one line, short. */
function affixError(value: unknown, name: string): string | null {
  if (value === undefined) return null;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_DRAWING_DIMENSION_AFFIX_LENGTH ||
    value.trim() !== value ||
    [...value].some((char) => char < ' ' || char === '\u007f')
  )
    return `has a ${name} that is not one trimmed line of at most ${MAX_DRAWING_DIMENSION_AFFIX_LENGTH} characters`;
  return null;
}

const DATUM_FEATURE_KEYS = new Set([
  'annotationId',
  'kind',
  'placementMm',
  'viewId',
  'leader',
  'attachedTo',
  'letter'
]);
const FEATURE_CONTROL_FRAME_KEYS = new Set([
  'annotationId',
  'kind',
  'placementMm',
  'viewId',
  'leader',
  'attachedTo',
  'characteristic',
  'amount',
  'diameterZone',
  'material',
  'datums'
]);

function isMaterialCondition(value: unknown): boolean {
  return value === 'mmc' || value === 'lmc';
}

/** v105: a diameter's fit or thread class, or why it is malformed. */
function fitError(
  value: Record<string, unknown>,
  where: string
): string | null {
  if (value.kind !== 'diameter' || value.edge === undefined)
    return `${where} states a fit or thread class, which only a diameter of a circular edge takes.`;
  if (value.fit !== undefined) {
    if (
      typeof value.fit !== 'string' ||
      !DRAWING_FIT_CLASS_PATTERN.test(value.fit)
    )
      return `${where} states a fit other than an ISO 286 hole F, G, H or JS or shaft f, g, h, js, k, m, n or p class, grade 5 to 11.`;
    if (value.tolerance !== undefined)
      return `${where} states both a fit and a tolerance; the fit is its tolerance.`;
    if (value.reference !== undefined)
      return `${where} is a reference dimension, which takes no fit.`;
    if (value.threadClass !== undefined)
      return `${where} states both a fit and a thread class.`;
  }
  if (value.threadClass !== undefined) {
    if (
      !(DRAWING_THREAD_CLASSES as readonly unknown[]).includes(
        value.threadClass
      )
    )
      return `${where} states a thread class other than an ISO 965 internal (4H–8H, 4G–8G) or UN internal (1B–3B) class.`;
    if (value.tolerance !== undefined)
      return `${where} states a thread class on a toleranced diameter, which shows no callout.`;
  }
  if (value.counterbore !== undefined || value.countersink !== undefined)
    return `${where} is a counterbore or countersink callout, which takes no fit or thread class.`;
  return null;
}

const GENERAL_TOLERANCE_KEYS: Readonly<Record<string, readonly string[]>> = {
  'iso-2768': ['linearClass', 'geometricClass'],
  decimal: ['places', 'angle']
};

/** v105: why a general-tolerance block is malformed, or null. */
function generalToleranceError(
  value: Record<string, unknown>,
  where: string
): string | null {
  const own = GENERAL_TOLERANCE_KEYS[value.scheme as string];
  if (!own)
    return `${where} is a general-tolerance block with an unknown scheme.`;
  const extra = Object.keys(value).find(
    (key) =>
      !['annotationId', 'kind', 'placementMm', 'scheme', ...own].includes(key)
  );
  if (extra !== undefined)
    return `${where} is a general-tolerance block, which has no ${extra}.`;
  if (value.scheme === 'iso-2768') {
    if (
      !(DRAWING_ISO_LINEAR_CLASSES as readonly unknown[]).includes(
        value.linearClass
      )
    )
      return `${where} names an ISO 2768-1 class other than f, m, c or v.`;
    if (
      value.geometricClass !== undefined &&
      !(DRAWING_ISO_GEOMETRIC_CLASSES as readonly unknown[]).includes(
        value.geometricClass
      )
    )
      return `${where} names an ISO 2768-2 class other than H, K or L.`;
    return null;
  }
  const places = value.places;
  if (!Array.isArray(places) || places.length === 0 || places.length > 4)
    return `${where} states one to four decimal-place tolerances.`;
  const seen = new Set<number>();
  for (const place of places as unknown[]) {
    if (
      !isRecord(place) ||
      Object.keys(place).length !== 2 ||
      !Number.isSafeInteger(place.decimals) ||
      (place.decimals as number) < 0 ||
      (place.decimals as number) > 4 ||
      !isDeviation(place.amount) ||
      place.amount <= 0
    )
      return `${where} states a decimal-place tolerance that is not 0–4 places and a positive amount of at most six decimals.`;
    if (seen.has(place.decimals as number))
      return `${where} states ${place.decimals as number} decimal places twice.`;
    seen.add(place.decimals as number);
  }
  if (
    value.angle !== undefined &&
    (!isDeviation(value.angle) || value.angle <= 0 || value.angle >= 90)
  )
    return `${where} states an angle tolerance that is not a positive amount under 90°.`;
  return null;
}

/** v98: why a datum symbol or frame is malformed, or null. */
function toleranceAnnotationError(
  value: Record<string, unknown>,
  where: string
): string | null {
  const datum = value.kind === 'datum-feature';
  const name = datum ? 'datum feature symbol' : 'feature control frame';
  const known = datum ? DATUM_FEATURE_KEYS : FEATURE_CONTROL_FRAME_KEYS;
  const extra = Object.keys(value).find((key) => !known.has(key));
  if (extra !== undefined)
    return `${where} is a ${name}, which has no ${extra}.`;
  if (value.viewId === undefined)
    return `${where} is a ${name} that belongs to no view.`;
  if ((value.leader === undefined) === (value.attachedTo === undefined))
    return `${where} is a ${name} that needs either a leader to an edge or a dimension to attach to, not both.`;
  if (value.leader !== undefined) {
    const error = edgeRefError(value.leader);
    if (error) return `${where} ${error}.`;
  }
  if (
    value.attachedTo !== undefined &&
    (typeof value.attachedTo !== 'string' ||
      !value.attachedTo.startsWith(DRAWING_ANNOTATION_ID_PREFIX) ||
      value.attachedTo.length > 64 ||
      value.attachedTo === value.annotationId)
  )
    return `${where} is a ${name} attached to an invalid annotation id.`;
  if (datum) {
    if (
      typeof value.letter !== 'string' ||
      !DRAWING_DATUM_LETTER_PATTERN.test(value.letter)
    )
      return `${where} is a datum feature symbol whose letter is not one or two capitals other than I, O and Q.`;
    return null;
  }
  const characteristic = value.characteristic as DrawingGeometricCharacteristic;
  if (!DRAWING_GEOMETRIC_CHARACTERISTICS.includes(characteristic))
    return `${where} is a feature control frame with an unknown characteristic.`;
  if (!isDeviation(value.amount) || value.amount <= 0)
    return `${where} is a feature control frame whose tolerance is not a positive amount of at most six decimals.`;
  if (value.diameterZone !== undefined) {
    if (value.diameterZone !== true)
      return `${where} is a feature control frame with a malformed Ø zone.`;
    if (!DRAWING_DIAMETER_ZONE_CHARACTERISTICS.includes(characteristic))
      return `${where} states ${characteristic} in a cylindrical (Ø) zone, which it cannot have.`;
  }
  if (value.material !== undefined) {
    if (!isMaterialCondition(value.material))
      return `${where} is a feature control frame with an unknown material condition.`;
    if (!DRAWING_MATERIAL_CHARACTERISTICS.includes(characteristic))
      return `${where} modifies ${characteristic} by a material condition, which it cannot take.`;
  }
  const datums = value.datums;
  if (datums !== undefined) {
    if (
      !Array.isArray(datums) ||
      datums.length === 0 ||
      datums.length > MAX_DRAWING_DATUM_REFERENCES
    )
      return `${where} is a feature control frame with other than one to ${MAX_DRAWING_DATUM_REFERENCES} datum references.`;
    const letters = new Set<string>();
    for (const reference of datums as unknown[]) {
      if (
        !isRecord(reference) ||
        typeof reference.letter !== 'string' ||
        !DRAWING_DATUM_LETTER_PATTERN.test(reference.letter) ||
        Object.keys(reference).some(
          (key) => key !== 'letter' && key !== 'material'
        )
      )
        return `${where} is a feature control frame with a malformed datum reference.`;
      if (letters.has(reference.letter))
        return `${where} references datum ${reference.letter} twice.`;
      letters.add(reference.letter);
      if (reference.material !== undefined) {
        if (!isMaterialCondition(reference.material))
          return `${where} is a feature control frame with an unknown datum material condition.`;
        if (!DRAWING_DATUM_MATERIAL_CHARACTERISTICS.includes(characteristic))
          return `${where} modifies a datum of ${characteristic} by a material condition, which it cannot take.`;
      }
    }
  }
  if (
    datums !== undefined &&
    DRAWING_FORM_CHARACTERISTICS.includes(characteristic)
  )
    return `${where} states ${characteristic}, a form tolerance, which takes no datum.`;
  if (
    datums === undefined &&
    DRAWING_DATUM_REQUIRED_CHARACTERISTICS.includes(characteristic)
  )
    return `${where} states ${characteristic}, which needs at least one datum.`;
  return null;
}

/**
 * Why `value` is not a valid annotation of a sheet whose views are
 * `viewIds`, or null. Shape only: the edges may be gone from the model.
 */
export function drawingAnnotationError(
  value: unknown,
  viewIds: ReadonlySet<string>,
  where: string
): string | null {
  if (!isRecord(value)) return `${where} is not an annotation record.`;
  if (
    typeof value.annotationId !== 'string' ||
    !value.annotationId.startsWith(DRAWING_ANNOTATION_ID_PREFIX) ||
    value.annotationId.length > 64
  )
    return `${where} has an invalid id.`;
  const placement = value.placementMm;
  if (
    !isRecord(placement) ||
    ![placement.x, placement.y].every(
      (coordinate) =>
        typeof coordinate === 'number' &&
        Number.isFinite(coordinate) &&
        Math.abs(coordinate) <= MAX_PLACEMENT_MM
    )
  )
    return `${where} has an invalid placement.`;
  if (value.viewId !== undefined && !viewIds.has(value.viewId as string))
    return `${where} belongs to a view that is not on its sheet.`;
  const fail = (error: string | null) =>
    error === null ? null : `${where} ${error}.`;
  if (value.provenance !== undefined) {
    const provenance = value.provenance;
    if (
      !isRecord(provenance) ||
      provenance.generated !== true ||
      !isShortText(provenance.requirement, MAX_REQUIREMENT_LENGTH) ||
      (provenance.basis !== undefined && provenance.basis !== 'geometry') ||
      Object.keys(provenance).length !==
        (provenance.basis === undefined ? 2 : 3)
    )
      return `${where} has malformed provenance.`;
  }
  if (value.kind !== 'linear' && value.diameter !== undefined)
    return `${where} has a Ø prefix, which only a linear dimension takes.`;
  const counted = countError(value.count, value.kind, where);
  if (counted) return counted;
  if (value.kind === 'image') {
    if (
      [
        'decimals',
        'reference',
        'tolerance',
        'prefix',
        'suffix',
        'provenance'
      ].some((key) => value[key] !== undefined)
    )
      return `${where} is an image, which states no measured value.`;
    if (value.viewId !== undefined)
      return `${where} is an image, which sits on the paper, not in a view.`;
    if (
      !isShortText(value.referenceImageId, 128) ||
      !value.referenceImageId.startsWith('rimg_')
    )
      return `${where} is an image that names no reference image.`;
    if (
      typeof value.widthMm !== 'number' ||
      !Number.isFinite(value.widthMm) ||
      value.widthMm < MIN_DRAWING_IMAGE_WIDTH_MM ||
      value.widthMm > MAX_DRAWING_IMAGE_WIDTH_MM
    )
      return `${where} is an image ${MIN_DRAWING_IMAGE_WIDTH_MM}–${MAX_DRAWING_IMAGE_WIDTH_MM} mm wide at most.`;
    return null;
  }
  if (value.kind === 'datum-feature' || value.kind === 'feature-control-frame')
    return toleranceAnnotationError(value, where);
  if (value.kind === 'general-tolerance')
    return generalToleranceError(value, where);
  if (value.fit !== undefined || value.threadClass !== undefined) {
    const error = fitError(value, where);
    if (error) return error;
  }
  if (value.kind === 'bom-table' || value.kind === 'balloon') {
    if (
      [
        'decimals',
        'reference',
        'tolerance',
        'prefix',
        'suffix',
        'provenance'
      ].some((key) => value[key] !== undefined)
    )
      return `${where} is a ${value.kind === 'balloon' ? 'balloon' : 'parts list'}, which states no measured value.`;
    if (value.kind === 'bom-table') {
      if (value.viewId !== undefined)
        return `${where} is a parts list, which sits on the paper, not in a view.`;
      if (value.columns !== undefined) {
        const columns = value.columns;
        if (
          !Array.isArray(columns) ||
          columns.length === 0 ||
          !columns.every((key) =>
            (DRAWING_BOM_COLUMN_KEYS as readonly unknown[]).includes(key)
          ) ||
          new Set(columns).size !== columns.length
        )
          return `${where} lists parts-list columns other than each known BOM column once.`;
      }
      return null;
    }
    if (value.viewId === undefined)
      return `${where} is a balloon that belongs to no view.`;
    if (!isShortText(value.componentId, 128))
      return `${where} is a balloon that names no assembly component.`;
    return fail(edgeRefError(value.leader));
  }
  if (
    value.kind === 'center-mark' ||
    value.kind === 'intersection-mark' ||
    value.kind === 'centerline'
  ) {
    if (value.viewId === undefined)
      return `${where} is a mark that belongs to no view.`;
    if (
      [
        'decimals',
        'reference',
        'tolerance',
        'prefix',
        'suffix',
        'provenance'
      ].some((key) => value[key] !== undefined)
    )
      return `${where} is a mark, which states no value.`;
    const twoEdges = (edges: unknown) => {
      if (!Array.isArray(edges) || edges.length !== 2)
        return 'must name two edges';
      const error = edgeRefError(edges[0]) ?? edgeRefError(edges[1]);
      if (error) return error;
      const [a, b] = edges as DrawingEdgeRef[];
      return a!.bodyId === b!.bodyId && a!.hash === b!.hash
        ? 'names one edge twice'
        : null;
    };
    switch (value.kind) {
      case 'center-mark':
        return fail(edgeRefError(value.edge));
      case 'intersection-mark':
        return fail(twoEdges(value.edges));
      default:
        switch (value.mode) {
          case 'points':
            return fail(
              centerlinePointError(value.from) ?? centerlinePointError(value.to)
            );
          case 'lines':
            return fail(twoEdges(value.edges));
          case 'circle': {
            const through = value.through;
            if (!Array.isArray(through) || through.length !== 3)
              return `${where} is a circular centreline that must pass through three points.`;
            return fail(
              centerlinePointError(through[0]) ??
                centerlinePointError(through[1]) ??
                centerlinePointError(through[2])
            );
          }
          default:
            return `${where} has an unknown centreline mode.`;
        }
    }
  }
  if (value.kind === 'note') {
    if (value.reference !== undefined)
      return `${where} is a note, which cannot be a reference dimension.`;
    if (
      value.tolerance !== undefined ||
      value.prefix !== undefined ||
      value.suffix !== undefined
    )
      return `${where} is a note, which takes no tolerance, prefix or suffix.`;
    if (
      typeof value.text !== 'string' ||
      value.text.trim().length === 0 ||
      value.text.length > MAX_DRAWING_NOTE_LENGTH
    )
      return `${where} needs text of at most ${MAX_DRAWING_NOTE_LENGTH} characters.`;
    if (value.leader !== undefined) {
      if (value.viewId === undefined)
        return `${where} has a leader but belongs to no view.`;
      return fail(edgeRefError(value.leader));
    }
    return null;
  }
  if (value.viewId === undefined)
    return `${where} is a dimension that belongs to no view.`;
  if (
    value.decimals !== undefined &&
    !(
      Number.isSafeInteger(value.decimals) &&
      (value.decimals as number) >= 0 &&
      (value.decimals as number) <= MAX_DRAWING_DIMENSION_DECIMALS
    )
  )
    return `${where} shows from 0 to ${MAX_DRAWING_DIMENSION_DECIMALS} decimals.`;
  if (!isFlag(value.reference))
    return `${where} marks a reference dimension with anything but true.`;
  if (!isFlag(value.diameter))
    return `${where} marks a Ø prefix with anything but true.`;
  {
    const error =
      affixError(value.prefix, 'prefix') ?? affixError(value.suffix, 'suffix');
    if (error) return fail(error);
  }
  if (value.tolerance !== undefined) {
    if (value.reference !== undefined)
      return `${where} is a reference dimension, which takes no tolerance.`;
    if (
      value.kind === 'chamfer' ||
      value.counterbore !== undefined ||
      value.countersink !== undefined
    )
      return `${where} is a callout, which takes no tolerance.`;
    const error = drawingToleranceError(value.tolerance);
    if (error) return fail(error);
  }
  switch (value.kind) {
    case 'distance': {
      const targets = [value.from, value.to];
      for (const target of targets) {
        const error = distanceTargetError(target);
        if (error) return fail(error);
      }
      if (value.extent !== undefined) {
        if (value.extent !== 'min' && value.extent !== 'max')
          return `${where} has an unknown extent.`;
        if (!targets.some((target) => isRecord(target) && 'circle' in target))
          return `${where} measures to a side of a circle but names none.`;
      }
      return null;
    }
    case 'linear':
      if (
        value.direction !== 'horizontal' &&
        value.direction !== 'vertical' &&
        value.direction !== 'aligned'
      )
        return `${where} has an unknown direction.`;
      {
        const error = pointRefError(value.from) ?? pointRefError(value.to);
        if (error) return fail(error);
      }
      // An extreme is lowest or highest along a page direction; an aligned
      // span has none until both its points are known.
      if (
        value.direction === 'aligned' &&
        [value.from, value.to].some(
          (point) =>
            (point as DrawingPointRef).anchor === 'silhouette' ||
            (point as DrawingPointRef).anchor === 'virtual-sharp' ||
            (point as DrawingPointRef).anchor === 'chamfer-corner'
        )
      )
        return `${where} measures to an extreme, which only a horizontal or vertical dimension can.`;
      return null;
    case 'radius':
    case 'diameter':
      if (value.countersink !== undefined) {
        if (value.kind !== 'diameter')
          return `${where} names a countersink, which only a diameter callout states.`;
        if (value.counterbore !== undefined)
          return `${where} names both a counterbore and a countersink.`;
        if (value.face !== undefined || value.side !== undefined)
          return `${where} names a countersink on a blend face.`;
        const error = edgeRefError(value.countersink);
        if (error) return fail(error);
      }
      if (value.counterbore !== undefined) {
        if (value.kind !== 'diameter')
          return `${where} names a counterbore, which only a diameter callout states.`;
        if (value.face !== undefined || value.side !== undefined)
          return `${where} names a counterbore on a blend face.`;
        const error = edgeRefError(value.counterbore);
        if (error) return fail(error);
      }
      if (value.face !== undefined || value.side !== undefined) {
        if (value.kind !== 'radius')
          return `${where} is a diameter of a blend face, which only a radius states.`;
        if (value.edge !== undefined)
          return `${where} names both an edge and a blend face.`;
        if (value.side !== 'low' && value.side !== 'high')
          return `${where} has an unknown extreme side.`;
        return fail(topologyRefError(value.face, 'face'));
      }
      return fail(edgeRefError(value.edge));
    case 'angle':
      if (!Array.isArray(value.edges) || value.edges.length !== 2)
        return `${where} must name two edges.`;
      if (
        value.outside !== undefined &&
        value.outside !== 0 &&
        value.outside !== 1
      )
        return `${where} turns outward an edge it does not name.`;
      return fail(edgeRefError(value.edges[0]) ?? edgeRefError(value.edges[1]));
    case 'arc-angle':
      return fail(edgeRefError(value.edge));
    case 'three-point-angle':
      return fail(
        centerlinePointError(value.vertex) ??
          centerlinePointError(value.from) ??
          centerlinePointError(value.to)
      );
    case 'chamfer':
      return fail(topologyRefError(value.face, 'face'));
    default:
      return `${where} has an unknown kind.`;
  }
}

function pointReferences(
  point: DrawingPointRef
): (DrawingEdgeRef | DrawingFaceRef)[] {
  if (point.anchor === 'mark') return [];
  if ('faces' in point) return [...point.faces];
  if ('like' in point) return [point.face, point.like];
  return [point.edge];
}

/** Every edge an annotation refers to; faces (a virtual sharp's, a chamfer's, a blend's) are not. */
export function drawingAnnotationEdges(
  annotation: DrawingAnnotation
): DrawingEdgeRef[] {
  switch (annotation.kind) {
    case 'linear':
      return [annotation.from, annotation.to].flatMap((point) =>
        'edge' in point ? [point.edge] : []
      );
    case 'chamfer':
      return [];
    case 'distance':
      // Its points are ends, centres and marks: every reference an edge.
      return [annotation.from, annotation.to].flatMap(
        distanceTargetReferences
      ) as DrawingEdgeRef[];
    case 'centerline':
      return annotation.mode === 'lines'
        ? [...annotation.edges]
        : centerlinePoints(annotation).flatMap((point) =>
            'edge' in point ? [point.edge] : []
          );
    case 'radius':
    case 'diameter':
      return 'face' in annotation
        ? []
        : [
            annotation.edge,
            ...(annotation.counterbore ? [annotation.counterbore] : []),
            ...(annotation.countersink ? [annotation.countersink] : [])
          ];
    default:
      return drawingAnnotationReferences(annotation) as DrawingEdgeRef[];
  }
}

/** The body an annotation measures (its first reference's), if any. */
export function drawingAnnotationBodyId(
  annotation: DrawingAnnotation
): BodyId | null {
  return drawingAnnotationReferences(annotation)[0]?.bodyId ?? null;
}

/** Every edge and face an annotation refers to, each body-scoped. */
export function drawingAnnotationReferences(
  annotation: DrawingAnnotation
): (DrawingEdgeRef | DrawingFaceRef)[] {
  switch (annotation.kind) {
    case 'linear':
      return [
        ...pointReferences(annotation.from),
        ...pointReferences(annotation.to)
      ];
    case 'radius':
    case 'diameter':
      return 'face' in annotation
        ? [annotation.face]
        : [
            annotation.edge,
            ...(annotation.counterbore ? [annotation.counterbore] : []),
            ...(annotation.countersink ? [annotation.countersink] : [])
          ];
    case 'angle':
      return [...annotation.edges];
    case 'arc-angle':
      return [annotation.edge];
    case 'three-point-angle':
      return [annotation.vertex, annotation.from, annotation.to].flatMap(
        pointReferences
      );
    case 'chamfer':
      return [annotation.face];
    case 'note':
      return annotation.leader ? [annotation.leader] : [];
    case 'bom-table':
    case 'image':
    case 'general-tolerance':
      return [];
    case 'balloon':
      return [annotation.leader];
    case 'datum-feature':
    case 'feature-control-frame':
      return annotation.leader ? [annotation.leader] : [];
    case 'distance':
      return [
        ...distanceTargetReferences(annotation.from),
        ...distanceTargetReferences(annotation.to)
      ];
    case 'center-mark':
      return [annotation.edge];
    case 'intersection-mark':
      return [...annotation.edges];
    case 'centerline':
      return annotation.mode === 'lines'
        ? [...annotation.edges]
        : centerlinePoints(annotation).flatMap(pointReferences);
  }
}

/** v73: the points a `points` or `circle` centreline passes through. */
export function centerlinePoints(
  annotation: DrawingCenterline
): DrawingPointRef[] {
  return annotation.mode === 'points'
    ? [annotation.from, annotation.to]
    : annotation.mode === 'circle'
      ? [...annotation.through]
      : [];
}

/** v75: the centrelines a distance dimension measures to, by id. */
export function drawingAnnotationCenterlines(
  annotation: DrawingAnnotation
): DrawingAnnotationId[] {
  return annotation.kind === 'distance'
    ? [annotation.from, annotation.to].flatMap((target) =>
        'centerline' in target ? [target.centerline] : []
      )
    : [];
}

/** v98: the dimension or frame a tolerancing annotation is attached to. */
export function drawingAnnotationHost(
  annotation: DrawingAnnotation
): DrawingAnnotationId | undefined {
  return isDrawingToleranceAnnotation(annotation)
    ? annotation.attachedTo
    : undefined;
}

/** v73: the marks an annotation measures to, by id. */
export function drawingAnnotationMarks(
  annotation: DrawingAnnotation
): DrawingAnnotationId[] {
  const points: DrawingPointRef[] =
    annotation.kind === 'linear'
      ? [annotation.from, annotation.to]
      : annotation.kind === 'centerline'
        ? centerlinePoints(annotation)
        : annotation.kind === 'distance'
          ? [annotation.from, annotation.to].flatMap((target) =>
              'point' in target ? [target.point] : []
            )
          : annotation.kind === 'three-point-angle'
            ? [annotation.vertex, annotation.from, annotation.to]
            : [];
  return points.flatMap((point) =>
    point.anchor === 'mark' ? [point.annotationId] : []
  );
}
