import {
  assemblyBomTable,
  assemblyComponentBodies,
  deriveAssemblyBom,
  isLiveAssemblyBody,
  type AssemblyBomTable,
  getParameterScope,
  holeCallout,
  holeOfBoreFace
} from '@openzcad/document-core';
import {
  drawingViewFrame,
  drawingPaperPerModelUnit,
  holeCalloutLabel,
  projectToView,
  type BodyId,
  type FeatureId,
  type HoleCallout,
  type DrawingAnnotationId,
  type DrawingViewId,
  type DrawingSheet,
  type BodyRepresentation,
  type DrawingAnnotation,
  type DrawingEdgeRef,
  type DrawingExtremeSide,
  type DrawingFaceRef,
  type DrawingPointAnchor,
  type DrawingPointRef,
  type DrawingView,
  type DrawingViewFrame,
  type DrawingAngleFormat,
  type DrawingCenterMark,
  type DrawingDimension,
  type DrawingDistanceTarget,
  type DrawingBomColumnKey,
  type DrawingGeometryAnnotation,
  type DrawingIntersectionMark,
  isDrawingGeometryAnnotation,
  isDrawingToleranceAnnotation,
  drawingAnnotationHost,
  drawingToleranceHostAllowed,
  type DrawingToleranceAnnotation,
  type DrawingTolerance,
  type DrawingSheetFormat,
  millimetresPerUnit,
  MAX_DRAWING_DIMENSION_DECIMALS,
  type EdgeTopology,
  type EdgeTopologyReferenceV5,
  type FaceTopology,
  type FaceTopologyReferenceV5,
  type GeometryBodyRepresentation,
  type ProjectDocument,
  type UnitSystem,
  type Vector3
} from '@openzcad/shared';
import {
  inspectTopologyWitness,
  topologyHashOfWitness
} from '@openzcad/kernel-adapter/topology-lineage';
import {
  resolveEdge,
  resolveFace,
  topologyResolutionMessage
} from '../topologyResolution';
import {
  viewPaperPerModelUnit,
  clipPolylineToCircle,
  fitText,
  viewClipCircle,
  sheetSafeText,
  textWidthMm,
  viewPageTransform,
  type ComposedView,
  type SheetImage,
  type SheetStroke,
  type SheetText
} from './sheetPage';
import {
  add,
  blendTube,
  chamferCorner,
  cross,
  dot,
  neighbourFaces,
  norm,
  readChamfer,
  scale,
  sub,
  virtualSharp,
  type SharpCurve
} from './surfaceSharps';
import {
  datumFeatureLayout,
  featureControlFrameLabel,
  featureControlFrameLayout,
  frameLeader,
  nearestOnBox,
  FRAME_HEIGHT_MM,
  type FrameCells
} from './toleranceFrames';
import {
  fitDeviations,
  formatArcMinutes,
  ISO_2768_ANGULAR,
  ISO_2768_ANGULAR_RANGES,
  ISO_2768_LINEAR,
  ISO_2768_LINEAR_RANGES
} from './isoTolerances';

/**
 * D02 annotation geometry: from a stored annotation to what it measures in
 * its view, and from that to strokes and text on the paper.
 *
 * Values come from the model every time — exact edge vertices and published
 * circle data projected into the view's plane — never from anything the
 * sheet stored. A reference that does not resolve to exactly one edge, or
 * an edge the view can no longer measure (a circle now seen edge-on, two
 * edges now parallel), makes the annotation broken with a reason; nothing
 * is ever measured from a substitute.
 */

type SourceBody = BodyRepresentation | GeometryBodyRepresentation;
export type AnnotationBodies = Readonly<Record<string, SourceBody | undefined>>;

/** AS03 (v114): the key an exploded view's placed copy of a body is under. */
export function explodedBodyKey(viewId: DrawingViewId, bodyId: string): string {
  return `${viewId}#exploded:${bodyId}`;
}

/**
 * Where a section view's cut bodies sit in an {@link AnnotationBodies} map
 * (D03): beside the model's own bodies, under a key no body id can take, so
 * a dimension on a section measures the cut body's edges while its stored
 * reference keeps naming the model body it was cut from.
 */
export function sectionBodyKey(viewId: DrawingViewId, bodyId: string): string {
  return `${viewId}#section:${bodyId}`;
}

/**
 * F06: where a view that draws another configuration row than the active
 * one finds the model body it draws for `bodyId` (that row's, not the
 * active row's) in an {@link AnnotationBodies} map. The key is present, with
 * no body under it when that row does not build the body, exactly when the
 * view draws another row: such a view never measures the active row's body
 * in its place.
 */
export function rowViewBodyKey(viewId: DrawingViewId, bodyId: string): string {
  return `${viewId}#row:${bodyId}`;
}

/**
 * The whole model body `view` draws for `bodyId` (a section's uncut body):
 * its configuration row's when it draws another row (F06), else the active
 * row's.
 */
export function viewModelBody(
  bodies: AnnotationBodies,
  view: Pick<DrawingView, 'viewId'> | undefined,
  bodyId: string
): SourceBody | undefined {
  if (view) {
    const key = rowViewBodyKey(view.viewId, bodyId);
    if (Object.prototype.hasOwnProperty.call(bodies, key)) return bodies[key];
  }
  return bodies[bodyId];
}

/**
 * M01: a hole's callout data by the hole's feature id, else null. `viewId`
 * names the view the bore is read in: a view that draws another
 * configuration row reads that row's callout (F06, `viewHoleCallouts`), as it
 * draws that row's bore.
 */
export type HoleCalloutLookup = (
  featureId: FeatureId,
  viewId?: DrawingViewId
) => HoleCallout | null;

/**
 * M01: the hole callouts of `document`, read once per hole and bound to it:
 * a drawing kept with this lookup calls its holes out as they were when it
 * was drawn, however the model changes before its Update.
 */
export function holeCalloutLookup(
  document: ProjectDocument
): HoleCalloutLookup {
  const scope = getParameterScope(document).scope;
  const read = new Map<FeatureId, HoleCallout | null>();
  return (featureId) => {
    if (!read.has(featureId)) {
      read.set(featureId, holeCallout(document, featureId, scope));
    }
    return read.get(featureId)!;
  };
}

/**
 * F06: every hole callout of `document`, read now and bound to nothing: a
 * configuration row's document is a copy of the whole model, which a
 * drawing kept with the row's callouts must not keep alive.
 */
export function holeCalloutSnapshot(
  document: ProjectDocument
): HoleCalloutLookup {
  const scope = getParameterScope(document).scope;
  const read = new Map<FeatureId, HoleCallout | null>();
  for (const node of Object.values(document.nodes))
    if (node.kind === 'feature' && node.data.featureKind === 'hole')
      read.set(node.featureId, holeCallout(document, node.featureId, scope));
  return (featureId) => read.get(featureId) ?? null;
}

/**
 * F06: the callouts each view reads. A view in `rows` draws another
 * configuration row and reads that row's callouts: its bore is that row's,
 * so the active row's size, depth or thread length beside it would be
 * another part's. Null there (the row could not be read) calls nothing
 * out, never the active row's in its place. Every other view reads `active`.
 */
export function viewHoleCallouts(
  active: HoleCalloutLookup,
  rows: ReadonlyMap<DrawingViewId, HoleCalloutLookup | null>
): HoleCalloutLookup {
  if (rows.size === 0) return active;
  return (featureId, viewId) => {
    if (viewId === undefined || !rows.has(viewId)) return active(featureId);
    return rows.get(viewId)?.(featureId) ?? null;
  };
}

/** Below this a rim's radius is its bore's. */
const BORE_RIM_TOLERANCE = 1e-6;

/**
 * M01: the callout of the hole whose bore `edge` rims, when the hole says
 * more than a plain diameter (a standard size or a thread) and the rim is
 * the bore's own diameter. A face named by a hole's bore lineage (directly,
 * on sketch points, or as an M02 pattern copy's) names the hole.
 */
function boreCallout(
  body: SourceBody | undefined,
  edge: { adjacentFaceHashes?: readonly number[] },
  radius: number,
  holes: HoleCalloutLookup,
  /** The view the bore is read in, whose row's callout it takes (F06). */
  viewId: DrawingViewId | undefined
): HoleCallout | null {
  const faces = body?.topology?.faces ?? [];
  for (const hash of edge.adjacentFaceHashes ?? []) {
    const face = faces.find((candidate) => candidate.hash === hash);
    const holeId = face?.reference ? holeOfBoreFace(face.reference) : null;
    if (!holeId) continue;
    const callout = holes(holeId, viewId);
    if (
      callout &&
      (callout.standard || callout.thread) &&
      Math.abs(callout.diameter / 2 - radius) <=
        BORE_RIM_TOLERANCE * Math.max(1, radius)
    )
      return callout;
  }
  return null;
}

export function annotationBody(
  bodies: AnnotationBodies,
  view: Pick<DrawingView, 'viewId' | 'section' | 'exploded'> | undefined,
  bodyId: string
): SourceBody | undefined {
  if (view?.section) return bodies[sectionBodyKey(view.viewId, bodyId)];
  // AS03 (v114): an exploded view measures its bodies where it draws them.
  if (view?.exploded) {
    const placed = bodies[explodedBodyKey(view.viewId, bodyId)];
    if (placed) return placed;
  }
  return viewModelBody(bodies, view, bodyId);
}

export type AnnotationBreak =
  | 'body-missing'
  | 'not-in-view'
  | 'not-found'
  | 'ambiguous'
  | 'closed-edge'
  | 'not-circular'
  | 'edge-on'
  | 'not-straight'
  | 'parallel'
  | 'degenerate'
  | 'foreshortened'
  | 'leader-hidden'
  | 'invalid-reference'
  | 'no-sharp'
  | 'not-a-chamfer'
  | 'not-a-blend'
  | 'not-a-counterbore'
  | 'not-a-countersink'
  | 'mark-missing'
  | 'not-parallel'
  | 'collinear'
  | 'no-bom'
  /** M01: a hole table's view sees no bore down its axis. */
  | 'no-holes'
  /**
   * M01: a hole table's view sees a bore whose hole a whole-body pattern's
   * copy no longer names, so a row would be missing (review).
   */
  | 'hole-unnamed'
  | 'not-in-bom'
  | 'not-on-part'
  | 'no-angle'
  | 'image-missing'
  /** v98: the dimension or frame this was attached to has been deleted. */
  | 'host-missing'
  /** v98: the dimension or frame this is attached to is broken. */
  | 'host-broken'
  /** v98: a frame names a datum no datum feature symbol declares. */
  | 'datum-undefined'
  /** v98: two datum feature symbols on the drawing share a letter. */
  | 'datum-duplicate'
  /** v105: a fit's size is outside the ISO 286 tables (0 to 500 mm). */
  | 'fit-out-of-range'
  /** v105: a thread class on a bore that is not a tapped hole's. */
  | 'not-threaded'
  /** v105: a metric class on an inch thread, or the other way round. */
  | 'thread-class-mismatch';

type UV = [number, number];

/**
 * D02 (v92): the project's reference images a sheet image may show, by
 * id: what printing one needs (the bytes' checksum, its type and aspect).
 */
export type SheetPictureLookup = ReadonlyMap<
  string,
  {
    name: string;
    checksumSha256: string;
    contentType: 'image/png' | 'image/jpeg';
    pixelWidth: number;
    pixelHeight: number;
  }
>;

/** The project's reference images as a {@link SheetPictureLookup}. */
export function sheetPictures(document: {
  referenceImages?: {
    images: readonly {
      imageId: string;
      name: string;
      contentType: 'image/png' | 'image/jpeg';
      source: { checksumSha256: string };
      pixelWidth: number;
      pixelHeight: number;
    }[];
  };
}): SheetPictureLookup {
  return new Map(
    (document.referenceImages?.images ?? []).map((image) => [
      image.imageId,
      {
        name: image.name,
        checksumSha256: image.source.checksumSha256,
        contentType: image.contentType,
        pixelWidth: image.pixelWidth,
        pixelHeight: image.pixelHeight
      }
    ])
  );
}

export type ResolvedAnnotation =
  | {
      /**
       * v98: a datum feature symbol's letter, and what it stands on: the
       * leader edge (as a note's, below) or, attached, its host's box.
       */
      kind: 'datum-feature';
      label: string;
      attached: boolean;
      leader?: number[];
      leaderDepths?: number[];
      leaderEdge?: { bodyId: string; topologyId: string };
      leaderPieces?: number[][];
    }
  | {
      /** v98: a feature control frame's compartments, and its leader. */
      kind: 'feature-control-frame';
      label: string;
      cells: FrameCells;
      attached: boolean;
      leader?: number[];
      leaderDepths?: number[];
      leaderEdge?: { bodyId: string; topologyId: string };
      leaderPieces?: number[][];
    }
  | {
      /** v92: a picture on the paper, its printed size in paper mm. */
      kind: 'image';
      label: string;
      name: string;
      widthMm: number;
      heightMm: number;
      checksumSha256: string;
      contentType: 'image/png' | 'image/jpeg';
    }
  | {
      /** v105: a general-tolerance block's header and rows, as a ruled table. */
      kind: 'general-tolerance';
      header: string[];
      numeric: boolean[];
      rows: string[][];
      label: string;
    }
  | {
      /**
       * M01: a hole table's header and rows, and each bore's tag where the
       * view draws it, in view (u, v) beside the bore's radius `r`.
       */
      kind: 'hole-table';
      header: string[];
      numeric: boolean[];
      rows: string[][];
      label: string;
      tags: { text: string; u: number; v: number; r: number }[];
    }
  | {
      /** v80: a parts list's header and rows, cells as the BOM table wrote them. */
      kind: 'bom-table';
      header: string[];
      numeric: boolean[];
      rows: string[][];
      label: string;
    }
  | {
      /** v80: a balloon's item number and its leader edge, flat `[u, v, …]`. */
      kind: 'balloon';
      label: string;
      leader: number[];
      /** As a note's (below): what its view draws of the edge. */
      leaderDepths?: number[];
      leaderEdge?: { bodyId: string; topologyId: string };
      leaderPieces?: number[][];
    }
  | {
      /** v73: a centre mark's circle, in view (u, v). */
      kind: 'center-mark';
      center: UV;
      radius: number;
      label: string;
    }
  | {
      /** v73: where two lines cross; each edge's nearer end, to extend from. */
      kind: 'intersection-mark';
      point: UV;
      from: [UV, UV];
      label: string;
    }
  | {
      /** v73: a centreline: a segment, or a circle. */
      kind: 'centerline';
      segment?: [UV, UV];
      circle?: { center: UV; radius: number };
      label: string;
    }
  | {
      kind: 'linear';
      /** Unit measuring direction in the view plane. */
      axis: UV;
      from: UV;
      to: UV;
      value: number;
      label: string;
      /** v68: a stacked or framed label's parts; absent is `label` alone. */
      text?: DimensionText;
    }
  | {
      kind: 'radius' | 'diameter';
      center: UV;
      radius: number;
      /**
       * A partial arc's projected polyline, flat `[u, v, …]`: arrowheads
       * land on it rather than anywhere on its full circle. Absent for a
       * whole circle.
       */
      arc?: number[];
      value: number;
      label: string;
      /** v68: a stacked or framed label's parts; absent is `label` alone. */
      text?: DimensionText;
    }
  | {
      kind: 'chamfer';
      /**
       * The chamfer's profile in the view, between its two virtual sharps:
       * both sides of a cone seen side-on, or a plane's one edge-on line.
       */
      segments: [UV, UV][];
      value: number;
      angle: number;
      label: string;
      /** v68: a stacked or framed label's parts; absent is `label` alone. */
      text?: DimensionText;
    }
  | {
      kind: 'angle';
      vertex: UV;
      /** Each edge's near and far end, far end last. */
      rays: [[UV, UV], [UV, UV]];
      value: number;
      label: string;
      /** v68: a stacked or framed label's parts; absent is `label` alone. */
      text?: DimensionText;
      /**
       * v51: the ray turned outward, now from the vertex along its edge's
       * extension, and that edge's near end, where its extension line
       * starts.
       */
      outside?: { index: 0 | 1; from: UV };
      /**
       * v82: a point the dimension's arc sweeps across: an arc angle's own
       * middle, so an arc of more than 180° is dimensioned the long way.
       */
      through?: UV;
    }
  | {
      kind: 'note';
      label: string;
      /** The leader edge's projected polyline, flat `[u, v, …]`. */
      leader?: number[];
      /** Each `leader` point's depth into the view, in model units. */
      leaderDepths?: number[];
      /** The leader edge itself, so a coincident edge is told apart. */
      leaderEdge?: { bodyId: string; topologyId: string };
      /**
       * The parts of `leader` its drawn view shows of this edge, `[u0, v0,
       * u1, v1]` each; set by {@link markHiddenLeaders}. Absent draws the
       * whole edge.
       */
      leaderPieces?: number[][];
    };

export type AnnotationResolution =
  | { ok: true; resolved: ResolvedAnnotation }
  | { ok: false; reason: AnnotationBreak; message: string };

export function annotationBreakMessage(reason: AnnotationBreak): string {
  switch (reason) {
    case 'body-missing':
    case 'not-found':
    case 'ambiguous':
      return topologyResolutionMessage(reason);
    case 'not-in-view':
      return 'The body this measured is no longer drawn in this view.';
    case 'closed-edge':
      return 'The edge this measured from is now a closed loop with no ends.';
    case 'not-circular':
      return 'The edge this measured is no longer a circle.';
    case 'edge-on':
      return 'The view now sees this geometry edge-on, so it cannot be measured here.';
    case 'not-straight':
      return 'An edge this measured is no longer straight.';
    case 'parallel':
      return 'The two edges are now parallel in this view, so they make no angle.';
    case 'degenerate':
      return 'The two points this measures are level along its direction in this view, so there is no span to dimension.';
    case 'invalid-reference':
      return 'The stored reference to this edge does not match its own fingerprint, so it is not trusted.';
    case 'leader-hidden':
      return 'The view no longer draws any of the edge this points at.';
    case 'foreshortened':
      return 'This view does not see what this measures true size (it slopes into the view, or the view is isometric); dimension it where it lies parallel to the view.';
    case 'no-sharp':
      return 'These two faces have no virtual sharp this can read (they are parallel, or not coaxial surfaces and planes square to their axis), or it is not a point in this view.';
    case 'not-a-chamfer':
      return 'This face is no longer a chamfer between two faces: a cone or plane with a virtual sharp at each end.';
    case 'not-a-blend':
      return 'This face is no longer a revolved blend (a torus), so it has no blend radius to state.';
    case 'not-a-counterbore':
      return 'These circles no longer make a counterbored hole: a larger bore on the same axis, opening onto the hole.';
    case 'not-a-countersink':
      return 'These circles no longer make a countersunk hole: a cone on the same axis, opening onto the hole.';
    case 'mark-missing':
      return 'The centre or intersection mark this measured to has been deleted, or no longer marks a point.';
    case 'not-parallel':
      return 'The two edges are no longer parallel in this view, so there is no line midway between them.';
    case 'collinear':
      return 'The three points now lie on one line, so no circle passes through them.';
    case 'no-bom':
      return 'The project has no assembly parts to list.';
    case 'no-holes':
      return 'This view sees no hole down its axis, so the table has nothing to list. Place it on a view that looks into the holes.';
    case 'hole-unnamed':
      return 'This view sees holes copied with a whole body, which do not say which hole they copy, so the table cannot list them. Repeat the holes with a feature pattern instead.';
    case 'not-in-bom':
      return 'The part this balloon named is no longer in the assembly.';
    case 'not-on-part':
      return 'The edge this balloon points at is not on the part it names.';
    case 'no-angle':
      return 'The three points now lie on one line (or two coincide), so they make no angle.';
    case 'image-missing':
      return 'The picture this image showed has been deleted from the project.';
    case 'host-missing':
      return 'The dimension or frame this was attached to has been deleted.';
    case 'host-broken':
      return 'The dimension or frame this is attached to is broken; repair it first.';
    case 'datum-undefined':
      return 'This frame names a datum that no datum feature symbol on the drawing declares.';
    case 'datum-duplicate':
      return 'Another datum feature symbol on the drawing has the same letter; each datum is declared once.';
    case 'fit-out-of-range':
      return 'This diameter is outside the ISO 286 fit tables (over 0 up to 500 mm), so its fit has no stated limits.';
    case 'not-threaded':
      return 'This diameter is not the bore of a tapped hole, so it has no thread to class.';
    case 'thread-class-mismatch':
      return 'This thread class is for the other thread system: ISO 965 classes (6H) for metric threads, UN classes (2B) for inch ones.';
  }
}

/** Default decimal places per document unit, trailing zeros trimmed. */
const LENGTH_DECIMALS: Readonly<Record<UnitSystem, number>> = {
  mm: 2,
  cm: 3,
  m: 4,
  inch: 3
};
const ANGLE_DECIMALS = 1;

/** Fixed decimals with trailing zeros trimmed; never "-0". */
export function formatDrawingNumber(value: number, decimals: number): string {
  const fixed = value.toFixed(decimals);
  const trimmed = fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
  return /^-0(\.0*)?$/.test(trimmed) ? '0' : trimmed;
}

/**
 * v68: a dimension label laid out in parts: `head` (count and prefix),
 * `lead` (the value and any symmetric tolerance), a deviation or limits pair
 * stacked upper over lower, then `tail` (the suffix). A basic dimension's
 * lead, the value alone, is framed.
 */
export interface DimensionText {
  /** The count and prefix, outside any frame ("2× "). */
  head: string;
  lead: string;
  stack?: [string, string];
  tail: string;
  framed?: true;
}

/**
 * What a dimension measures, before its format: `Ø` and 12.5 (a length in
 * the sheet's printed units), or 30 (an angle, in degrees).
 */
interface Measured {
  symbol: string;
  value: number;
  decimals: number;
  kind: 'length' | 'angle';
  /** v105: an ISO 286 fit class, written after the value ("Ø10 H7"). */
  designation?: string;
  /** v105: the fit's limit deviations, in the printed units. */
  fitTolerance?: DrawingTolerance;
}

/**
 * D02 (schema v70): how a sheet writes numbers, from its drawing
 * properties and the document's units. Lengths are measured in document
 * units and printed in `units` (`lengthFactor` converts).
 */
export interface DrawingNumberFormat {
  units: UnitSystem;
  lengthFactor: number;
  lengthDecimals: number;
  angleDecimals: number;
  angleFormat: DrawingAngleFormat;
  comma: boolean;
}

export function drawingNumberFormat(
  format: DrawingSheetFormat | undefined,
  documentUnits: UnitSystem
): DrawingNumberFormat {
  const units = format?.units ?? documentUnits;
  return {
    units,
    lengthFactor: millimetresPerUnit(documentUnits) / millimetresPerUnit(units),
    lengthDecimals: format?.decimals ?? LENGTH_DECIMALS[units],
    angleDecimals: format?.angleDecimals ?? ANGLE_DECIMALS,
    angleFormat: format?.angleFormat ?? 'decimal',
    comma: format?.decimalSeparator === 'comma'
  };
}

/** The sheet's number format (absent properties: the document's). */
export function sheetNumberFormat(
  sheet: Pick<DrawingSheet, 'format'>,
  documentUnits: UnitSystem
): DrawingNumberFormat {
  return drawingNumberFormat(sheet.format, documentUnits);
}

/** The fewest decimals (at most the bound) that state `value` exactly. */
function significantDecimals(value: number): number {
  for (let decimals = 0; decimals < MAX_DRAWING_DIMENSION_DECIMALS; decimals++)
    if (
      Math.abs(Number(value.toFixed(decimals)) - value) <=
      1e-9 * Math.max(1, Math.abs(value))
    )
      return decimals;
  return MAX_DRAWING_DIMENSION_DECIMALS;
}

/** Fixed decimals, kept so a stacked pair lines up; never "-0". */
function fixedNumber(value: number, decimals: number): string {
  const fixed = value.toFixed(decimals);
  return /^-0(\.0*)?$/.test(fixed) ? fixed.slice(1) : fixed;
}

/**
 * A number in the sheet's format: trimmed like {@link formatDrawingNumber}
 * or fixed (a tolerance), with its decimal separator; an angle with its
 * degree sign, or as degrees, minutes and seconds to `decimals` on the
 * seconds.
 */
function writeNumber(
  value: number,
  decimals: number,
  kind: Measured['kind'],
  format: DrawingNumberFormat,
  trim: boolean
): string {
  const plain = (n: number, d: number) =>
    trim ? formatDrawingNumber(n, d) : fixedNumber(n, d);
  const separate = (text: string) =>
    format.comma ? text.replace('.', ',') : text;
  if (kind === 'length') return separate(plain(value, decimals));
  if (format.angleFormat === 'decimal')
    return `${separate(plain(value, decimals))}°`;
  // Rounded once, in seconds, so 29°59'59.96" to one decimal is 30°0'0".
  const step = 10 ** decimals;
  let seconds = Math.round(Math.abs(value) * 3600 * step) / step;
  const degrees = Math.floor(seconds / 3600 + 1e-9);
  seconds -= degrees * 3600;
  const minutes = Math.floor(seconds / 60 + 1e-9);
  seconds = Math.max(0, seconds - minutes * 60);
  const sign = value < 0 && degrees + minutes + seconds > 0 ? '-' : '';
  return `${sign}${degrees}°${minutes}'${separate(plain(seconds, decimals))}"`;
}

/** A deviation: signed, and a bare `0` for none (ISO 129-1, ASME Y14.5). */
function signedDeviation(
  value: number,
  decimals: number,
  kind: Measured['kind'],
  format: DrawingNumberFormat
): string {
  const step = kind === 'angle' && format.angleFormat === 'dms' ? 3600 : 1;
  if (Math.abs(value * step) < 0.5 * 10 ** -decimals) return '0';
  const text = writeNumber(value, decimals, kind, format, false);
  return value < 0 ? text : `+${text}`;
}

/**
 * A dimension's text: the count, the prefix, the value with its tolerance,
 * the suffix, and brackets for a reference dimension. `measured` is a
 * number to format, or text a callout already wrote (which takes no
 * tolerance: the validator refuses one on a counterbore, a countersink or a
 * chamfer, and a toleranced diameter states its diameter, not the hole's
 * callout). WinAnsi has no diameter sign; Ø (U+00D8) is the usual stand-in,
 * and × (U+00D7) and ± (U+00B1) are in it.
 */
export function formatDimension(
  annotation: DrawingDimension,
  measured: string | Measured,
  format: DrawingNumberFormat = drawingNumberFormat(undefined, 'mm')
): { label: string; text?: DimensionText } {
  const count =
    'count' in annotation && annotation.count !== undefined
      ? `${annotation.count}× `
      : '';
  const head = `${count}${annotation.prefix ? `${annotation.prefix} ` : ''}`;
  const tail = annotation.suffix ? ` ${annotation.suffix}` : '';
  const tolerance =
    typeof measured === 'string'
      ? undefined
      : (measured.fitTolerance ?? annotation.tolerance);
  let lead: string;
  let stack: [string, string] | undefined;
  let gap = '';
  if (typeof measured === 'string') lead = measured;
  else {
    const { symbol, value, decimals, kind } = measured;
    const write = (n: number, d: number, trim: boolean) =>
      writeNumber(n, d, kind, format, trim);
    const nominal = `${symbol}${write(value, decimals, true)}${measured.designation ? ` ${measured.designation}` : ''}`;
    // A tolerance keeps the decimals it needs, so a stored one never prints
    // as zero: a length's or decimal degree's own, a D°M'S" amount's in
    // seconds (0.000001° is 0.0036").
    const tolerant = (...amounts: number[]) =>
      kind === 'angle' && format.angleFormat === 'dms'
        ? Math.max(
            decimals,
            ...amounts.map((amount) => significantDecimals(amount * 3600))
          )
        : Math.max(decimals, ...amounts.map(significantDecimals));
    switch (tolerance?.kind) {
      case undefined:
      case 'basic':
        lead = nominal;
        break;
      case 'symmetric': {
        const d = tolerant(tolerance.value);
        lead = `${nominal} ±${write(tolerance.value, d, false)}`;
        break;
      }
      case 'deviation':
      case 'limits': {
        const d = tolerant(tolerance.upper, tolerance.lower);
        if (tolerance.kind === 'deviation') {
          lead = nominal;
          gap = ' ';
          stack = [
            signedDeviation(tolerance.upper, d, kind, format),
            signedDeviation(tolerance.lower, d, kind, format)
          ];
        } else {
          lead = symbol;
          stack = [
            write(value + tolerance.upper, d, false),
            write(value + tolerance.lower, d, false)
          ];
        }
        break;
      }
    }
  }
  const framed = tolerance?.kind === 'basic';
  const flat = `${head}${framed ? `[${lead}]` : lead}${stack ? `${gap}${stack[0]}/${stack[1]}` : ''}${tail}`;
  const label = annotation.reference ? `(${flat})` : flat;
  if (!stack && !framed) return { label };
  return {
    label,
    text: {
      head,
      lead,
      ...(stack ? { stack } : {}),
      tail,
      ...(framed ? { framed: true as const } : {})
    }
  };
}

export function defaultDimensionDecimals(
  kind: Exclude<DrawingAnnotation['kind'], 'note'>,
  units: UnitSystem
): number {
  return kind === 'angle' ? ANGLE_DECIMALS : LENGTH_DECIMALS[units];
}

function failure(reason: AnnotationBreak): AnnotationResolution {
  return { ok: false, reason, message: annotationBreakMessage(reason) };
}

/**
 * Whether an edge reference's lineage may be used: `trusted` when its
 * witness is supported and fingerprints to its hash, `invalid` when it
 * contradicts it, `hash-only` when there is no reference or the scheme
 * cannot check its witness.
 */
export function referenceTrust(ref: {
  reference?: EdgeTopologyReferenceV5 | FaceTopologyReferenceV5;
}): 'trusted' | 'invalid' | 'hash-only' {
  const reference = ref.reference;
  if (!reference) return 'hash-only';
  const inspection =
    reference.kind === 'face'
      ? inspectTopologyWitness('face', reference.witness)
      : inspectTopologyWitness('edge', reference.witness);
  if (inspection.status === 'invalid') return 'invalid';
  if (inspection.status === 'unsupported') return 'hash-only';
  const hash =
    reference.kind === 'face'
      ? topologyHashOfWitness('face', reference.witness)
      : topologyHashOfWitness('edge', reference.witness);
  return hash === reference.currentHash ? 'trusted' : 'invalid';
}

type EdgeLookup =
  { ok: true; edge: EdgeTopology } | { ok: false; reason: AnnotationBreak };

function lookupEdge(
  ref: DrawingEdgeRef,
  view: DrawingView,
  bodies: AnnotationBodies
): EdgeLookup {
  const body = annotationBody(bodies, view, ref.bodyId);
  if (!body || body.consumed) return { ok: false, reason: 'body-missing' };
  if (!view.bodyIds.includes(ref.bodyId))
    return { ok: false, reason: 'not-in-view' };
  // A reference resolves by its lineage name first, so its witness must be
  // the one its hash fingerprints, as the kernel's own resolver requires:
  // a corrupted or forged reference is broken, never another edge. A
  // witness the scheme cannot vouch for (an unsupported curve) resolves by
  // its hash alone.
  const trust = referenceTrust(ref);
  if (trust === 'invalid') return { ok: false, reason: 'invalid-reference' };
  const found = resolveEdge(
    body,
    trust === 'trusted' ? ref : { bodyId: ref.bodyId, hash: ref.hash }
  );
  return found.ok
    ? { ok: true, edge: found.entry }
    : { ok: false, reason: found.reason };
}

type FaceLookup =
  | {
      ok: true;
      face: FaceTopology;
      faces: readonly FaceTopology[];
      edges: readonly EdgeTopology[];
    }
  | { ok: false; reason: AnnotationBreak };

/** {@link lookupEdge} for a face, with its body's faces and edges. */
function lookupFace(
  ref: DrawingFaceRef,
  view: DrawingView,
  bodies: AnnotationBodies
): FaceLookup {
  const body = viewModelBody(bodies, view, ref.bodyId);
  if (!body || body.consumed) return { ok: false, reason: 'body-missing' };
  if (!view.bodyIds.includes(ref.bodyId))
    return { ok: false, reason: 'not-in-view' };
  const trust = referenceTrust(ref);
  if (trust === 'invalid') return { ok: false, reason: 'invalid-reference' };
  const found = resolveFace(
    body,
    trust === 'trusted' ? ref : { bodyId: ref.bodyId, hash: ref.hash }
  );
  return found.ok
    ? {
        ok: true,
        face: found.entry,
        faces: body.topology?.faces ?? [],
        edges: body.topology?.edges ?? []
      }
    : { ok: false, reason: found.reason };
}

function projectPoint(view: DrawingView, p: ArrayLike<number>, at: number) {
  return projectToView(drawingViewFrame(view), {
    x: p[at]!,
    y: p[at + 1]!,
    z: p[at + 2]!
  });
}

/** An edge is closed when the kernel names one vertex at both ends. */
function isClosed(edge: EdgeTopology): boolean {
  if (edge.vertexIds) return edge.vertexIds[0] === edge.vertexIds[1];
  const p = edge.points;
  const n = p.length;
  return (
    n >= 6 &&
    Math.hypot(p[0]! - p[n - 3]!, p[1]! - p[n - 2]!, p[2]! - p[n - 1]!) < 1e-9
  );
}

/**
 * An open edge's two ends in the view's page order: the end further left
 * first, or the lower one when they are level, then the nearer one.
 */
export function edgeEndsInPageOrder(
  view: DrawingView,
  edge: EdgeTopology
): [UV, UV] | null {
  const ends = edgeEndsWithDepth(view, edge);
  return ends ? [ends[0].uv, ends[1].uv] : null;
}

interface ViewPoint {
  uv: UV;
  /** Distance into the view along its direction, in model units. */
  depth: number;
  /** The same point in model space. */
  model: Vector3;
}

/** {@link edgeEndsInPageOrder}, keeping each end's depth. */
function edgeEndsWithDepth(
  view: DrawingView,
  edge: EdgeTopology
): [ViewPoint, ViewPoint] | null {
  const p = edge.points;
  if (p.length < 6 || isClosed(edge)) return null;
  const a = projectPoint(view, p, 0);
  const b = projectPoint(view, p, p.length - 3);
  const tolerance = 1e-9 * Math.max(1, Math.abs(a.u), Math.abs(b.u));
  const level = (x: number, y: number) =>
    Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
  const aFirst =
    Math.abs(a.u - b.u) > tolerance
      ? a.u < b.u
      : !level(a.v, b.v)
        ? a.v < b.v
        : a.depth <= b.depth;
  const at = (i: number): Vector3 => ({ x: p[i]!, y: p[i + 1]!, z: p[i + 2]! });
  const ua: ViewPoint = { uv: [a.u, a.v], depth: a.depth, model: at(0) };
  const ub: ViewPoint = {
    uv: [b.u, b.v],
    depth: b.depth,
    model: at(p.length - 3)
  };
  return aFirst ? [ua, ub] : [ub, ua];
}

/**
 * Whether two points lie in one plane parallel to the view, so the span
 * between them is drawn true length. `span` is their projected distance.
 */
function parallelToView(a: ViewPoint, b: ViewPoint, span: number): boolean {
  return Math.abs(b.depth - a.depth) <= 1e-6 * Math.max(1, span);
}

/** A circle's centre and radius when the view sees it face-on. */
function faceOnCircle(
  view: DrawingView,
  edge: EdgeTopology
):
  | { ok: true; center: UV; depth: number; radius: number }
  | { ok: false; reason: AnnotationBreak } {
  const circle = edge.curve?.circle;
  if (!circle) return { ok: false, reason: 'not-circular' };
  const direction = drawingViewFrame(view).direction;
  const facing =
    circle.axis.x * direction.x +
    circle.axis.y * direction.y +
    circle.axis.z * direction.z;
  if (Math.abs(Math.abs(facing) - 1) > 1e-6)
    return { ok: false, reason: 'edge-on' };
  const c = projectToView(drawingViewFrame(view), circle.center);
  return {
    ok: true,
    center: [c.u, c.v],
    depth: c.depth,
    radius: circle.radius
  };
}

function viewPoint(frame: DrawingViewFrame, model: Vector3): ViewPoint {
  const p = projectToView(frame, model);
  return { uv: [p.u, p.v], depth: p.depth, model };
}

/**
 * A circle's extreme along `along` (unit, model space) on `side`; when the
 * circle is level along it — a rim seen side-on, measured up its axis —
 * every point is as far, and `side` picks the extreme along `across`.
 */
function circleExtreme(
  circle: { center: Vector3; axis: Vector3; radius: number },
  along: Vector3,
  across: Vector3,
  side: DrawingExtremeSide
): Vector3 {
  const sign = side === 'high' ? 1 : -1;
  for (const direction of [along, across]) {
    const inPlane = sub(
      direction,
      scale(circle.axis, dot(direction, circle.axis))
    );
    const length = norm(inPlane);
    if (length > 1e-9)
      return add(
        circle.center,
        scale(inPlane, (sign * circle.radius) / length)
      );
  }
  return circle.center;
}

/**
 * Where a point of a horizontal or vertical dimension lies. `along` is the
 * model direction the dimension measures (null for an aligned one, which
 * takes no extreme) and `across` the view's other page direction.
 */
function pointOf(
  view: DrawingView,
  point: DrawingPointRef,
  bodies: AnnotationBodies,
  along: Vector3 | null,
  across: Vector3 | null,
  /** v73: the sheet's annotations, for a point a mark marks. */
  marks?: MarkLookup
): { ok: true; point: ViewPoint } | { ok: false; reason: AnnotationBreak } {
  const frame = drawingViewFrame(view);
  if (point.anchor === 'mark') {
    const mark = marks?.(point.annotationId);
    if (
      !mark ||
      mark.viewId !== view.viewId ||
      (mark.kind !== 'center-mark' && mark.kind !== 'intersection-mark')
    )
      return { ok: false, reason: 'mark-missing' };
    return markPoint(mark, view, bodies);
  }
  if (point.anchor === 'virtual-sharp') {
    const found = point.faces.map((ref) => lookupFace(ref, view, bodies));
    for (const entry of found) if (!entry.ok) return entry;
    const [a, b] = found as Extract<FaceLookup, { ok: true }>[];
    if (a!.face === b!.face) return { ok: false, reason: 'ambiguous' };
    const sharp = virtualSharp(a!.face, b!.face);
    if (!sharp.ok || !along || !across)
      return { ok: false, reason: 'no-sharp' };
    return sharpPoint(frame, sharp.curve, along, across, point.side);
  }
  if (point.anchor === 'chamfer-corner') {
    const face = lookupFace(point.face, view, bodies);
    if (!face.ok) return face;
    const like = lookupFace(point.like, view, bodies);
    if (!like.ok) return like;
    if (face.face === like.face) return { ok: false, reason: 'ambiguous' };
    const corner = chamferCorner(face.face, like.face, face.faces, face.edges);
    if (!corner.ok) return corner;
    if (!along || !across) return { ok: false, reason: 'no-sharp' };
    return sharpPoint(frame, corner.circle, along, across, point.side);
  }
  const found = lookupEdge(point.edge, view, bodies);
  if (!found.ok) return found;
  const edge = found.edge;
  if (point.anchor === 'silhouette') {
    const circle = edge.curve?.circle;
    if (!circle) return { ok: false, reason: 'not-circular' };
    if (!along || !across) return { ok: false, reason: 'degenerate' };
    return {
      ok: true,
      point: viewPoint(
        frame,
        silhouettePoint(edge, circle, along, across, point.side)
      )
    };
  }
  return edgePoint(view, edge, point.anchor);
}

/** An open edge's end, or a face-on circle's centre (the D02 points). */
function edgePoint(
  view: DrawingView,
  edge: EdgeTopology,
  anchor: DrawingPointAnchor
): { ok: true; point: ViewPoint } | { ok: false; reason: AnnotationBreak } {
  if (anchor === 'center') {
    const circle = faceOnCircle(view, edge);
    return circle.ok
      ? {
          ok: true,
          point: {
            uv: circle.center,
            depth: circle.depth,
            model: edge.curve!.circle!.center
          }
        }
      : circle;
  }
  const ends = edgeEndsWithDepth(view, edge);
  if (!ends) return { ok: false, reason: 'closed-edge' };
  return { ok: true, point: anchor === 'first' ? ends[0] : ends[1] };
}

/**
 * Where `point` lies in `view` for a horizontal or vertical dimension —
 * its (u, v), depth and model point — or null when it does not resolve: what a picker compares a
 * click with to choose an extreme's side.
 */
export function dimensionPointInView(
  view: DrawingView,
  point: DrawingPointRef,
  bodies: AnnotationBodies,
  direction: 'horizontal' | 'vertical'
): { uv: UV; depth: number; model: Vector3 } | null {
  const frame = drawingViewFrame(view);
  const [along, across] =
    direction === 'horizontal' ? [frame.x, frame.up] : [frame.up, frame.x];
  const found = pointOf(view, point, bodies, along, across);
  return found.ok ? found.point : null;
}

/**
 * A circular edge's extreme on `side`. A partial arc whose sweep misses the
 * circle's extreme is measured to its own end furthest that way.
 */
function silhouettePoint(
  edge: EdgeTopology,
  circle: { center: Vector3; axis: Vector3; radius: number },
  along: Vector3,
  across: Vector3,
  side: DrawingExtremeSide
): Vector3 {
  const extreme = circleExtreme(circle, along, across, side);
  if (isClosed(edge)) return extreme;
  const p = edge.points;
  let nearest = Infinity;
  for (let i = 0; i + 5 < p.length; i += 3) {
    const a: Vector3 = { x: p[i]!, y: p[i + 1]!, z: p[i + 2]! };
    const b: Vector3 = { x: p[i + 3]!, y: p[i + 4]!, z: p[i + 5]! };
    const ab = sub(b, a);
    const t = Math.min(
      1,
      Math.max(0, dot(sub(extreme, a), ab) / Math.max(dot(ab, ab), 1e-300))
    );
    nearest = Math.min(nearest, norm(sub(extreme, add(a, scale(ab, t)))));
  }
  // On the arc within its chordal sag.
  if (nearest <= Math.max(1e-6, 0.02 * circle.radius)) return extreme;
  const first: Vector3 = { x: p[0]!, y: p[1]!, z: p[2]! };
  const last: Vector3 = {
    x: p[p.length - 3]!,
    y: p[p.length - 2]!,
    z: p[p.length - 1]!
  };
  const sign = side === 'high' ? 1 : -1;
  return sign * dot(first, along) >= sign * dot(last, along) ? first : last;
}

/**
 * A revolved blend's tube in a view that sees its torus side-on: the
 * circle it draws on `side` of the axis (the extreme across the page that
 * way), and the arc of it the face covers, between where the blend meets
 * the faces either side.
 */
function blendTubeInView(
  view: DrawingView,
  face: FaceTopology,
  faces: readonly FaceTopology[],
  edges: readonly EdgeTopology[],
  side: DrawingExtremeSide
):
  | { ok: true; center: UV; radius: number; arc?: number[] }
  | { ok: false; reason: AnnotationBreak } {
  const g = face.geometry;
  if (!g || !g.surfaceType.toLowerCase().includes('tor') || !g.axis)
    return { ok: false, reason: 'not-a-blend' };
  const frame = drawingViewFrame(view);
  const across = cross(frame.direction, g.axis);
  const width = norm(across);
  // True size only side-on: the axis lies in the view's plane.
  if (width < 1 - 1e-6) return { ok: false, reason: 'foreshortened' };
  // The extreme across the page on `side`, along whichever page direction
  // the tube's offset from the axis mostly runs.
  const page =
    Math.abs(dot(across, frame.x)) >= Math.abs(dot(across, frame.up))
      ? frame.x
      : frame.up;
  const sign = (side === 'high' ? 1 : -1) * Math.sign(dot(across, page));
  const outward = scale(across, sign / width);
  const tube = blendTube(face, outward);
  if (!tube) return { ok: false, reason: 'not-a-blend' };
  const project = (point: Vector3): UV => {
    const p = projectToView(frame, point);
    return [p.u, p.v];
  };
  const center = project(tube.center);
  // Where the blend meets its neighbours: its boundary circles, each at
  // its own extreme on this side.
  const neighbours = new Set(
    neighbourFaces(face, faces, edges).map((other) => other.hash)
  );
  const ends: number[] = [];
  for (const edge of edges) {
    const circle = edge.curve?.circle;
    const adjacent = edge.adjacentFaceHashes ?? [];
    if (
      !circle ||
      !adjacent.includes(face.hash) ||
      !adjacent.some((hash) => neighbours.has(hash))
    )
      continue;
    const at = project(add(circle.center, scale(outward, circle.radius)));
    const angle = Math.atan2(at[1] - center[1], at[0] - center[0]);
    if (!ends.some((known) => Math.abs(known - angle) < 1e-9)) ends.push(angle);
  }
  if (ends.length !== 2) return { ok: true, center, radius: tube.radius };
  // A blend turns through less than half a circle: the shorter way round.
  const [start, end] = ends as [number, number];
  let sweep = end - start;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  const arc: number[] = [];
  const steps = 16;
  for (let i = 0; i <= steps; i += 1) {
    const t = start + (sweep * i) / steps;
    arc.push(
      center[0] + tube.radius * Math.cos(t),
      center[1] + tube.radius * Math.sin(t)
    );
  }
  return { ok: true, center, radius: tube.radius, arc };
}

/** A virtual sharp as a point of a horizontal or vertical dimension. */
function sharpPoint(
  frame: DrawingViewFrame,
  curve: SharpCurve,
  along: Vector3,
  across: Vector3,
  side: DrawingExtremeSide
): { ok: true; point: ViewPoint } | { ok: false; reason: AnnotationBreak } {
  if (curve.kind === 'circle')
    return {
      ok: true,
      point: viewPoint(frame, circleExtreme(curve, along, across, side))
    };
  // Two planes meet in a line: a point only where the view sees it end-on.
  if (Math.abs(Math.abs(dot(curve.direction, frame.direction)) - 1) > 1e-6)
    return { ok: false, reason: 'no-sharp' };
  return { ok: true, point: viewPoint(frame, curve.point) };
}

/**
 * Where a point anchor of `edge` lies in `view`: its (u, v), its depth into
 * the view and the model point, by the same rule a dimension resolves it;
 * null when the edge has no such point there (a closed edge's end, a
 * circle seen edge-on).
 */
export function drawingPointInView(
  view: DrawingView,
  edge: EdgeTopology,
  anchor: DrawingPointAnchor
): { uv: UV; depth: number; model: Vector3 } | null {
  const found = edgePoint(view, edge, anchor);
  return found.ok ? found.point : null;
}

function projectedPolyline(view: DrawingView, edge: EdgeTopology): number[] {
  const out: number[] = [];
  for (let i = 0; i + 2 < edge.points.length; i += 3) {
    const { u, v } = projectPoint(view, edge.points, i);
    out.push(u, v);
  }
  return out;
}

/**
 * A leader's edge as a note or balloon carries it: its projected polyline,
 * each point's depth, and the edge itself, so markHiddenLeaders can keep
 * only what the view draws of it.
 */
function leaderOf(
  view: DrawingView,
  ref: DrawingEdgeRef,
  edge: EdgeTopology
): {
  leader: number[];
  leaderDepths: number[];
  leaderEdge: { bodyId: string; topologyId: string };
} {
  const depths: number[] = [];
  for (let i = 0; i + 2 < edge.points.length; i += 3)
    depths.push(projectPoint(view, edge.points, i).depth);
  return {
    leader: projectedPolyline(view, edge),
    leaderDepths: depths,
    leaderEdge: { bodyId: ref.bodyId, topologyId: edge.topologyId }
  };
}

/**
 * D07 v98: how many datum feature symbols declare each letter, across every
 * sheet of a drawing: a frame may name a datum declared on another sheet,
 * and a letter declared twice is ambiguous wherever it is read.
 */
export type DatumLetters = ReadonlyMap<string, number>;

export function drawingDatumLetters(
  sheets: readonly Pick<DrawingSheet, 'annotations'>[]
): DatumLetters {
  const counts = new Map<string, number>();
  for (const sheet of sheets)
    for (const annotation of sheet.annotations ?? [])
      if (annotation.kind === 'datum-feature')
        counts.set(annotation.letter, (counts.get(annotation.letter) ?? 0) + 1);
  return counts;
}

/**
 * D07 v105: a general-tolerance block as a ruled table. ISO 2768-1 prints its
 * linear and angular tables for the class, in millimetres as the standard
 * states them (the header names the class, "ISO 2768-mK"); a stated block
 * lists ± per number of decimals written ("X.XX ±0.05") and on angles, in
 * the sheet's units.
 */
export function generalToleranceTable(
  annotation: Extract<DrawingAnnotation, { kind: 'general-tolerance' }>,
  format: DrawingNumberFormat
): Extract<ResolvedAnnotation, { kind: 'general-tolerance' }> {
  const write = (value: number, decimals = significantDecimals(value)) =>
    writeNumber(value, decimals, 'length', format, true);
  if (annotation.scheme === 'iso-2768') {
    const name = `ISO 2768-${annotation.linearClass}${annotation.geometricClass ?? ''}`;
    const rows: string[][] = [];
    ISO_2768_LINEAR_RANGES.forEach(([over, upTo], index) => {
      const amount = ISO_2768_LINEAR[annotation.linearClass][index];
      if (amount === null || amount === undefined) return;
      rows.push([`over ${write(over)} to ${write(upTo)}`, `±${write(amount)}`]);
    });
    ISO_2768_ANGULAR_RANGES.forEach(([over, upTo], index) => {
      const minutes = ISO_2768_ANGULAR[annotation.linearClass][index]!;
      const range =
        over === null
          ? `angles, side to ${write(upTo!)}`
          : upTo === null
            ? `angles, side over ${write(over)}`
            : `angles, side over ${write(over)} to ${write(upTo)}`;
      rows.push([range, `±${formatArcMinutes(minutes)}`]);
    });
    return {
      kind: 'general-tolerance',
      label: name,
      header: [`${name} (mm)`, 'Tolerance'],
      numeric: [false, true],
      rows
    };
  }
  const units = format.units === 'inch' ? 'in' : format.units;
  const rows = [...annotation.places]
    .sort((a, b) => a.decimals - b.decimals)
    .map((place) => [
      place.decimals === 0
        ? 'X'
        : `X${format.comma ? ',' : '.'}${'X'.repeat(place.decimals)}`,
      `±${write(place.amount)}`
    ]);
  if (annotation.angle !== undefined)
    rows.push(['Angles', `±${write(annotation.angle)}°`]);
  return {
    kind: 'general-tolerance',
    label: 'General tolerances',
    header: [`Unless stated (${units})`, 'Tolerance'],
    numeric: [false, true],
    rows
  };
}

/** D07 v98: a frame's tolerance amount in the sheet's number format. */
export function formatFrameTolerance(
  value: number,
  format: DrawingNumberFormat
): string {
  return writeNumber(value, significantDecimals(value), 'length', format, true);
}

/**
 * D07 v98: a datum feature symbol or feature control frame. Its leader edge
 * resolves like a note's; an attachment needs its host on the same view (a
 * deleted one is `host-missing`; a broken one is marked after the sheet
 * resolves, see resolveSheetAnnotations). A letter declared twice, or a
 * frame naming an undeclared datum, breaks by name rather than guessing.
 */
function resolveToleranceAnnotation(
  annotation: DrawingToleranceAnnotation,
  view: DrawingView | undefined,
  bodies: AnnotationBodies,
  format: DrawingNumberFormat,
  marks: MarkLookup | undefined,
  datums: DatumLetters | undefined
): AnnotationResolution {
  if (!view) return failure('not-in-view');
  let leader: ReturnType<typeof leaderOf> | undefined;
  if (annotation.attachedTo !== undefined) {
    const host = marks?.(annotation.attachedTo);
    if (
      !host ||
      host.viewId !== annotation.viewId ||
      !drawingToleranceHostAllowed(annotation.kind, host)
    )
      return failure('host-missing');
  } else if (annotation.leader) {
    const found = lookupEdge(annotation.leader, view, bodies);
    if (!found.ok) return failure(found.reason);
    leader = leaderOf(view, annotation.leader, found.edge);
  }
  const attached = annotation.attachedTo !== undefined;
  if (annotation.kind === 'datum-feature') {
    if (datums && (datums.get(annotation.letter) ?? 0) > 1)
      return failure('datum-duplicate');
    return {
      ok: true,
      resolved: {
        kind: 'datum-feature',
        label: annotation.letter,
        attached,
        ...leader
      }
    };
  }
  if (
    datums &&
    (annotation.datums ?? []).some(
      (reference) => (datums.get(reference.letter) ?? 0) === 0
    )
  )
    return failure('datum-undefined');
  const cells: FrameCells = {
    characteristic: annotation.characteristic,
    tolerance: formatFrameTolerance(annotation.amount, format),
    diameterZone: annotation.diameterZone === true,
    ...(annotation.material ? { material: annotation.material } : {}),
    datums: (annotation.datums ?? []).map((reference) => ({ ...reference }))
  };
  return {
    ok: true,
    resolved: {
      kind: 'feature-control-frame',
      label: featureControlFrameLabel(cells),
      cells,
      attached,
      ...leader
    }
  };
}

/** A straight edge's projected ends, or why it cannot serve as a ray. */
function straightEnds(
  view: DrawingView,
  edge: EdgeTopology
): { ok: true; ends: [UV, UV] } | { ok: false; reason: AnnotationBreak } {
  if (edge.curve?.type !== 'LINE') return { ok: false, reason: 'not-straight' };
  const ends = edgeEndsWithDepth(view, edge);
  if (!ends) return { ok: false, reason: 'not-straight' };
  const [a, b] = ends;
  const length = Math.hypot(b.uv[0] - a.uv[0], b.uv[1] - a.uv[1]);
  if (length < 1e-9) return { ok: false, reason: 'edge-on' };
  // An edge sloping into the view draws shorter than it is, and the angle
  // it makes on the page is not the part's.
  if (!parallelToView(a, b, length))
    return { ok: false, reason: 'foreshortened' };
  return { ok: true, ends: [a.uv, b.uv] };
}

/** v73: the sheet's annotations by id, for points that marks mark. */
export type MarkLookup = (
  annotationId: DrawingAnnotationId
) => DrawingAnnotation | undefined;

/** A point in the view at (u, v) and `depth`, with its model position. */
function pointAt(frame: DrawingViewFrame, uv: UV, depth: number): ViewPoint {
  const model = add(
    add(scale(frame.x, uv[0]), scale(frame.up, uv[1])),
    scale(frame.direction, depth)
  );
  return { uv, depth, model };
}

/** Where two straight edges' lines cross in the view, and each one's near end. */
function crossing(
  view: DrawingView,
  edges: readonly EdgeTopology[]
):
  | { ok: true; point: UV; depth: number; near: [UV, UV] }
  | { ok: false; reason: AnnotationBreak } {
  // Where the lines cross on the page: an edge sloping into the view still
  // has one, so only straightness is asked of it, not true length.
  const lines: [ViewPoint, ViewPoint][] = [];
  for (const edge of edges) {
    if (edge.curve?.type !== 'LINE')
      return { ok: false, reason: 'not-straight' };
    const ends = edgeEndsWithDepth(view, edge);
    if (!ends) return { ok: false, reason: 'not-straight' };
    if (
      Math.hypot(ends[1].uv[0] - ends[0].uv[0], ends[1].uv[1] - ends[0].uv[1]) <
      1e-9
    )
      return { ok: false, reason: 'edge-on' };
    lines.push(ends);
  }
  const [[a1, b1], [a2, b2]] = lines as [
    [ViewPoint, ViewPoint],
    [ViewPoint, ViewPoint]
  ];
  const e1: UV = [b1.uv[0] - a1.uv[0], b1.uv[1] - a1.uv[1]];
  const e2: UV = [b2.uv[0] - a2.uv[0], b2.uv[1] - a2.uv[1]];
  const cross = e1[0] * e2[1] - e1[1] * e2[0];
  if (Math.abs(cross) <= 1e-9 * Math.hypot(...e1) * Math.hypot(...e2))
    return { ok: false, reason: 'parallel' };
  const t =
    ((a2.uv[0] - a1.uv[0]) * e2[1] - (a2.uv[1] - a1.uv[1]) * e2[0]) / cross;
  const point: UV = [a1.uv[0] + t * e1[0], a1.uv[1] + t * e1[1]];
  const nearer = ([a, b]: [ViewPoint, ViewPoint]): UV =>
    Math.hypot(a.uv[0] - point[0], a.uv[1] - point[1]) <=
    Math.hypot(b.uv[0] - point[0], b.uv[1] - point[1])
      ? a.uv
      : b.uv;
  return {
    ok: true,
    point,
    depth: a1.depth + t * (b1.depth - a1.depth),
    near: [nearer(lines[0]!), nearer(lines[1]!)]
  };
}

/** The point a centre or intersection mark marks, read from the model. */
function markPoint(
  mark: DrawingCenterMark | DrawingIntersectionMark,
  view: DrawingView,
  bodies: AnnotationBodies
): { ok: true; point: ViewPoint } | { ok: false; reason: AnnotationBreak } {
  const frame = drawingViewFrame(view);
  if (mark.kind === 'center-mark') {
    const found = lookupEdge(mark.edge, view, bodies);
    if (!found.ok) return found;
    const circle = faceOnCircle(view, found.edge);
    if (!circle.ok) return circle;
    return { ok: true, point: pointAt(frame, circle.center, circle.depth) };
  }
  const edges: EdgeTopology[] = [];
  for (const ref of mark.edges) {
    const found = lookupEdge(ref, view, bodies);
    if (!found.ok) return found;
    edges.push(found.edge);
  }
  if (edges[0] === edges[1]) return { ok: false, reason: 'ambiguous' };
  const crossed = crossing(view, edges);
  if (!crossed.ok) return crossed;
  return { ok: true, point: pointAt(frame, crossed.point, crossed.depth) };
}

/** v75: a distance target in the view: a disc (a point is one of radius 0) or a line. */
type DistanceShape =
  | { kind: 'disc'; center: UV; depth: number; radius: number }
  | { kind: 'line'; a: UV; b: UV };

type DistanceEnd =
  { ok: true; end: DistanceShape } | { ok: false; reason: AnnotationBreak };

/** What a v75 distance target is in `view` of the current model. */
function distanceEnd(
  target: DrawingDistanceTarget,
  view: DrawingView,
  bodies: AnnotationBodies,
  marks: MarkLookup | undefined
): DistanceEnd {
  if ('point' in target) {
    const found = pointOf(view, target.point, bodies, null, null, marks);
    if (!found.ok) return found;
    return {
      ok: true,
      end: {
        kind: 'disc',
        center: found.point.uv,
        depth: found.point.depth,
        radius: 0
      }
    };
  }
  if ('line' in target) {
    const found = lookupEdge(target.line, view, bodies);
    if (!found.ok) return found;
    const straight = straightEnds(view, found.edge);
    if (!straight.ok) return straight;
    return {
      ok: true,
      end: { kind: 'line', a: straight.ends[0], b: straight.ends[1] }
    };
  }
  if ('circle' in target) {
    const found = lookupEdge(target.circle, view, bodies);
    if (!found.ok) return found;
    const circle = faceOnCircle(view, found.edge);
    if (!circle.ok) return circle;
    return {
      ok: true,
      end: {
        kind: 'disc',
        center: circle.center,
        depth: circle.depth,
        radius: circle.radius
      }
    };
  }
  const line = marks?.(target.centerline);
  if (
    !line ||
    line.kind !== 'centerline' ||
    line.mode === 'circle' ||
    line.viewId !== view.viewId
  )
    return { ok: false, reason: 'mark-missing' };
  const drawn = resolveGeometryAnnotation(line, view, bodies, marks);
  if (!drawn.ok) return { ok: false, reason: drawn.reason };
  const segment =
    drawn.resolved.kind === 'centerline' ? drawn.resolved.segment : undefined;
  if (!segment) return { ok: false, reason: 'mark-missing' };
  return { ok: true, end: { kind: 'line', a: segment[0], b: segment[1] } };
}

/**
 * The two feet a distance spans: square to a line when either end is one
 * (from a line's midpoint when both are, which must then be parallel), else
 * along the line between two centres. `extent` moves each circle's foot to
 * its near (`min`) or far (`max`) side; a point is a circle of radius 0, so
 * it moves only circles.
 */
function distanceFeet(
  from: DistanceShape,
  to: DistanceShape,
  extent: 'min' | 'max' | undefined
): { ok: true; from: UV; to: UV } | { ok: false; reason: AnnotationBreak } {
  const sign = extent === 'max' ? -1 : 1;
  const radius = (shape: DistanceShape) =>
    shape.kind === 'disc' && extent ? shape.radius : 0;
  const foot = (p: UV, a: UV, b: UV): UV => {
    const d: UV = [b[0] - a[0], b[1] - a[1]];
    const t =
      ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / (d[0] ** 2 + d[1] ** 2);
    return [a[0] + t * d[0], a[1] + t * d[1]];
  };
  if (from.kind === 'line' && to.kind === 'line') {
    const e1: UV = [from.b[0] - from.a[0], from.b[1] - from.a[1]];
    const e2: UV = [to.b[0] - to.a[0], to.b[1] - to.a[1]];
    if (
      Math.abs(e1[0] * e2[1] - e1[1] * e2[0]) >
      1e-6 * Math.hypot(...e1) * Math.hypot(...e2)
    )
      return { ok: false, reason: 'not-parallel' };
    const middle: UV = [
      (from.a[0] + from.b[0]) / 2,
      (from.a[1] + from.b[1]) / 2
    ];
    const at = foot(middle, to.a, to.b);
    if (Math.hypot(at[0] - middle[0], at[1] - middle[1]) < 1e-9)
      return { ok: false, reason: 'degenerate' };
    return { ok: true, from: middle, to: at };
  }
  if (from.kind === 'line' || to.kind === 'line') {
    const line = (from.kind === 'line' ? from : to) as Extract<
      DistanceShape,
      { kind: 'line' }
    >;
    const disc = (from.kind === 'disc' ? from : to) as Extract<
      DistanceShape,
      { kind: 'disc' }
    >;
    const at = foot(disc.center, line.a, line.b);
    const away: UV = [disc.center[0] - at[0], disc.center[1] - at[1]];
    const length = Math.hypot(...away);
    const r = radius(disc);
    if (length < 1e-9 || length - sign * r <= 1e-9)
      return { ok: false, reason: 'degenerate' };
    const w: UV = [away[0] / length, away[1] / length];
    const side: UV = [
      disc.center[0] - sign * w[0] * r,
      disc.center[1] - sign * w[1] * r
    ];
    return from.kind === 'line'
      ? { ok: true, from: at, to: side }
      : { ok: true, from: side, to: at };
  }
  const span: UV = [
    to.center[0] - from.center[0],
    to.center[1] - from.center[1]
  ];
  const length = Math.hypot(...span);
  if (length < 1e-9) return { ok: false, reason: 'degenerate' };
  // Between two points, the span is true only in one plane parallel to the
  // view, as an aligned dimension's.
  if (Math.abs(to.depth - from.depth) > 1e-6 * Math.max(1, length))
    return { ok: false, reason: 'foreshortened' };
  const u: UV = [span[0] / length, span[1] / length];
  const r1 = radius(from);
  const r2 = radius(to);
  if (length - sign * (r1 + r2) <= 1e-9)
    return { ok: false, reason: 'degenerate' };
  return {
    ok: true,
    from: [
      from.center[0] + sign * u[0] * r1,
      from.center[1] + sign * u[1] * r1
    ],
    to: [to.center[0] - sign * u[0] * r2, to.center[1] - sign * u[1] * r2]
  };
}

/** v73: a centre mark, an intersection mark or a centreline, in its view. */
function resolveGeometryAnnotation(
  annotation: DrawingGeometryAnnotation,
  view: DrawingView,
  bodies: AnnotationBodies,
  marks: MarkLookup | undefined
): AnnotationResolution {
  switch (annotation.kind) {
    case 'center-mark': {
      const found = lookupEdge(annotation.edge, view, bodies);
      if (!found.ok) return failure(found.reason);
      const circle = faceOnCircle(view, found.edge);
      if (!circle.ok) return failure(circle.reason);
      return {
        ok: true,
        resolved: {
          kind: 'center-mark',
          center: circle.center,
          radius: circle.radius,
          label: ''
        }
      };
    }
    case 'intersection-mark': {
      const edges: EdgeTopology[] = [];
      for (const ref of annotation.edges) {
        const found = lookupEdge(ref, view, bodies);
        if (!found.ok) return failure(found.reason);
        edges.push(found.edge);
      }
      if (edges[0] === edges[1]) return failure('ambiguous');
      const crossed = crossing(view, edges);
      if (!crossed.ok) return failure(crossed.reason);
      return {
        ok: true,
        resolved: {
          kind: 'intersection-mark',
          point: crossed.point,
          from: crossed.near,
          label: ''
        }
      };
    }
    case 'centerline': {
      if (annotation.mode === 'lines') {
        const lines: [UV, UV][] = [];
        for (const ref of annotation.edges) {
          const found = lookupEdge(ref, view, bodies);
          if (!found.ok) return failure(found.reason);
          // Midway on the page: an edge sloping into the view still draws
          // a line there.
          if (found.edge.curve?.type !== 'LINE') return failure('not-straight');
          const ends = edgeEndsInPageOrder(view, found.edge);
          if (!ends) return failure('not-straight');
          if (
            Math.hypot(ends[1][0] - ends[0][0], ends[1][1] - ends[0][1]) < 1e-9
          )
            return failure('edge-on');
          lines.push(ends);
        }
        const [[a1, b1], [a2, b2]] = lines as [[UV, UV], [UV, UV]];
        const length = Math.hypot(b1[0] - a1[0], b1[1] - a1[1]);
        const d: UV = [(b1[0] - a1[0]) / length, (b1[1] - a1[1]) / length];
        const e2: UV = [b2[0] - a2[0], b2[1] - a2[1]];
        if (
          Math.abs(d[0] * e2[1] - d[1] * e2[0]) >
          1e-6 * Math.max(1, Math.hypot(...e2))
        )
          return failure('not-parallel');
        const n: UV = [-d[1], d[0]];
        const offset = (p: UV) => p[0] * n[0] + p[1] * n[1];
        const gap = offset(a2) - offset(a1);
        if (Math.abs(gap) < 1e-9) return failure('degenerate');
        // Midway across, spanning both edges along their direction.
        const along = [a1, b1, a2, b2].map((p) => p[0] * d[0] + p[1] * d[1]);
        const mid = offset(a1) + gap / 2;
        const at = (t: number): UV => [
          d[0] * t + n[0] * mid,
          d[1] * t + n[1] * mid
        ];
        return {
          ok: true,
          resolved: {
            kind: 'centerline',
            segment: [at(Math.min(...along)), at(Math.max(...along))],
            label: ''
          }
        };
      }
      const refs =
        annotation.mode === 'points'
          ? [annotation.from, annotation.to]
          : [...annotation.through];
      const points: UV[] = [];
      for (const ref of refs) {
        const found = pointOf(view, ref, bodies, null, null, marks);
        if (!found.ok) return failure(found.reason);
        points.push(found.point.uv);
      }
      if (annotation.mode === 'points') {
        const [a, b] = points as [UV, UV];
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9)
          return failure('degenerate');
        return {
          ok: true,
          resolved: { kind: 'centerline', segment: [a, b], label: '' }
        };
      }
      const [a, b, c] = points as [UV, UV, UV];
      const d2 =
        2 *
        (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
      const span = Math.max(
        Math.hypot(b[0] - a[0], b[1] - a[1]),
        Math.hypot(c[0] - a[0], c[1] - a[1])
      );
      if (Math.abs(d2) <= 1e-9 * Math.max(1, span * span))
        return failure('collinear');
      const sq = (p: UV) => p[0] * p[0] + p[1] * p[1];
      const center: UV = [
        (sq(a) * (b[1] - c[1]) +
          sq(b) * (c[1] - a[1]) +
          sq(c) * (a[1] - b[1])) /
          d2,
        (sq(a) * (c[0] - b[0]) +
          sq(b) * (a[0] - c[0]) +
          sq(c) * (b[0] - a[0])) /
          d2
      ];
      return {
        ok: true,
        resolved: {
          kind: 'centerline',
          circle: {
            center,
            radius: Math.hypot(a[0] - center[0], a[1] - center[1])
          },
          label: ''
        }
      };
    }
  }
}

/**
 * What `annotation` measures in `view` of the current model, or why it no
 * longer can. A note without a view needs no model at all.
 */
export function resolveDrawingAnnotation(
  annotation: DrawingAnnotation,
  view: DrawingView | undefined,
  bodies: AnnotationBodies,
  units: UnitSystem,
  /** M01: a hole's callout data, by the hole's feature id. */
  holes?: HoleCalloutLookup,
  /** D02 v70: the sheet's number format; absent prints in `units`. */
  format: DrawingNumberFormat = drawingNumberFormat(undefined, units),
  /** D02 v73: the sheet's annotations, for points that marks mark. */
  marks?: MarkLookup,
  /** D02 v80: the assembly's BOM, for parts lists and balloons. */
  bom?: SheetBom,
  /** D02 v92: the project's pictures, for sheet images. */
  pictures?: SheetPictureLookup,
  /**
   * D07 v98: how many datum feature symbols declare each letter across the
   * drawing; absent skips the datum checks (a draft before it is placed).
   */
  datums?: DatumLetters
): AnnotationResolution {
  if (isDrawingToleranceAnnotation(annotation))
    return resolveToleranceAnnotation(
      annotation,
      view,
      bodies,
      format,
      marks,
      datums
    );
  if (annotation.kind === 'image') {
    const picture = pictures?.get(annotation.referenceImageId);
    if (!picture) return failure('image-missing');
    return {
      ok: true,
      resolved: {
        kind: 'image',
        label: '',
        name: picture.name,
        widthMm: annotation.widthMm,
        heightMm:
          (annotation.widthMm * picture.pixelHeight) / picture.pixelWidth,
        checksumSha256: picture.checksumSha256,
        contentType: picture.contentType
      }
    };
  }
  if (annotation.kind === 'general-tolerance')
    return {
      ok: true,
      resolved: generalToleranceTable(annotation, format)
    };
  if (annotation.kind === 'hole-table') {
    if (!view) return failure('not-in-view');
    const table = holeTable(view, bodies, holes, format);
    return table === 'hole-unnamed'
      ? failure('hole-unnamed')
      : table
        ? { ok: true, resolved: table }
        : failure('no-holes');
  }
  if (annotation.kind === 'bom-table') {
    if (!bom || bom.rows.length === 0) return failure('no-bom');
    const columns = (annotation.columns ?? DEFAULT_BOM_COLUMNS).map((key) =>
      bom.columns.find((column) => column.key === key)!
    );
    return {
      ok: true,
      resolved: {
        kind: 'bom-table',
        label: '',
        header: columns.map((column) => column.label),
        numeric: columns.map((column) => column.numeric),
        rows: bom.rows.map((row) =>
          columns.map((column) => row.cells[column.key])
        )
      }
    };
  }
  if (annotation.kind === 'balloon') {
    if (!view) return failure('not-in-view');
    const item = bom?.itemByComponent.get(annotation.componentId);
    if (item === undefined) return failure('not-in-bom');
    // The number is its row's: an edge of a part in another row would carry
    // the wrong item number onto the paper. (Copies of one part share a row,
    // so any of them reads the same number.)
    const onPart = [...bom!.bodyByComponent].some(
      ([componentId, bodyId]) =>
        bodyId === annotation.leader.bodyId &&
        bom!.itemByComponent.get(componentId) === item
    );
    if (!onPart) return failure('not-on-part');
    const found = lookupEdge(annotation.leader, view, bodies);
    if (!found.ok) return failure(found.reason);
    return {
      ok: true,
      resolved: {
        kind: 'balloon',
        label: String(item),
        ...leaderOf(view, annotation.leader, found.edge)
      }
    };
  }
  if (annotation.kind === 'note') {
    const label = annotation.text;
    if (!annotation.leader || !view)
      return { ok: true, resolved: { kind: 'note', label } };
    const found = lookupEdge(annotation.leader, view, bodies);
    if (!found.ok) return failure(found.reason);
    return {
      ok: true,
      resolved: {
        kind: 'note',
        label,
        ...leaderOf(view, annotation.leader, found.edge)
      }
    };
  }
  if (!view) return failure('not-in-view');
  if (isDrawingGeometryAnnotation(annotation))
    return resolveGeometryAnnotation(annotation, view, bodies, marks);
  // An isometric projection shortens every length by a direction-dependent
  // factor, so a span or angle read off it is not the part's. A circle seen
  // face-on there is true size and may still be dimensioned.
  if (
    view.orientation === 'iso' &&
    (annotation.kind === 'linear' ||
      annotation.kind === 'angle' ||
      annotation.kind === 'three-point-angle' ||
      annotation.kind === 'distance')
  )
    return failure('foreshortened');
  const decimals =
    annotation.decimals ??
    (annotation.kind === 'angle' ||
    annotation.kind === 'arc-angle' ||
    annotation.kind === 'three-point-angle'
      ? format.angleDecimals
      : format.lengthDecimals);
  /** A length in document units, printed. */
  const length = (n: number, d = decimals) =>
    writeNumber(n * format.lengthFactor, d, 'length', format, true);
  const angle = (n: number, d: number) =>
    writeNumber(n, d, 'angle', format, true);
  const measuredLength = (symbol: string, n: number): Measured => ({
    symbol,
    value: n * format.lengthFactor,
    decimals,
    kind: 'length'
  });
  switch (annotation.kind) {
    case 'arc-angle': {
      // An arc seen face-on: its included angle at its centre, between its
      // two ends, the way the arc runs (past 180° when it does).
      const found = lookupEdge(annotation.edge, view, bodies);
      if (!found.ok) return failure(found.reason);
      const circle = faceOnCircle(view, found.edge);
      if (!circle.ok) return failure(circle.reason);
      const ends = edgeEndsWithDepth(view, found.edge);
      if (!ends) return failure('closed-edge');
      const polyline = projectedPolyline(view, found.edge);
      const middle = Math.floor(polyline.length / 4) * 2;
      const through: UV = [polyline[middle]!, polyline[middle + 1]!];
      const c = circle.center;
      const at = (p: UV) => Math.atan2(p[1] - c[1], p[0] - c[0]);
      const turn = (from: number, to: number) => {
        let delta = to - from;
        while (delta <= 0) delta += 2 * Math.PI;
        return delta;
      };
      const a1 = at(ends[0].uv);
      const ccw = turn(a1, at(ends[1].uv));
      // The arc runs counter-clockwise from its first end when its middle
      // lies within that turn, else clockwise.
      const sweep = turn(a1, at(through)) < ccw ? ccw : 2 * Math.PI - ccw;
      const value = (sweep * 180) / Math.PI;
      return {
        ok: true,
        resolved: {
          kind: 'angle',
          vertex: c,
          rays: [
            [c, ends[0].uv],
            [c, ends[1].uv]
          ],
          value,
          through,
          ...formatDimension(
            annotation,
            { symbol: '', value, decimals, kind: 'angle' },
            format
          )
        }
      };
    }
    case 'three-point-angle': {
      // The angle at the vertex between the lines to the other two points,
      // true only when all three lie in one plane parallel to the view.
      const found: ViewPoint[] = [];
      for (const ref of [annotation.vertex, annotation.from, annotation.to]) {
        const point = pointOf(view, ref, bodies, null, null, marks);
        if (!point.ok) return failure(point.reason);
        found.push(point.point);
      }
      const [v, a, b] = found as [ViewPoint, ViewPoint, ViewPoint];
      const da: UV = [a.uv[0] - v.uv[0], a.uv[1] - v.uv[1]];
      const db: UV = [b.uv[0] - v.uv[0], b.uv[1] - v.uv[1]];
      const la = Math.hypot(...da);
      const lb = Math.hypot(...db);
      const span = Math.max(la, lb);
      // Depth first: points the view sees on one line may still make an
      // angle in the model, just not one this view shows true.
      if (!parallelToView(v, a, span) || !parallelToView(v, b, span))
        return failure('foreshortened');
      if (
        la <= 1e-9 * Math.max(1, span) ||
        lb <= 1e-9 * Math.max(1, span) ||
        Math.abs(da[0] * db[1] - da[1] * db[0]) <= 1e-9 * la * lb
      )
        return failure('no-angle');
      const cos = Math.min(
        1,
        Math.max(-1, (da[0] * db[0] + da[1] * db[1]) / (la * lb))
      );
      const value = (Math.acos(cos) * 180) / Math.PI;
      return {
        ok: true,
        resolved: {
          kind: 'angle',
          vertex: v.uv,
          rays: [
            [v.uv, a.uv],
            [v.uv, b.uv]
          ],
          value,
          ...formatDimension(
            annotation,
            { symbol: '', value, decimals, kind: 'angle' },
            format
          )
        }
      };
    }
    case 'distance': {
      const ends: Extract<DistanceEnd, { ok: true }>[] = [];
      for (const target of [annotation.from, annotation.to]) {
        const end = distanceEnd(target, view, bodies, marks);
        if (!end.ok) return failure(end.reason);
        ends.push(end);
      }
      const feet = distanceFeet(ends[0]!.end, ends[1]!.end, annotation.extent);
      if (!feet.ok) return failure(feet.reason);
      const du = feet.to[0] - feet.from[0];
      const dv = feet.to[1] - feet.from[1];
      const value = Math.hypot(du, dv);
      return {
        ok: true,
        resolved: {
          kind: 'linear',
          axis: [du / value, dv / value],
          from: feet.from,
          to: feet.to,
          value,
          ...formatDimension(annotation, measuredLength('', value), format)
        }
      };
    }
    case 'linear': {
      const frame = drawingViewFrame(view);
      const [along, across] =
        annotation.direction === 'horizontal'
          ? [frame.x, frame.up]
          : annotation.direction === 'vertical'
            ? [frame.up, frame.x]
            : [null, null];
      const from = pointOf(view, annotation.from, bodies, along, across, marks);
      if (!from.ok) return failure(from.reason);
      const to = pointOf(view, annotation.to, bodies, along, across, marks);
      if (!to.ok) return failure(to.reason);
      const du = to.point.uv[0] - from.point.uv[0];
      const dv = to.point.uv[1] - from.point.uv[1];
      let axis: UV;
      // Horizontal and vertical spans are distances along a model axis in
      // a principal view, true whatever the depths. An aligned span is the
      // points' true distance only when they lie in one plane parallel to
      // the view.
      if (annotation.direction === 'horizontal') axis = [1, 0];
      else if (annotation.direction === 'vertical') axis = [0, 1];
      else {
        const length = Math.hypot(du, dv);
        if (length < 1e-9) return failure('degenerate');
        if (!parallelToView(from.point, to.point, length))
          return failure('foreshortened');
        axis = [du / length, dv / length];
      }
      const value = Math.abs(du * axis[0] + dv * axis[1]);
      // Two points level along the measured axis (a Horizontal on a
      // vertical edge) span nothing there: no "0" dimension.
      if (value <= 1e-9 * Math.max(1, Math.abs(du), Math.abs(dv)))
        return failure('degenerate');
      return {
        ok: true,
        resolved: {
          kind: 'linear',
          axis,
          from: from.point.uv,
          to: to.point.uv,
          value,
          ...formatDimension(
            annotation,
            measuredLength(annotation.diameter ? 'Ø' : '', value),
            format
          )
        }
      };
    }
    case 'radius':
    case 'diameter': {
      if ('face' in annotation) {
        const found = lookupFace(annotation.face, view, bodies);
        if (!found.ok) return failure(found.reason);
        const tube = blendTubeInView(
          view,
          found.face,
          found.faces,
          found.edges,
          annotation.side
        );
        if (!tube.ok) return failure(tube.reason);
        return {
          ok: true,
          resolved: {
            kind: 'radius',
            center: tube.center,
            radius: tube.radius,
            ...(tube.arc ? { arc: tube.arc } : {}),
            value: tube.radius,
            ...formatDimension(
              annotation,
              measuredLength('R', tube.radius),
              format
            )
          }
        };
      }
      const found = lookupEdge(annotation.edge, view, bodies);
      if (!found.ok) return failure(found.reason);
      const circle = faceOnCircle(view, found.edge);
      if (!circle.ok) return failure(circle.reason);
      const value =
        annotation.kind === 'radius' ? circle.radius : 2 * circle.radius;
      if (annotation.countersink) {
        const rim = lookupEdge(annotation.countersink, view, bodies);
        if (!rim.ok) return failure(rim.reason);
        const body = annotationBody(bodies, view, annotation.edge.bodyId);
        const reading = readCountersink(
          found.edge,
          rim.edge,
          body?.topology?.edges ?? [],
          body?.topology?.faces ?? []
        );
        if (!reading.ok) return failure(reading.reason);
        const number = (n: number) => length(n);
        const hole = reading.through
          ? `Ø${number(value)} THRU`
          : `Ø${number(value)} × ${number(reading.holeDepth)} DEEP`;
        return {
          ok: true,
          resolved: {
            kind: 'diameter',
            center: circle.center,
            radius: circle.radius,
            value,
            ...formatDimension(
              annotation,
              `${hole}, CSK Ø${number(2 * reading.rim.radius)} × ${angle(reading.angleDeg, format.angleDecimals)}`,
              format
            )
          }
        };
      }
      if (annotation.counterbore) {
        const bore = lookupEdge(annotation.counterbore, view, bodies);
        if (!bore.ok) return failure(bore.reason);
        const body = annotationBody(bodies, view, annotation.edge.bodyId);
        const reading = readCounterbore(
          found.edge,
          bore.edge,
          body?.topology?.edges ?? [],
          body?.topology?.faces ?? []
        );
        if (!reading.ok) return failure(reading.reason);
        const number = (n: number) => length(n);
        const hole = reading.through
          ? `Ø${number(value)} THRU`
          : `Ø${number(value)} × ${number(reading.holeDepth)} DEEP`;
        return {
          ok: true,
          resolved: {
            kind: 'diameter',
            center: circle.center,
            radius: circle.radius,
            value,
            ...formatDimension(
              annotation,
              `${hole}, CBORE Ø${number(2 * reading.bore.radius)} × ${number(reading.depth)} DEEP`,
              format
            )
          }
        };
      }
      // M01: a diameter on the rim of a hole's bore reads the hole's
      // callout (its standard, its thread, cosmetic or cut), where the hole
      // says more than its diameter. A toleranced diameter states the
      // diameter it tolerances instead (v68).
      // v105: an ISO 286 fit is the diameter's tolerance, its limits read
      // from the tables for the size the model has now.
      if (annotation.kind === 'diameter' && annotation.fit) {
        const deviations = fitDeviations(
          annotation.fit,
          value * millimetresPerUnit(units)
        );
        if (!deviations) return failure('fit-out-of-range');
        const printed = (mm: number) =>
          Number((mm / millimetresPerUnit(format.units)).toFixed(6));
        return {
          ok: true,
          resolved: {
            kind: 'diameter',
            center: circle.center,
            radius: circle.radius,
            ...(isClosed(found.edge)
              ? {}
              : { arc: projectedPolyline(view, found.edge) }),
            value,
            ...formatDimension(
              annotation,
              {
                ...measuredLength('Ø', value),
                designation: annotation.fit,
                fitTolerance: {
                  kind: 'deviation',
                  upper: printed(deviations.upper),
                  lower: printed(deviations.lower)
                }
              },
              format
            )
          }
        };
      }
      let callout =
        annotation.kind === 'diameter' && holes && !annotation.tolerance
          ? boreCallout(
              annotationBody(bodies, view, annotation.edge.bodyId),
              found.edge,
              circle.radius,
              holes,
              view.viewId
            )
          : null;
      // v105: a thread class follows the tapped hole's designation, in its
      // own system: ISO 965 for metric threads, UN for inch ones.
      if (annotation.kind === 'diameter' && annotation.threadClass) {
        const thread = callout?.thread;
        if (!callout || !thread) return failure('not-threaded');
        const inch = annotation.threadClass.endsWith('B');
        if (inch !== !thread.designation.startsWith('M'))
          return failure('thread-class-mismatch');
        callout = {
          ...callout,
          thread: {
            ...thread,
            designation: `${thread.designation}-${annotation.threadClass}`
          }
        };
      }
      return {
        ok: true,
        resolved: {
          kind: annotation.kind,
          center: circle.center,
          radius: circle.radius,
          ...(isClosed(found.edge)
            ? {}
            : { arc: projectedPolyline(view, found.edge) }),
          value,
          ...formatDimension(
            annotation,
            callout
              ? holeCalloutLabel(callout, (n) => length(n))
              : measuredLength(annotation.kind === 'radius' ? 'R' : 'Ø', value),
            format
          )
        }
      };
    }
    case 'chamfer': {
      const found = lookupFace(annotation.face, view, bodies);
      if (!found.ok) return failure(found.reason);
      const frame = drawingViewFrame(view);
      // A planar chamfer is true size only edge-on.
      const normal = found.face.geometry?.normal;
      if (normal && Math.abs(dot(normal, frame.direction)) > 1e-6)
        return failure('foreshortened');
      const chamfer = readChamfer(
        found.face,
        found.faces,
        found.edges,
        frame.direction
      );
      if (!chamfer.ok) return failure(chamfer.reason);
      const project = (point: Vector3): UV => {
        const p = projectToView(frame, point);
        return [p.u, p.v];
      };
      let segments: [UV, UV][];
      if (chamfer.kind === 'cone') {
        // True size only side-on: the axis lies in the view's plane.
        if (Math.abs(dot(chamfer.axis, frame.direction)) > 1e-6)
          return failure('foreshortened');
        const outward = cross(frame.direction, chamfer.axis);
        const width = norm(outward);
        segments = [1, -1].map((sign) =>
          chamfer.ends.map((end) =>
            project(
              add(end.center, scale(outward, (sign * end.radius) / width))
            )
          )
        ) as [UV, UV][];
      } else {
        // A planar chamfer is true size where its ends are seen end-on.
        if (
          chamfer.ends.some(
            (end) =>
              Math.abs(Math.abs(dot(end.direction, frame.direction)) - 1) > 1e-6
          )
        )
          return failure('foreshortened');
        segments = [chamfer.ends.map((end) => project(end.point)) as [UV, UV]];
      }
      const lengthDecimals = annotation.decimals ?? format.lengthDecimals;
      return {
        ok: true,
        resolved: {
          kind: 'chamfer',
          segments,
          value: chamfer.size,
          angle: chamfer.angleDeg,
          ...formatDimension(
            annotation,
            `${length(chamfer.size, lengthDecimals)} × ${angle(chamfer.angleDeg, format.angleDecimals)}`,
            format
          )
        }
      };
    }
    case 'angle': {
      const rays: [UV, UV][] = [];
      for (const ref of annotation.edges) {
        const found = lookupEdge(ref, view, bodies);
        if (!found.ok) return failure(found.reason);
        const straight = straightEnds(view, found.edge);
        if (!straight.ok) return failure(straight.reason);
        rays.push(straight.ends);
      }
      const [[p1, q1], [p2, q2]] = rays as [[UV, UV], [UV, UV]];
      const e1: UV = [q1[0] - p1[0], q1[1] - p1[1]];
      const e2: UV = [q2[0] - p2[0], q2[1] - p2[1]];
      const cross = e1[0] * e2[1] - e1[1] * e2[0];
      if (Math.abs(cross) <= 1e-9 * Math.hypot(...e1) * Math.hypot(...e2))
        return failure('parallel');
      // Where the two lines meet; each ray runs from there to its edge's
      // further end.
      const t = ((p2[0] - p1[0]) * e2[1] - (p2[1] - p1[1]) * e2[0]) / cross;
      const vertex: UV = [p1[0] + t * e1[0], p1[1] + t * e1[1]];
      const ordered = rays.map(([a, b]) => {
        const da = Math.hypot(a[0] - vertex[0], a[1] - vertex[1]);
        const db = Math.hypot(b[0] - vertex[0], b[1] - vertex[1]);
        return da <= db ? ([a, b] as [UV, UV]) : ([b, a] as [UV, UV]);
      }) as [[UV, UV], [UV, UV]];
      const outside = annotation.outside;
      const near = outside === undefined ? null : ordered[outside][0];
      if (outside !== undefined) {
        // Turned outward: the ray runs from the vertex the other way along
        // its edge's line, as far as the edge reaches.
        const far = ordered[outside][1];
        ordered[outside] = [
          vertex,
          [2 * vertex[0] - far[0], 2 * vertex[1] - far[1]]
        ];
      }
      const d = ordered.map(([, far]) => {
        const length = Math.hypot(far[0] - vertex[0], far[1] - vertex[1]);
        return [
          (far[0] - vertex[0]) / length,
          (far[1] - vertex[1]) / length
        ] as UV;
      });
      const cos = Math.min(
        1,
        Math.max(-1, d[0]![0] * d[1]![0] + d[0]![1] * d[1]![1])
      );
      const value = (Math.acos(cos) * 180) / Math.PI;
      return {
        ok: true,
        resolved: {
          kind: 'angle',
          vertex,
          rays: ordered,
          value,
          ...formatDimension(
            annotation,
            { symbol: '', value, decimals, kind: 'angle' },
            format
          ),
          ...(outside !== undefined
            ? { outside: { index: outside, from: near! } }
            : {})
        }
      };
    }
  }
}

export type CounterboreReading =
  | {
      ok: true;
      bore: { center: Vector3; axis: Vector3; radius: number };
      /** Where the bore opens, and its floor, on the axis. */
      opening: Vector3;
      floor: Vector3;
      depth: number;
      /** The hole's end opposite its floor. */
      end: Vector3;
      holeDepth: number;
      /** The hole runs out of the part. */
      through: boolean;
    }
  | { ok: false; reason: AnnotationBreak };

/**
 * A counterbored hole read from its two rims: the bore coaxial with the
 * hole and larger, one of the bore's rims on the hole's (its floor), the
 * other where it opens. The hole is THRU when its far rim lies on the
 * part's extreme along the axis. Within the kernel's relative tolerance.
 */
export function readCounterbore(
  holeEdge: EdgeTopology,
  boreEdge: EdgeTopology,
  edges: readonly EdgeTopology[],
  faces: readonly FaceTopology[]
): CounterboreReading {
  const hole = holeEdge.curve?.circle;
  const bore = boreEdge.curve?.circle;
  if (!hole || !bore) return { ok: false, reason: 'not-circular' };
  const axis = scale(hole.axis, 1 / norm(hole.axis));
  const tol = 1e-6 * Math.max(1, norm(hole.center), bore.radius);
  const offAxis = (point: Vector3) => {
    const between = sub(point, hole.center);
    const along = dot(between, axis);
    return Math.sqrt(Math.max(0, dot(between, between) - along * along));
  };
  if (
    Math.abs(Math.abs(dot(axis, bore.axis) / norm(bore.axis)) - 1) > 1e-6 ||
    offAxis(bore.center) > tol ||
    bore.radius <= hole.radius + tol
  )
    return { ok: false, reason: 'not-a-counterbore' };
  const rims = (radius: number) => {
    const out: number[] = [];
    for (const edge of edges) {
      const c = edge.curve?.circle;
      if (
        !c ||
        Math.abs(c.radius - radius) > tol ||
        Math.abs(Math.abs(dot(axis, c.axis) / norm(c.axis)) - 1) > 1e-6 ||
        offAxis(c.center) > tol
      )
        continue;
      const t = dot(sub(c.center, hole.center), axis);
      if (!out.some((known) => Math.abs(known - t) <= tol)) out.push(t);
    }
    return out;
  };
  const boreRims = rims(bore.radius);
  const holeRims = rims(hole.radius);
  const floor = boreRims.find((t) =>
    holeRims.some((h) => Math.abs(h - t) <= tol)
  );
  if (boreRims.length !== 2 || holeRims.length < 2 || floor === undefined)
    return { ok: false, reason: 'not-a-counterbore' };
  const opening = boreRims.find((t) => t !== floor)!;
  // The hole runs away from the bore's opening.
  const away = Math.sign(floor - opening);
  // A bore's floor faces its opening (normals point out of the material);
  // a shaft's shoulder between two diameters faces the other way.
  const floorPoint = add(hole.center, scale(axis, floor));
  const floorFace = faces.find((face) => {
    const g = face.geometry;
    return (
      g?.normal !== undefined &&
      g.planeOffset !== undefined &&
      Math.abs(Math.abs(dot(g.normal, axis)) - 1) <= 1e-6 &&
      Math.abs(dot(g.normal, floorPoint) - g.planeOffset) <= tol
    );
  });
  if (!floorFace || dot(floorFace.geometry!.normal!, axis) * away >= 0)
    return { ok: false, reason: 'not-a-counterbore' };
  const end = holeRims.reduce((far, t) =>
    (t - floor) * away > (far - floor) * away ? t : far
  );
  let extreme = end;
  for (const edge of edges) {
    const p = edge.points;
    for (let i = 0; i + 2 < p.length; i += 3) {
      const t = dot(
        sub({ x: p[i]!, y: p[i + 1]!, z: p[i + 2]! }, hole.center),
        axis
      );
      if ((t - extreme) * away > 0) extreme = t;
    }
  }
  const at = (t: number) => add(hole.center, scale(axis, t));
  return {
    ok: true,
    bore,
    opening: at(opening),
    floor: at(floor),
    depth: Math.abs(floor - opening),
    end: at(end),
    holeDepth: Math.abs(end - floor),
    through: Math.abs(extreme - end) <= tol
  };
}

export type CountersinkReading =
  | {
      ok: true;
      /** The cone's outer rim, where it opens onto the face. */
      rim: { center: Vector3; axis: Vector3; radius: number };
      /** Its included angle, in degrees. */
      angleDeg: number;
      cone: FaceTopology;
      /** Where the countersink opens, and the hole's far end, on the axis. */
      opening: Vector3;
      end: Vector3;
      /** From where it opens to the hole's far end. */
      holeDepth: number;
      through: boolean;
    }
  | { ok: false; reason: AnnotationBreak };

/**
 * A countersunk hole read from the hole's rim and the cone's outer rim: a
 * cone coaxial with the hole bounded by that rim, opening onto the face.
 * The hole is THRU when its far rim lies on the part's extreme along the
 * axis; a blind hole's depth runs from where the countersink opens.
 */
export function readCountersink(
  holeEdge: EdgeTopology,
  rimEdge: EdgeTopology,
  edges: readonly EdgeTopology[],
  faces: readonly FaceTopology[]
): CountersinkReading {
  const hole = holeEdge.curve?.circle;
  const rim = rimEdge.curve?.circle;
  if (!hole || !rim) return { ok: false, reason: 'not-circular' };
  const axis = scale(hole.axis, 1 / norm(hole.axis));
  const tol = 1e-6 * Math.max(1, norm(hole.center), rim.radius);
  const offAxis = (point: Vector3) => {
    const between = sub(point, hole.center);
    const along = dot(between, axis);
    return Math.sqrt(Math.max(0, dot(between, between) - along * along));
  };
  const coaxial = (direction: Vector3, point: Vector3) =>
    Math.abs(Math.abs(dot(axis, direction) / norm(direction)) - 1) <= 1e-6 &&
    offAxis(point) <= tol;
  if (!coaxial(rim.axis, rim.center) || rim.radius <= hole.radius + tol)
    return { ok: false, reason: 'not-a-countersink' };
  const cone = faces.find((face) => {
    const g = face.geometry;
    return (
      g?.apex !== undefined &&
      g.axis !== undefined &&
      g.halfAngle !== undefined &&
      (rimEdge.adjacentFaceHashes ?? []).includes(face.hash) &&
      coaxial(g.axis, g.apex)
    );
  });
  if (!cone) return { ok: false, reason: 'not-a-countersink' };
  const opening = dot(sub(rim.center, hole.center), axis);
  const holeRims: number[] = [];
  for (const edge of edges) {
    const c = edge.curve?.circle;
    if (
      !c ||
      Math.abs(c.radius - hole.radius) > tol ||
      !coaxial(c.axis, c.center)
    )
      continue;
    const t = dot(sub(c.center, hole.center), axis);
    if (!holeRims.some((known) => Math.abs(known - t) <= tol)) holeRims.push(t);
  }
  if (holeRims.length < 2) return { ok: false, reason: 'not-a-countersink' };
  const nearest = holeRims.reduce((best, t) =>
    Math.abs(t - opening) < Math.abs(best - opening) ? t : best
  );
  const away = Math.sign(nearest - opening) || 1;
  const end = holeRims.reduce((far, t) =>
    (t - opening) * away > (far - opening) * away ? t : far
  );
  let extreme = end;
  for (const edge of edges) {
    const p = edge.points;
    for (let i = 0; i + 2 < p.length; i += 3) {
      const t = dot(
        sub({ x: p[i]!, y: p[i + 1]!, z: p[i + 2]! }, hole.center),
        axis
      );
      if ((t - extreme) * away > 0) extreme = t;
    }
  }
  const at = (t: number) => add(hole.center, scale(axis, t));
  return {
    ok: true,
    rim,
    angleDeg: (2 * cone.geometry!.halfAngle! * 180) / Math.PI,
    cone,
    opening: at(opening),
    end: at(end),
    holeDepth: Math.abs(end - opening),
    through: Math.abs(extreme - end) <= tol
  };
}

/**
 * D06: what a dimension measures, in model space, for checking a sheet's
 * dimension set against the part. The same lookups as
 * {@link resolveDrawingAnnotation}, so it reads only what that would draw;
 * `null` for a note or anything that does not resolve.
 */
export type AnnotationModelReading =
  | {
      kind: 'linear';
      bodyIds: [string, string];
      from: Vector3;
      to: Vector3;
      /** The measured model direction; absent for an aligned span. */
      direction?: Vector3;
      /** Stated as a diameter (Ø) across a cylinder seen side-on. */
      diameter: boolean;
    }
  | {
      kind: 'radius' | 'diameter';
      bodyId: string;
      circle: { center: Vector3; axis: Vector3; radius: number };
      /** v50: a counterbored hole's callout states its bore and depth too. */
      counterbore?: Extract<CounterboreReading, { ok: true }>;
      /** v51: a countersunk hole's callout states its cone too. */
      countersink?: Extract<CountersinkReading, { ok: true }>;
    }
  | {
      kind: 'chamfer';
      bodyId: string;
      face: FaceTopology;
      size: number;
      angleDeg: number;
    }
  | {
      /** v49: a revolved blend's radius, read from its torus face. */
      kind: 'blend-radius';
      bodyId: string;
      face: FaceTopology;
      radius: number;
    }
  | {
      /** The angle between two straight edges in a view, in degrees. */
      kind: 'angle';
      bodyIds: [string, string];
      edges: [EdgeTopology, EdgeTopology];
      value: number;
    };

/** The body a dimension point belongs to. */
/** The body a centre or intersection mark marks: '' across two bodies. */
function markBody(mark: DrawingAnnotation | undefined): string {
  if (mark?.kind === 'center-mark') return mark.edge.bodyId;
  if (mark?.kind === 'intersection-mark')
    return mark.edges[0].bodyId === mark.edges[1].bodyId
      ? mark.edges[0].bodyId
      : '';
  return '';
}

function pointBody(point: DrawingPointRef): string {
  if (point.anchor === 'mark') return '';
  if ('faces' in point) return point.faces[0].bodyId;
  if ('like' in point) return point.face.bodyId;
  return point.edge.bodyId;
}

export function annotationModelReading(
  annotation: DrawingAnnotation,
  view: DrawingView | undefined,
  bodies: AnnotationBodies,
  units: UnitSystem,
  /** v73: the sheet's annotations, for points that marks mark. */
  marks?: MarkLookup
): AnnotationModelReading | null {
  if (
    !view ||
    annotation.kind === 'note' ||
    annotation.kind === 'distance' ||
    annotation.kind === 'arc-angle' ||
    annotation.kind === 'three-point-angle' ||
    annotation.kind === 'bom-table' ||
    annotation.kind === 'hole-table' ||
    annotation.kind === 'balloon' ||
    annotation.kind === 'image' ||
    annotation.kind === 'general-tolerance' ||
    isDrawingToleranceAnnotation(annotation) ||
    isDrawingGeometryAnnotation(annotation)
  )
    return null;
  const resolution = resolveDrawingAnnotation(
    annotation,
    view,
    bodies,
    units,
    undefined,
    undefined,
    marks
  );
  if (!resolution.ok) return null;
  if (annotation.kind === 'angle') {
    if (resolution.resolved.kind !== 'angle') return null;
    const found = annotation.edges.map((ref) => lookupEdge(ref, view, bodies));
    const [a, b] = found;
    if (!a?.ok || !b?.ok) return null;
    return {
      kind: 'angle',
      bodyIds: [annotation.edges[0].bodyId, annotation.edges[1].bodyId],
      edges: [a.edge, b.edge],
      value: resolution.resolved.value
    };
  }
  const frame = drawingViewFrame(view);
  if (annotation.kind === 'linear') {
    const [along, across] =
      annotation.direction === 'horizontal'
        ? [frame.x, frame.up]
        : annotation.direction === 'vertical'
          ? [frame.up, frame.x]
          : [null, null];
    const from = pointOf(view, annotation.from, bodies, along, across, marks);
    const to = pointOf(view, annotation.to, bodies, along, across, marks);
    if (!from.ok || !to.ok) return null;
    // A virtual sharp's two faces may lie on two bodies; it then reads as a
    // span between bodies. A mark reads as the body it marks.
    const bodyOf = (point: DrawingPointRef) =>
      'faces' in point && point.faces[0].bodyId !== point.faces[1].bodyId
        ? ''
        : point.anchor === 'mark'
          ? markBody(marks?.(point.annotationId))
          : pointBody(point);
    return {
      kind: 'linear',
      bodyIds: [bodyOf(annotation.from), bodyOf(annotation.to)],
      from: from.point.model,
      to: to.point.model,
      ...(along ? { direction: along } : {}),
      diameter: annotation.diameter === true
    };
  }
  if (annotation.kind === 'chamfer') {
    const found = lookupFace(annotation.face, view, bodies);
    if (!found.ok || resolution.resolved.kind !== 'chamfer') return null;
    return {
      kind: 'chamfer',
      bodyId: annotation.face.bodyId,
      face: found.face,
      size: resolution.resolved.value,
      angleDeg: resolution.resolved.angle
    };
  }
  if ('face' in annotation) {
    const found = lookupFace(annotation.face, view, bodies);
    if (!found.ok || resolution.resolved.kind !== 'radius') return null;
    return {
      kind: 'blend-radius',
      bodyId: annotation.face.bodyId,
      face: found.face,
      radius: resolution.resolved.radius
    };
  }
  const found = lookupEdge(annotation.edge, view, bodies);
  const circle = found.ok ? found.edge.curve?.circle : undefined;
  if (!circle) return null;
  if (annotation.countersink) {
    const rim = lookupEdge(annotation.countersink, view, bodies);
    const body = annotationBody(bodies, view, annotation.edge.bodyId);
    const reading =
      found.ok && rim.ok
        ? readCountersink(
            found.edge,
            rim.edge,
            body?.topology?.edges ?? [],
            body?.topology?.faces ?? []
          )
        : null;
    if (!reading?.ok) return null;
    return {
      kind: annotation.kind,
      bodyId: annotation.edge.bodyId,
      circle,
      countersink: reading
    };
  }
  if (annotation.counterbore) {
    // Resolved above, so the bore and its reading are there.
    const bore = lookupEdge(annotation.counterbore, view, bodies);
    const reading =
      found.ok && bore.ok
        ? readCounterbore(
            found.edge,
            bore.edge,
            annotationBody(bodies, view, annotation.edge.bodyId)?.topology
              ?.edges ?? [],
            annotationBody(bodies, view, annotation.edge.bodyId)?.topology
              ?.faces ?? []
          )
        : null;
    if (!reading?.ok) return null;
    return {
      kind: annotation.kind,
      bodyId: annotation.edge.bodyId,
      circle,
      counterbore: reading
    };
  }
  return { kind: annotation.kind, bodyId: annotation.edge.bodyId, circle };
}

// ---------------------------------------------------------------------------
// Layout on the paper

/** Dimension text height, arrowheads and gaps, in paper millimetres. */
export const ANNOTATION_TEXT_MM = 3;
const ARROW_LENGTH_MM = 3;
const ARROW_HALF_WIDTH_MM = 0.5;
/** Gap between the part and an extension line, and its run past the dimension line. */
const EXTENSION_GAP_MM = 1;
const EXTENSION_OVERSHOOT_MM = 2;
/** Text sits this far off its dimension line. */
const TEXT_LIFT_MM = 1;

export interface AnnotationBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnnotationLayout {
  strokes: SheetStroke[];
  texts: SheetText[];
  /** D02 (v92): a sheet image's picture. */
  images?: SheetImage[];
  /** Where the annotation's text sits, for picking and selection. */
  box: AnnotationBox;
}

type XY = [number, number];

function arrow(tip: XY, direction: XY, length = ARROW_LENGTH_MM): SheetStroke {
  const [dx, dy] = direction;
  const bx = tip[0] - dx * length;
  const by = tip[1] - dy * length;
  return {
    kind: 'dimension',
    filled: true,
    closed: true,
    points: [
      tip[0],
      tip[1],
      bx - dy * ARROW_HALF_WIDTH_MM,
      by + dx * ARROW_HALF_WIDTH_MM,
      bx + dy * ARROW_HALF_WIDTH_MM,
      by - dx * ARROW_HALF_WIDTH_MM
    ]
  };
}

function line(a: XY, b: XY): SheetStroke {
  return { kind: 'dimension', points: [a[0], a[1], b[0], b[1]] };
}

/**
 * Text centred on `at` along `angleDeg`, its baseline `TEXT_LIFT_MM` above
 * (on the text's own up side), and the box it covers.
 */
function placedText(
  text: string,
  at: XY,
  angleDeg: number,
  align: 'start' | 'middle' | 'end' = 'middle'
): { text: SheetText; box: AnnotationBox } {
  const safe = sheetSafeText(text);
  const width = textWidthMm(safe, ANNOTATION_TEXT_MM);
  const radians = (angleDeg * Math.PI) / 180;
  const along: XY = [Math.cos(radians), Math.sin(radians)];
  const up: XY = [-along[1], along[0]];
  const baseline: XY = [
    at[0] + up[0] * TEXT_LIFT_MM,
    at[1] + up[1] * TEXT_LIFT_MM
  ];
  const shift = align === 'middle' ? -width / 2 : align === 'end' ? -width : 0;
  const corners: XY[] = [0, width].flatMap((s) =>
    [0, ANNOTATION_TEXT_MM].map(
      (h) =>
        [
          baseline[0] + along[0] * (s + shift) + up[0] * h,
          baseline[1] + along[1] * (s + shift) + up[1] * h
        ] as XY
    )
  );
  const xs = corners.map((corner) => corner[0]);
  const ys = corners.map((corner) => corner[1]);
  const pad = 0.8;
  return {
    text: {
      x: baseline[0],
      y: baseline[1],
      sizeMm: ANNOTATION_TEXT_MM,
      text: safe,
      ...(align !== 'start' ? { align } : {}),
      ...(angleDeg !== 0 ? { angleDeg } : {})
    },
    box: {
      x: Math.min(...xs) - pad,
      y: Math.min(...ys) - pad,
      width: Math.max(...xs) - Math.min(...xs) + 2 * pad,
      height: Math.max(...ys) - Math.min(...ys) + 2 * pad
    }
  };
}

/** v68: a stacked pair's text size, and the gap between its lines. */
const STACK_TEXT_MM = 0.7 * ANNOTATION_TEXT_MM;
const STACK_GAP_MM = 0.4;
/** v68: space between a label's parts, and a basic frame's margin. */
const PART_GAP_MM = 0.6;
const FRAME_MARGIN_MM = 0.8;

interface PlacedLabel {
  texts: SheetText[];
  strokes: SheetStroke[];
  box: AnnotationBox;
}

/** The width a label takes along its baseline. */
function labelWidthMm(label: string, text: DimensionText | undefined): number {
  if (!text) return textWidthMm(sheetSafeText(label), ANNOTATION_TEXT_MM);
  return labelParts(text).width;
}

/**
 * Where each part of a stacked or framed label sits along its baseline,
 * from its start: the lead, the stack's two lines (raised and lowered about
 * the lead's middle), then the tail, and the frame's extent.
 */
function labelParts(text: DimensionText): {
  width: number;
  parts: { text: string; at: number; lift: number; size: number }[];
  frame: [number, number] | null;
} {
  const parts: { text: string; at: number; lift: number; size: number }[] = [];
  let at = 0;
  // Sheet text is trimmed, so a part's edge spaces ("2× " before the value,
  // " TYP" after it) are kept as advances.
  const space = textWidthMm(' ', ANNOTATION_TEXT_MM);
  const head = sheetSafeText(text.head);
  if (head) {
    parts.push({ text: head, at, lift: 0, size: ANNOTATION_TEXT_MM });
    at += textWidthMm(head, ANNOTATION_TEXT_MM) + space;
  }
  const lead = sheetSafeText(text.lead);
  const leadWidth = lead ? textWidthMm(lead, ANNOTATION_TEXT_MM) : 0;
  const margin = text.framed ? FRAME_MARGIN_MM : 0;
  const frameStart = at;
  at += margin;
  if (lead) parts.push({ text: lead, at, lift: 0, size: ANNOTATION_TEXT_MM });
  at += leadWidth + margin;
  const frame: [number, number] | null = text.framed ? [frameStart, at] : null;
  if (text.stack) {
    if (lead) at += /\s$/.test(text.lead) ? space : PART_GAP_MM;
    const [upper, lower] = text.stack.map(sheetSafeText) as [string, string];
    const middle = ANNOTATION_TEXT_MM / 2;
    const lowerLift = middle - STACK_TEXT_MM - STACK_GAP_MM / 2;
    parts.push(
      {
        text: upper,
        at,
        lift: lowerLift + STACK_TEXT_MM + STACK_GAP_MM,
        size: STACK_TEXT_MM
      },
      { text: lower, at, lift: lowerLift, size: STACK_TEXT_MM }
    );
    at += Math.max(
      textWidthMm(upper, STACK_TEXT_MM),
      textWidthMm(lower, STACK_TEXT_MM)
    );
  }
  const tail = sheetSafeText(text.tail);
  if (tail) {
    if (/^\s/.test(text.tail)) at += space;
    parts.push({ text: tail, at, lift: 0, size: ANNOTATION_TEXT_MM });
    at += textWidthMm(tail, ANNOTATION_TEXT_MM);
  }
  return { width: at, parts, frame };
}

/**
 * {@link placedText} for a dimension's label: its plain text when it has no
 * parts (so a sheet without v68 formats lays out byte-identical), else each
 * part placed along the same baseline, start-aligned, with a basic
 * dimension's frame as a closed dimension stroke.
 */
function placedLabel(
  label: string,
  text: DimensionText | undefined,
  at: XY,
  angleDeg: number,
  align: 'start' | 'middle' | 'end' = 'middle'
): PlacedLabel {
  if (!text) {
    const placed = placedText(label, at, angleDeg, align);
    return { texts: [placed.text], strokes: [], box: placed.box };
  }
  const { width, parts, frame } = labelParts(text);
  const radians = (angleDeg * Math.PI) / 180;
  const along: XY = [Math.cos(radians), Math.sin(radians)];
  const up: XY = [-along[1], along[0]];
  // A frame's bottom edge clears the dimension line.
  const lift = TEXT_LIFT_MM + (frame ? FRAME_MARGIN_MM : 0);
  const shift = align === 'middle' ? -width / 2 : align === 'end' ? -width : 0;
  const point = (s: number, h: number): XY => [
    at[0] + along[0] * (s + shift) + up[0] * (lift + h),
    at[1] + along[1] * (s + shift) + up[1] * (lift + h)
  ];
  const texts: SheetText[] = parts.map((part) => {
    const [x, y] = point(part.at, part.lift);
    return {
      x,
      y,
      sizeMm: part.size,
      text: part.text,
      ...(angleDeg !== 0 ? { angleDeg } : {})
    };
  });
  const strokes: SheetStroke[] = [];
  const corners: XY[] = [];
  let low = 0;
  let high = ANNOTATION_TEXT_MM;
  for (const part of parts) {
    low = Math.min(low, part.lift);
    high = Math.max(high, part.lift + part.size);
  }
  if (frame) {
    const bottom = -FRAME_MARGIN_MM;
    const top = ANNOTATION_TEXT_MM + FRAME_MARGIN_MM;
    const box = [
      point(frame[0], bottom),
      point(frame[1], bottom),
      point(frame[1], top),
      point(frame[0], top)
    ];
    strokes.push({ kind: 'dimension', closed: true, points: box.flat() });
    low = Math.min(low, bottom);
    high = Math.max(high, top);
  }
  corners.push(
    point(0, low),
    point(width, low),
    point(0, high),
    point(width, high)
  );
  const xs = corners.map((corner) => corner[0]);
  const ys = corners.map((corner) => corner[1]);
  const pad = 0.8;
  return {
    texts,
    strokes,
    box: {
      x: Math.min(...xs) - pad,
      y: Math.min(...ys) - pad,
      width: Math.max(...xs) - Math.min(...xs) + 2 * pad,
      height: Math.max(...ys) - Math.min(...ys) + 2 * pad
    }
  };
}

/** Readable text angle for a line along `direction`: in (−90°, 90°]. */
function readableAngle(direction: XY): number {
  let angle = (Math.atan2(direction[1], direction[0]) * 180) / Math.PI;
  if (angle > 90 + 1e-9) angle -= 180;
  else if (angle <= -90 + 1e-9) angle += 180;
  return Math.abs(angle) < 1e-9 ? 0 : angle;
}

function linearLayout(
  resolved: Extract<ResolvedAnnotation, { kind: 'linear' }>,
  toPage: (u: number, v: number) => XY,
  anchor: XY
): AnnotationLayout {
  const a = toPage(...resolved.from);
  const b = toPage(...resolved.to);
  const d: XY = resolved.axis;
  const n: XY = [-d[1], d[0]];
  const dot = (p: XY, q: XY) => p[0] * q[0] + p[1] * q[1];
  const offset = dot(anchor, n);
  const foot = (p: XY): XY => {
    const shift = offset - dot(p, n);
    return [p[0] + n[0] * shift, p[1] + n[1] * shift];
  };
  const fa = foot(a);
  const fb = foot(b);
  const strokes: SheetStroke[] = [];
  for (const [p, f] of [
    [a, fa],
    [b, fb]
  ] as const) {
    const run = offset - dot(p, n);
    if (Math.abs(run) <= EXTENSION_GAP_MM) continue;
    const s = Math.sign(run);
    strokes.push(
      line(
        [
          p[0] + n[0] * s * EXTENSION_GAP_MM,
          p[1] + n[1] * s * EXTENSION_GAP_MM
        ],
        [
          f[0] + n[0] * s * EXTENSION_OVERSHOOT_MM,
          f[1] + n[1] * s * EXTENSION_OVERSHOOT_MM
        ]
      )
    );
  }
  // Along the dimension line: `low` and `high` are the two feet.
  const [low, high] = dot(fa, d) <= dot(fb, d) ? [fa, fb] : [fb, fa];
  const span = dot(high, d) - dot(low, d);
  const textWidth = labelWidthMm(resolved.label, resolved.text);
  // The text sits mid-span unless the placement is beyond either end; the
  // dimension line then runs out under it.
  const along = dot(anchor, d);
  const inside = along >= dot(low, d) && along <= dot(high, d);
  const centre: XY = inside
    ? [(low[0] + high[0]) / 2, (low[1] + high[1]) / 2]
    : [
        low[0] + d[0] * (along - dot(low, d)),
        low[1] + d[1] * (along - dot(low, d))
      ];
  const arrowsInside = span >= 2 * ARROW_LENGTH_MM + 1;
  const reach = arrowsInside ? 0 : ARROW_LENGTH_MM + 2;
  const start = Math.min(
    dot(low, d) - reach,
    inside ? Infinity : along - textWidth / 2
  );
  const end = Math.max(
    dot(high, d) + reach,
    inside ? -Infinity : along + textWidth / 2
  );
  const at = (t: number): XY => [
    low[0] + d[0] * (t - dot(low, d)),
    low[1] + d[1] * (t - dot(low, d))
  ];
  strokes.push(line(at(start), at(end)));
  const minus: XY = [-d[0], -d[1]];
  strokes.push(
    arrow(low, arrowsInside ? minus : d),
    arrow(high, arrowsInside ? d : minus)
  );
  const placed = placedLabel(
    resolved.label,
    resolved.text,
    centre,
    readableAngle(d)
  );
  strokes.push(...placed.strokes);
  return { strokes, texts: placed.texts, box: placed.box };
}

function radialLayout(
  resolved: Extract<ResolvedAnnotation, { kind: 'radius' | 'diameter' }>,
  toPage: (u: number, v: number) => XY,
  k: number,
  anchor: XY
): AnnotationLayout {
  const c = toPage(...resolved.center);
  const r = resolved.radius * k;
  const reach = Math.hypot(anchor[0] - c[0], anchor[1] - c[1]);
  let u: XY =
    reach > 1e-9
      ? [(anchor[0] - c[0]) / reach, (anchor[1] - c[1]) / reach]
      : [1, 0];
  // A partial arc: the rim point must be on the arc itself. Placed beyond
  // its sweep, the dimension turns to the arc's nearer end.
  const arc = resolved.arc
    ? (() => {
        const points: XY[] = [];
        for (let i = 0; i + 1 < resolved.arc.length; i += 2)
          points.push(toPage(resolved.arc[i]!, resolved.arc[i + 1]!));
        return points;
      })()
    : null;
  // On the arc: within its chordal sag plus rounding of the circle.
  const onArc = (p: XY) => {
    if (!arc) return true;
    const nearest = nearestOnPolyline(arc, p);
    return (
      nearest !== null &&
      Math.hypot(nearest[0] - p[0], nearest[1] - p[1]) <=
        Math.max(0.05, 0.02 * r)
    );
  };
  if (arc && arc.length > 1 && !onArc([c[0] + u[0] * r, c[1] + u[1] * r])) {
    const angleOf = (p: XY) => Math.atan2(p[1] - c[1], p[0] - c[0]);
    const wanted = Math.atan2(u[1], u[0]);
    const gap = (p: XY) => {
      const d = Math.abs(angleOf(p) - wanted) % (2 * Math.PI);
      return Math.min(d, 2 * Math.PI - d);
    };
    const first = arc[0]!;
    const last = arc[arc.length - 1]!;
    const end = gap(first) <= gap(last) ? first : last;
    const length = Math.hypot(end[0] - c[0], end[1] - c[1]);
    if (length > 1e-9) u = [(end[0] - c[0]) / length, (end[1] - c[1]) / length];
  }
  const rim: XY = [c[0] + u[0] * r, c[1] + u[1] * r];
  const out = Math.max(r, reach);
  const end: XY = [c[0] + u[0] * out, c[1] + u[1] * out];
  const strokes: SheetStroke[] = [];
  if (resolved.kind === 'diameter') {
    const opposite: XY = [c[0] - u[0] * r, c[1] - u[1] * r];
    // The far arrowhead only where the arc reaches round to it.
    if (onArc(opposite))
      strokes.push(
        line(opposite, end),
        arrow(rim, u),
        arrow(opposite, [-u[0], -u[1]])
      );
    else strokes.push(line(c, end), arrow(rim, u));
  } else {
    strokes.push(line(c, end), arrow(rim, u));
  }
  // A small centre mark.
  const mark = 1.5;
  strokes.push(
    line([c[0] - mark, c[1]], [c[0] + mark, c[1]]),
    line([c[0], c[1] - mark], [c[0], c[1] + mark])
  );
  const right = u[0] >= 0;
  const placed = placedLabel(
    resolved.label,
    resolved.text,
    [end[0] + (right ? 1 : -1), end[1]],
    0,
    right ? 'start' : 'end'
  );
  strokes.push(...placed.strokes);
  return { strokes, texts: placed.texts, box: placed.box };
}

function angleLayout(
  resolved: Extract<ResolvedAnnotation, { kind: 'angle' }>,
  toPage: (u: number, v: number) => XY,
  anchor: XY
): AnnotationLayout {
  const v = toPage(...resolved.vertex);
  const rays = resolved.rays.map(
    ([near, far]) => [toPage(...near), toPage(...far)] as [XY, XY]
  );
  const dirs = rays.map(([, far]) => {
    const length = Math.hypot(far[0] - v[0], far[1] - v[1]);
    return [(far[0] - v[0]) / length, (far[1] - v[1]) / length] as XY;
  }) as [XY, XY];
  const radius = Math.max(3, Math.hypot(anchor[0] - v[0], anchor[1] - v[1]));
  const a1 = Math.atan2(dirs[0][1], dirs[0][0]);
  let sweep = Math.atan2(dirs[1][1], dirs[1][0]) - a1;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  if (resolved.through) {
    // v82: an arc angle sweeps the way its arc runs, past 180° if need be.
    const t = toPage(...resolved.through);
    let toward = Math.atan2(t[1] - v[1], t[0] - v[0]) - a1;
    while (toward > Math.PI) toward -= 2 * Math.PI;
    while (toward < -Math.PI) toward += 2 * Math.PI;
    const within =
      sweep >= 0
        ? toward >= 0 && toward <= sweep
        : toward <= 0 && toward >= sweep;
    if (!within) sweep -= Math.sign(sweep || 1) * 2 * Math.PI;
  }
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 60)));
  const points: number[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const angle = a1 + (sweep * i) / steps;
    points.push(
      v[0] + Math.cos(angle) * radius,
      v[1] + Math.sin(angle) * radius
    );
  }
  const strokes: SheetStroke[] = [{ kind: 'dimension', points }];
  const s = Math.sign(sweep) || 1;
  const tangent = (angle: number, sense: number): XY => [
    -Math.sin(angle) * sense,
    Math.cos(angle) * sense
  ];
  const a2 = a1 + sweep;
  strokes.push(
    arrow(
      [v[0] + Math.cos(a1) * radius, v[1] + Math.sin(a1) * radius],
      tangent(a1, -s)
    ),
    arrow(
      [v[0] + Math.cos(a2) * radius, v[1] + Math.sin(a2) * radius],
      tangent(a2, s)
    )
  );
  // Extension lines where the arc lies beyond an edge's far end or short of
  // its near end.
  const turned = resolved.outside;
  if (turned) {
    // The outward ray's extension line runs from its edge's near end,
    // through the vertex, to just past the arc.
    const d = dirs[turned.index];
    const from = toPage(...turned.from);
    const start = Math.hypot(from[0] - v[0], from[1] - v[1]);
    const along = (t: number): XY => [v[0] + d[0] * t, v[1] + d[1] * t];
    strokes.push(
      line(
        start > EXTENSION_GAP_MM
          ? along(-start + EXTENSION_GAP_MM)
          : along(EXTENSION_GAP_MM),
        along(radius + EXTENSION_OVERSHOOT_MM)
      )
    );
  }
  rays.forEach(([near, far], index) => {
    if (turned?.index === index) return;
    const d = dirs[index]!;
    const nearDistance = Math.hypot(near[0] - v[0], near[1] - v[1]);
    const farDistance = Math.hypot(far[0] - v[0], far[1] - v[1]);
    const point = (t: number): XY => [v[0] + d[0] * t, v[1] + d[1] * t];
    if (radius > farDistance + EXTENSION_GAP_MM)
      strokes.push(
        line(
          point(farDistance + EXTENSION_GAP_MM),
          point(radius + EXTENSION_OVERSHOOT_MM)
        )
      );
    else if (radius < nearDistance - EXTENSION_GAP_MM)
      strokes.push(
        line(
          point(nearDistance - EXTENSION_GAP_MM),
          point(Math.max(0, radius - EXTENSION_OVERSHOOT_MM))
        )
      );
  });
  const mid = a1 + sweep / 2;
  const reach = radius + 2;
  const placed = placedLabel(
    resolved.label,
    resolved.text,
    [
      v[0] + Math.cos(mid) * reach,
      v[1] + Math.sin(mid) * reach - ANNOTATION_TEXT_MM / 2 - 1
    ],
    0
  );
  strokes.push(...placed.strokes);
  return { strokes, texts: placed.texts, box: placed.box };
}

/**
 * A chamfer callout: its text at the placement, and a leader to the middle
 * of the side of the chamfer nearer it.
 */
function chamferLayout(
  resolved: Extract<ResolvedAnnotation, { kind: 'chamfer' }>,
  toPage: (u: number, v: number) => XY,
  anchor: XY
): AnnotationLayout {
  const placed = placedText(
    resolved.label,
    [anchor[0], anchor[1] - TEXT_LIFT_MM],
    0,
    'start'
  );
  const box = placed.box;
  const middle: XY = [box.x + box.width / 2, box.y + box.height / 2];
  const tips = resolved.segments.map(([a, b]) => {
    const p = toPage(...a);
    const q = toPage(...b);
    return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as XY;
  });
  const tip = tips.reduce((best, candidate) =>
    Math.hypot(candidate[0] - middle[0], candidate[1] - middle[1]) <
    Math.hypot(best[0] - middle[0], best[1] - middle[1])
      ? candidate
      : best
  );
  const from: XY = [tip[0] < middle[0] ? box.x : box.x + box.width, middle[1]];
  const length = Math.hypot(tip[0] - from[0], tip[1] - from[1]);
  const strokes: SheetStroke[] = [];
  if (length > 1e-6) {
    const direction: XY = [
      (tip[0] - from[0]) / length,
      (tip[1] - from[1]) / length
    ];
    if (length > ARROW_LENGTH_MM) strokes.push(line(from, tip));
    strokes.push(arrow(tip, direction, Math.min(ARROW_LENGTH_MM, length)));
  }
  return { strokes, texts: [placed.text], box };
}

function nearestOnPolyline(points: XY[], to: XY): XY | null {
  let best: XY | null = null;
  let bestDistance = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[Math.min(i + 1, points.length - 1)]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared > 0
        ? Math.min(
            1,
            Math.max(
              0,
              ((to[0] - a[0]) * dx + (to[1] - a[1]) * dy) / lengthSquared
            )
          )
        : 0;
    const p: XY = [a[0] + dx * t, a[1] + dy * t];
    const distance = Math.hypot(p[0] - to[0], p[1] - to[1]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = p;
    }
  }
  return best;
}

/** How far a drawn line may stray from the edge it was drawn from, in mm. */
const DRAWN_COINCIDENCE_MM = 0.05;

/**
 * How far, in model units, a drawn line may lie from the edge polyline it
 * comes from. Views project from the canonical drawing tessellation (#777)
 * while edge identity comes from the display topology, whose curved edges
 * keep an earlier deflection through small edits: an R20 rim edited to R21
 * was measured 0.008 units off its canonical twin. A thousandth of the
 * largest body diagonal covers that with room; on paper the tolerance is
 * never tighter than {@link DRAWN_COINCIDENCE_MM}.
 */
export function drawnCoincidence(
  bodies: AnnotationBodies,
  bodyIds: readonly string[],
  paperPerModelUnit: number
): number {
  let diagonal = 0;
  for (const bodyId of bodyIds) {
    const box = bodies[bodyId]?.bbox;
    if (!box) continue;
    diagonal = Math.max(
      diagonal,
      Math.hypot(
        box.max.x - box.min.x,
        box.max.y - box.min.y,
        box.max.z - box.min.z
      )
    );
  }
  return Math.max(DRAWN_COINCIDENCE_MM / paperPerModelUnit, 1e-3 * diagonal);
}

function nearestOnPieces(pieces: readonly XY[][], to: XY): XY | null {
  let best: XY | null = null;
  let bestDistance = Infinity;
  for (const piece of pieces) {
    const point = nearestOnPolyline(piece, to);
    if (!point) continue;
    const distance = Math.hypot(point[0] - to[0], point[1] - to[1]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }
  return best;
}

function noteLayout(
  resolved: Extract<ResolvedAnnotation, { kind: 'note' }>,
  toPage: ((u: number, v: number) => XY) | null,
  anchor: XY
): AnnotationLayout {
  const placed = placedText(
    resolved.label,
    [anchor[0], anchor[1] - TEXT_LIFT_MM],
    0,
    'start'
  );
  const strokes: SheetStroke[] = [];
  if (resolved.leader && toPage) {
    // The tip lands only on what the view draws of this edge (see
    // markHiddenLeaders): a partly hidden edge, with hidden lines off, is
    // pointed at where it shows.
    const toPagePolyline = (flat: readonly number[]) => {
      const out: XY[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2)
        out.push(toPage(flat[i]!, flat[i + 1]!));
      return out;
    };
    const pieces = (resolved.leaderPieces ?? [resolved.leader]).map(
      toPagePolyline
    );
    const box = placed.box;
    const middle: XY = [box.x + box.width / 2, box.y + box.height / 2];
    const rough = nearestOnPieces(pieces, middle);
    if (rough) {
      // From the side of the text facing the edge, to the nearest point of
      // the edge from there.
      const from: XY = [
        rough[0] < middle[0] ? box.x : box.x + box.width,
        middle[1]
      ];
      const tip = nearestOnPieces(pieces, from) ?? rough;
      const length = Math.hypot(tip[0] - from[0], tip[1] - from[1]);
      if (length > ARROW_LENGTH_MM)
        strokes.push(
          line(from, tip),
          arrow(tip, [(tip[0] - from[0]) / length, (tip[1] - from[1]) / length])
        );
      else {
        // Placed close to the edge: still an arrow onto it, never a plain
        // note. Shorter than the gap allows when there is one; pointing from
        // the text's middle when the text sits on the edge.
        const away = Math.hypot(tip[0] - middle[0], tip[1] - middle[1]);
        const direction: XY =
          length > 1e-6
            ? [(tip[0] - from[0]) / length, (tip[1] - from[1]) / length]
            : away > 1e-6
              ? [(tip[0] - middle[0]) / away, (tip[1] - middle[1]) / away]
              : [0, -1];
        strokes.push(
          arrow(tip, direction, length > 1e-6 ? Math.max(length, 1) : 2)
        );
      }
    }
  }
  return { strokes, texts: [placed.text], box: placed.box };
}

/**
 * The strokes and text of one resolved annotation. `toPage` maps the view's
 * (u, v) to paper millimetres (null for a note on the paper), `k` is paper
 * millimetres per model unit, and `anchor` the annotation's placement on
 * the paper.
 */
export function layoutAnnotation(
  resolved: ResolvedAnnotation,
  toPage: ((u: number, v: number) => XY) | null,
  k: number,
  anchor: XY,
  /** v98: the laid-out box of the dimension or frame this is attached to. */
  host?: AnnotationBox
): AnnotationLayout {
  if (resolved.kind === 'note') return noteLayout(resolved, toPage, anchor);
  if (
    resolved.kind === 'datum-feature' ||
    resolved.kind === 'feature-control-frame'
  )
    return toleranceLayout(resolved, toPage, anchor, host);
  if (resolved.kind === 'bom-table' || resolved.kind === 'general-tolerance')
    return bomTableLayout(resolved, anchor);
  if (resolved.kind === 'hole-table') {
    // The table where it is placed, and each bore's tag beside it in the
    // view, up and right of its rim.
    const table = bomTableLayout(resolved, anchor);
    if (toPage)
      for (const tag of resolved.tags) {
        const lean = tag.r * Math.SQRT1_2;
        const [x, y] = toPage(tag.u + lean, tag.v + lean);
        table.texts.push({
          x: x + HOLE_TAG_GAP_MM,
          y: y + HOLE_TAG_GAP_MM,
          sizeMm: ANNOTATION_TEXT_MM,
          text: tag.text
        });
      }
    return table;
  }
  if (resolved.kind === 'image') {
    // Centred on its placement, its picture's own aspect.
    const x = anchor[0] - resolved.widthMm / 2;
    const y = anchor[1] - resolved.heightMm / 2;
    return {
      strokes: [],
      texts: [],
      images: [
        {
          x,
          y,
          width: resolved.widthMm,
          height: resolved.heightMm,
          checksumSha256: resolved.checksumSha256,
          contentType: resolved.contentType
        }
      ],
      box: { x, y, width: resolved.widthMm, height: resolved.heightMm }
    };
  }
  if (!toPage) throw new Error('A dimension needs its view.');
  switch (resolved.kind) {
    case 'linear':
      return linearLayout(resolved, toPage, anchor);
    case 'radius':
    case 'diameter':
      return radialLayout(resolved, toPage, k, anchor);
    case 'angle':
      return angleLayout(resolved, toPage, anchor);
    case 'chamfer':
      return chamferLayout(resolved, toPage, anchor);
    case 'center-mark':
    case 'intersection-mark':
    case 'centerline':
      return geometryLayout(resolved, toPage, k);
    case 'balloon':
      return balloonLayout(resolved, toPage, anchor);
  }
}

/** M01: from a bore's rim to its tag, on the paper. */
const HOLE_TAG_GAP_MM = 0.8;

/** The tag letters of a hole table's sizes: A–Z, then AA, AB… */
function holeTagLetters(index: number): string {
  let letters = '';
  let rest = index;
  do {
    letters = String.fromCharCode(65 + (rest % 26)) + letters;
    rest = Math.floor(rest / 26) - 1;
  } while (rest >= 0);
  return letters;
}

/** Below this two bores' axes stand at one place (a bore split at its seam). */
const HOLE_TABLE_TOLERANCE = 1e-6;

/** Any name a hole's bore takes, its copies' included. */
const HOLE_BORE_NAME = /(?:^|\.)hole\.face(?:\.at\.[A-Za-z0-9_-]+)?\.bore$/;

/**
 * The hole a bore's face names, through any whole-body pattern copies of
 * it: a feature pattern's copy (`….source.<hole>.hole.face….bore`) names its
 * hole however often its body is copied whole (re-check). A hole's own
 * bore copied whole names none.
 */
function tableHoleOf(reference: {
  producingFeatureId: FeatureId;
  lineageName: string;
}): FeatureId | null {
  const own = holeOfBoreFace(reference);
  if (own) return own;
  const copied =
    /^(?:pattern\.face\.instance\.[A-Za-z0-9_-]+\.)+?pattern\.face\.instance\.[A-Za-z0-9_-]+\.source\.([A-Za-z0-9_-]+)\.hole\.face(?:\.at\.[A-Za-z0-9_-]+)?\.bore$/.exec(
      reference.lineageName
    );
  return copied ? (copied[1] as FeatureId) : null;
}

/** JSON with every object's keys sorted, so equal values print alike. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0
          )
        )
      : item
  );
}

/**
 * Whether any of `meshes` lies between `from` and the eye, which looks
 * along `direction`: a ray from `from` back toward it meets a triangle
 * (Möller–Trumbore) a little way off, past the face `from` lies on.
 */
function coveredFromEye(
  meshes: readonly { vertices: Float32Array; indices: Uint32Array }[],
  from: { x: number; y: number; z: number },
  direction: { x: number; y: number; z: number }
): boolean {
  const d = [-direction.x, -direction.y, -direction.z] as const;
  const o = [from.x, from.y, from.z] as const;
  // Past the float noise of the mesh it starts on, not a share of how far
  // the model stands from the origin (re-check: a thin cover far out).
  const near = 1e-6 * Math.max(1, Math.hypot(from.x, from.y, from.z)) + 1e-6;
  for (const { vertices: p, indices } of meshes) {
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const a = indices[t]! * 3;
      const b = indices[t + 1]! * 3;
      const c = indices[t + 2]! * 3;
      const e1 = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
      const e2 = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
      const h = [
        d[1] * e2[2]! - d[2] * e2[1]!,
        d[2] * e2[0]! - d[0] * e2[2]!,
        d[0] * e2[1]! - d[1] * e2[0]!
      ];
      const det = e1[0]! * h[0]! + e1[1]! * h[1]! + e1[2]! * h[2]!;
      if (Math.abs(det) < 1e-12) continue;
      const s = [o[0] - p[a]!, o[1] - p[a + 1]!, o[2] - p[a + 2]!];
      const u = (s[0]! * h[0]! + s[1]! * h[1]! + s[2]! * h[2]!) / det;
      if (u < 0 || u > 1) continue;
      const q = [
        s[1]! * e1[2]! - s[2]! * e1[1]!,
        s[2]! * e1[0]! - s[0]! * e1[2]!,
        s[0]! * e1[1]! - s[1]! * e1[0]!
      ];
      const v = (d[0] * q[0]! + d[1] * q[1]! + d[2] * q[2]!) / det;
      if (v < 0 || u + v > 1) continue;
      const along = (e2[0]! * q[0]! + e2[1]! * q[1]! + e2[2]! * q[2]!) / det;
      if (along > near) return true;
    }
  }
  return false;
}

/**
 * M01: the hole table of `view`: every bore it sees down its axis, a row
 * each. Bores are found by their faces' lineage (a hole's own, at sketch
 * points, or an M02 pattern copy's) and sized by their hole's callout,
 * written once per bore. X and Y are measured in the view from the lower-
 * left corner of its bodies' bounding boxes. Tags take a letter per size,
 * smallest first, and a number per bore within it, left to right then
 * bottom to top. Null when the view sees no bore down its axis.
 *
 * Only the bores the view shows (review): one whose opening the bodies
 * cover is left out unless the view draws hidden lines, and a detail lists
 * only the bores inside its circle. Bores at one place are one row only
 * when they are one hole's (a bore split at its seam); a size is the
 * hole's model callout, not its printed text. A bore a whole-body pattern
 * copied names no hole, so it breaks the table rather than go missing.
 */
function holeTable(
  view: DrawingView,
  bodies: AnnotationBodies,
  holes: HoleCalloutLookup | undefined,
  format: DrawingNumberFormat
): Extract<ResolvedAnnotation, { kind: 'hole-table' }> | null | 'hole-unnamed' {
  if (!holes) return null;
  const frame = drawingViewFrame(view);
  let minU = Infinity;
  let minV = Infinity;
  const bores: {
    u: number;
    v: number;
    r: number;
    size: string;
    /** The callout itself, which sizes are told apart by. */
    group: string;
    diameter: number;
    /** Whose bore it is: a bore split at its seam shares both. */
    bodyId: string;
    holeId: string;
  }[] = [];
  const meshes = view.bodyIds
    .map((bodyId) => annotationBody(bodies, view, bodyId)?.mesh)
    .filter((mesh): mesh is NonNullable<typeof mesh> => mesh !== undefined);
  for (const bodyId of view.bodyIds) {
    const body = annotationBody(bodies, view, bodyId);
    if (!body) continue;
    const { min, max } = body.bbox;
    for (const x of [min.x, max.x])
      for (const y of [min.y, max.y])
        for (const z of [min.z, max.z]) {
          const at = projectToView(frame, { x, y, z });
          minU = Math.min(minU, at.u);
          minV = Math.min(minV, at.v);
        }
    for (const face of body.topology?.faces ?? []) {
      const geometry = face.geometry;
      if (
        !face.reference ||
        geometry?.surfaceType.toLowerCase() !== 'cylinder' ||
        !geometry.axisStart ||
        !geometry.axisEnd
      )
        continue;
      const holeId = tableHoleOf(face.reference);
      const callout = holeId ? holes(holeId, view.viewId) : null;
      const axis = {
        x: geometry.axisEnd.x - geometry.axisStart.x,
        y: geometry.axisEnd.y - geometry.axisStart.y,
        z: geometry.axisEnd.z - geometry.axisStart.z
      };
      const span = Math.hypot(axis.x, axis.y, axis.z);
      const along =
        span > 0
          ? (axis.x * frame.direction.x +
              axis.y * frame.direction.y +
              axis.z * frame.direction.z) /
            span
          : 0;
      if (Math.abs(Math.abs(along) - 1) > HOLE_TABLE_TOLERANCE) continue;
      const at = projectToView(frame, geometry.axisStart);
      // A detail shows only what lies inside its circle.
      if (
        view.detail &&
        Math.hypot(at.u - view.detail.center.u, at.v - view.detail.center.v) >
          view.detail.radius
      )
        continue;
      // Its end nearer the eye, which looks along `direction`: covered
      // there, the view does not show its opening.
      const dot = (p: { x: number; y: number; z: number }) =>
        p.x * frame.direction.x +
        p.y * frame.direction.y +
        p.z * frame.direction.z;
      const mouth =
        dot(geometry.axisStart) <= dot(geometry.axisEnd)
          ? geometry.axisStart
          : geometry.axisEnd;
      // Covered only where its whole opening is: the centre and a ring
      // just inside the rim (re-check: a strip across the middle hides
      // the centre, not the bore).
      const radius =
        callout?.diameter !== undefined
          ? callout.diameter / 2
          : (geometry.radius ?? 0);
      const ring = [mouth];
      for (let k = 0; k < 12; k += 1) {
        const t = (2 * Math.PI * k) / 12;
        const a = 0.9 * radius * Math.cos(t);
        const b = 0.9 * radius * Math.sin(t);
        ring.push({
          x: mouth.x + a * frame.x.x + b * frame.up.x,
          y: mouth.y + a * frame.x.y + b * frame.up.y,
          z: mouth.z + a * frame.x.z + b * frame.up.z
        });
      }
      if (
        !view.hiddenLines &&
        ring.every((point) => coveredFromEye(meshes, point, frame.direction))
      )
        continue;
      if (!callout) {
        // A bore its name says is a hole's, whose hole it cannot name (a
        // whole-body pattern's copy): never left out unsaid.
        if (HOLE_BORE_NAME.test(face.reference.lineageName))
          return 'hole-unnamed';
        continue;
      }
      const group = canonicalJson({ ...callout, count: 1 });
      if (
        bores.some(
          (bore) =>
            bore.bodyId === bodyId &&
            bore.holeId === holeId &&
            bore.group === group &&
            Math.hypot(bore.u - at.u, bore.v - at.v) <=
              HOLE_TABLE_TOLERANCE * Math.max(1, Math.abs(at.u), Math.abs(at.v))
        )
      )
        continue;
      const length = (n: number) =>
        writeNumber(
          n * format.lengthFactor,
          format.lengthDecimals,
          'length',
          format,
          true
        );
      bores.push({
        u: at.u,
        v: at.v,
        r: callout.diameter / 2,
        // One bore a row: the count belongs to the hole, not to the row.
        size: holeCalloutLabel({ ...callout, count: 1 }, length),
        group,
        diameter: callout.diameter,
        bodyId,
        holeId: holeId!
      });
    }
  }
  if (bores.length === 0) return null;
  const groups = [...new Set(bores.map((bore) => bore.group))].sort(
    (a, b) =>
      bores.find((bore) => bore.group === a)!.diameter -
        bores.find((bore) => bore.group === b)!.diameter || a.localeCompare(b)
  );
  const position = (n: number) =>
    writeNumber(
      n * format.lengthFactor,
      format.lengthDecimals,
      'length',
      format,
      true
    );
  const rows: string[][] = [];
  const tags: { text: string; u: number; v: number; r: number }[] = [];
  groups.forEach((group, index) => {
    const letter = holeTagLetters(index);
    bores
      .filter((bore) => bore.group === group)
      .sort((a, b) => a.u - b.u || a.v - b.v)
      .forEach((bore, at) => {
        const text = `${letter}${at + 1}`;
        rows.push([
          text,
          position(bore.u - minU),
          position(bore.v - minV),
          bore.size
        ]);
        tags.push({ text, u: bore.u, v: bore.v, r: bore.r });
      });
  });
  return {
    kind: 'hole-table',
    label: '',
    header: ['TAG', 'X', 'Y', 'SIZE'],
    numeric: [false, true, true, false],
    rows,
    tags
  };
}

/** v80: the parts list's default columns: item, quantity, part. */
export const DEFAULT_BOM_COLUMNS: readonly DrawingBomColumnKey[] = [
  'item',
  'quantity',
  'part'
];
const BOM_ROW_MM = 6;
const BOM_PAD_MM = 1.5;
/** The longest cell a parts list prints before it is cut with "...". */
const BOM_MAX_CELL_MM = 70;

/**
 * v80: the parts list as a ruled table, its top-left corner at the
 * placement: a bold header row, then one row per BOM row, numeric columns
 * aligned to their end. Thin rules, as a title block's.
 */
function bomTableLayout(
  resolved: Extract<
    ResolvedAnnotation,
    { kind: 'bom-table' | 'general-tolerance' | 'hole-table' }
  >,
  anchor: XY
): AnnotationLayout {
  const size = ANNOTATION_TEXT_MM;
  const cells = [resolved.header, ...resolved.rows].map((row, index) =>
    row.map((cell) =>
      fitText(sheetSafeText(cell), size, BOM_MAX_CELL_MM, index === 0)
    )
  );
  const widths = resolved.header.map(
    (_, column) =>
      Math.max(
        ...cells.map((row, index) =>
          textWidthMm(row[column] ?? '', size, index === 0)
        )
      ) +
      2 * BOM_PAD_MM
  );
  const total = widths.reduce((sum, width) => sum + width, 0);
  const height = cells.length * BOM_ROW_MM;
  const [x0, y0] = anchor;
  const strokes: SheetStroke[] = [
    {
      kind: 'thin',
      closed: true,
      points: [x0, y0, x0 + total, y0, x0 + total, y0 - height, x0, y0 - height]
    }
  ];
  for (let row = 1; row < cells.length; row += 1)
    strokes.push({
      kind: 'thin',
      points: [x0, y0 - row * BOM_ROW_MM, x0 + total, y0 - row * BOM_ROW_MM]
    });
  let x = x0;
  const texts: SheetText[] = [];
  widths.forEach((width, column) => {
    if (column > 0)
      strokes.push({ kind: 'thin', points: [x, y0, x, y0 - height] });
    cells.forEach((row, index) => {
      const text = row[column] ?? '';
      if (!text) return;
      const end = resolved.numeric[column] && index > 0;
      texts.push({
        x: end ? x + width - BOM_PAD_MM : x + BOM_PAD_MM,
        y: y0 - (index + 1) * BOM_ROW_MM + (BOM_ROW_MM - size) / 2,
        sizeMm: size,
        text,
        ...(index === 0 ? { bold: true } : {}),
        ...(end ? { align: 'end' as const } : {})
      });
    });
    x += width;
  });
  return {
    strokes,
    texts,
    box: { x: x0, y: y0 - height, width: total, height }
  };
}

/** A leader's drawn pieces on the paper (see markHiddenLeaders). */
function leaderPagePieces(
  resolved: { leader?: number[]; leaderPieces?: number[][] },
  toPage: (u: number, v: number) => XY
): XY[][] {
  return (
    resolved.leaderPieces ?? (resolved.leader ? [resolved.leader] : [])
  ).map((flat) => {
    const points: XY[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2)
      points.push(toPage(flat[i]!, flat[i + 1]!));
    return points;
  });
}

/** v98: the gap between a dimension's text and the frame beneath it. */
const FRAME_BELOW_HOST_MM = 1;

/**
 * v98: a feature control frame or datum feature symbol. A frame on a
 * leader has the middle of its left side at the placement and a leader
 * from its nearer side to the nearest drawn point of its edge; a frame
 * attached to a dimension sits just below the dimension's text, left
 * aligned, and moves with it (Y14.5 fig. 3-25: a feature of size's frame
 * under its size). A datum symbol is centred on its placement, its
 * triangle on the nearest drawn point of its edge or of its host's box.
 */
function toleranceLayout(
  resolved: Extract<
    ResolvedAnnotation,
    { kind: 'datum-feature' | 'feature-control-frame' }
  >,
  toPage: ((u: number, v: number) => XY) | null,
  anchor: XY,
  host: AnnotationBox | undefined
): AnnotationLayout {
  const pieces = toPage ? leaderPagePieces(resolved, toPage) : [];
  if (resolved.kind === 'datum-feature') {
    const foot =
      resolved.attached && host
        ? nearestOnBox(host, anchor)
        : nearestOnPieces(pieces, anchor);
    return datumFeatureLayout(resolved.label, anchor, foot);
  }
  const topLeft: XY =
    resolved.attached && host
      ? [host.x, host.y - FRAME_BELOW_HOST_MM]
      : [anchor[0], anchor[1] + FRAME_HEIGHT_MM / 2];
  const frame = featureControlFrameLayout(resolved.cells, topLeft);
  if (!resolved.attached) {
    const box = frame.box;
    const tip = nearestOnPieces(pieces, [
      box.x + box.width / 2,
      box.y + box.height / 2
    ]);
    if (tip) frame.strokes.push(...frameLeader(box, tip));
  }
  return frame;
}

/** v80: a balloon's circle, at least this radius. */
const BALLOON_RADIUS_MM = 4;

/**
 * v80: a balloon: the item number centred in a circle at the placement,
 * and a leader from the circle's rim to the nearest point of its edge,
 * ending in an arrow.
 */
function balloonLayout(
  resolved: Extract<ResolvedAnnotation, { kind: 'balloon' }>,
  toPage: (u: number, v: number) => XY,
  anchor: XY
): AnnotationLayout {
  const text = sheetSafeText(resolved.label);
  const radius = Math.max(
    BALLOON_RADIUS_MM,
    textWidthMm(text, ANNOTATION_TEXT_MM) / 2 + 1.5
  );
  const steps = 48;
  const circle: number[] = [];
  for (let i = 0; i < steps; i += 1) {
    const angle = (2 * Math.PI * i) / steps;
    circle.push(
      anchor[0] + radius * Math.cos(angle),
      anchor[1] + radius * Math.sin(angle)
    );
  }
  const strokes: SheetStroke[] = [
    { kind: 'dimension', closed: true, points: circle }
  ];
  // The tip lands only on what the view draws of the edge (see
  // markHiddenLeaders): inside a detail's circle, and where it shows.
  const pieces = (resolved.leaderPieces ?? [resolved.leader]).map((flat) => {
    const points: XY[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2)
      points.push(toPage(flat[i]!, flat[i + 1]!));
    return points;
  });
  const tip = nearestOnPieces(pieces, anchor);
  if (tip) {
    const length = Math.hypot(tip[0] - anchor[0], tip[1] - anchor[1]);
    if (length > radius + 1e-6) {
      const d: XY = [
        (tip[0] - anchor[0]) / length,
        (tip[1] - anchor[1]) / length
      ];
      const from: XY = [anchor[0] + d[0] * radius, anchor[1] + d[1] * radius];
      strokes.push(
        line(from, tip),
        arrow(tip, d, Math.min(ARROW_LENGTH_MM, length - radius))
      );
    }
  }
  return {
    strokes,
    texts: [
      {
        x: anchor[0],
        y: anchor[1] - ANNOTATION_TEXT_MM / 2,
        sizeMm: ANNOTATION_TEXT_MM,
        text,
        align: 'middle'
      }
    ],
    box: {
      x: anchor[0] - radius,
      y: anchor[1] - radius,
      width: 2 * radius,
      height: 2 * radius
    }
  };
}

/** v73: how far centre lines run past what they mark, on the paper (ISO 128-20). */
const CENTRE_LINE_OVERRUN_MM = 2.5;
/** A centre line shorter than this draws solid: its chain dash would not show. */
const CHAIN_MIN_MM = 12;
/** A centre mark's small solid cross, each arm. */
const CENTRE_CROSS_MM = 1.5;
/** A mark's pick box, each side of what it marks. */
const MARK_BOX_MM = 2.5;

function chainOrThin(a: XY, b: XY): SheetStroke {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return {
    kind: length >= CHAIN_MIN_MM ? 'chain' : 'dimension',
    points: [a[0], a[1], b[0], b[1]]
  };
}

function markBox(at: XY): AnnotationBox {
  return {
    x: at[0] - MARK_BOX_MM,
    y: at[1] - MARK_BOX_MM,
    width: 2 * MARK_BOX_MM,
    height: 2 * MARK_BOX_MM
  };
}

/**
 * v73: centre marks (centre lines across the circle, run past its rim, and
 * a small cross at its centre), intersection marks (each edge's thin
 * extension through the crossing) and centrelines (a chain line run past
 * its ends, or a chain circle). They state no value, so they have no text;
 * their box sits on what they mark.
 */
function geometryLayout(
  resolved: Extract<
    ResolvedAnnotation,
    { kind: 'center-mark' | 'intersection-mark' | 'centerline' }
  >,
  toPage: (u: number, v: number) => XY,
  k: number
): AnnotationLayout {
  const strokes: SheetStroke[] = [];
  switch (resolved.kind) {
    case 'center-mark': {
      const c = toPage(...resolved.center);
      const reach = resolved.radius * k + CENTRE_LINE_OVERRUN_MM;
      strokes.push(
        chainOrThin([c[0] - reach, c[1]], [c[0] + reach, c[1]]),
        chainOrThin([c[0], c[1] - reach], [c[0], c[1] + reach]),
        line([c[0] - CENTRE_CROSS_MM, c[1]], [c[0] + CENTRE_CROSS_MM, c[1]]),
        line([c[0], c[1] - CENTRE_CROSS_MM], [c[0], c[1] + CENTRE_CROSS_MM])
      );
      return { strokes, texts: [], box: markBox(c) };
    }
    case 'intersection-mark': {
      const p = toPage(...resolved.point);
      for (const near of resolved.from) {
        const q = toPage(...near);
        const length = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (length < 1e-6) continue;
        const d: XY = [(p[0] - q[0]) / length, (p[1] - q[1]) / length];
        const start =
          length > EXTENSION_GAP_MM
            ? ([
                q[0] + d[0] * EXTENSION_GAP_MM,
                q[1] + d[1] * EXTENSION_GAP_MM
              ] as XY)
            : q;
        strokes.push(
          line(start, [
            p[0] + d[0] * EXTENSION_OVERSHOOT_MM,
            p[1] + d[1] * EXTENSION_OVERSHOOT_MM
          ])
        );
      }
      return { strokes, texts: [], box: markBox(p) };
    }
    case 'centerline': {
      if (resolved.circle) {
        const c = toPage(...resolved.circle.center);
        const r = resolved.circle.radius * k;
        const steps = Math.max(24, Math.min(180, Math.ceil(r)));
        const points: number[] = [];
        for (let i = 0; i < steps; i += 1) {
          const angle = (2 * Math.PI * i) / steps;
          points.push(c[0] + r * Math.cos(angle), c[1] + r * Math.sin(angle));
        }
        strokes.push({ kind: 'chain', closed: true, points });
        return { strokes, texts: [], box: markBox([c[0], c[1] + r]) };
      }
      const [a, b] = resolved.segment!.map((uv) => toPage(...uv)) as [XY, XY];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const d: XY =
        length > 1e-9
          ? [(b[0] - a[0]) / length, (b[1] - a[1]) / length]
          : [1, 0];
      strokes.push(
        chainOrThin(
          [
            a[0] - d[0] * CENTRE_LINE_OVERRUN_MM,
            a[1] - d[1] * CENTRE_LINE_OVERRUN_MM
          ],
          [
            b[0] + d[0] * CENTRE_LINE_OVERRUN_MM,
            b[1] + d[1] * CENTRE_LINE_OVERRUN_MM
          ]
        )
      );
      return {
        strokes,
        texts: [],
        box: markBox([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])
      };
    }
  }
}

/** Where an annotation's placement is on the paper. */
export function annotationAnchor(
  annotation: DrawingAnnotation,
  view: Pick<DrawingView, 'centerMm'> | undefined
): XY {
  return view
    ? [
        view.centerMm.x + annotation.placementMm.x,
        view.centerMm.y + annotation.placementMm.y
      ]
    : [annotation.placementMm.x, annotation.placementMm.y];
}

/**
 * The lines each drawn view shows, on the paper: its visible runs, and its
 * hidden runs when it draws them. A pick must land on one of these, and a
 * leader must end on one, so an edge the view does not show is neither
 * picked through a face nor pointed at.
 */
export function drawnLines(
  sheet: Pick<DrawingSheet, 'scale'>,
  views: readonly ComposedView[],
  units: UnitSystem
): Map<DrawingViewId, XY[][]> {
  const out = new Map<DrawingViewId, XY[][]>();
  for (const { view, projection } of views) {
    if (!projection.bounds) continue;
    const toPage = viewPageTransform(view, projection.bounds, sheet, units);
    const lines: XY[][] = [];
    // Physical edges only: a silhouette is no proof an edge is drawn.
    const runs = projection.edgeRuns ?? projection;
    // A detail draws, and so offers, only what lies inside its circle.
    const clip = viewClipCircle(view, units);
    for (const run of view.hiddenLines
      ? [...runs.visible, ...runs.hidden]
      : runs.visible) {
      const line: XY[] = [];
      for (let i = 0; i + 1 < run.length; i += 2)
        line.push(toPage(run[i]!, run[i + 1]!));
      if (clip) lines.push(...clipPolylineToCircle(line, clip));
      else lines.push(line);
    }
    out.set(view.viewId, lines);
  }
  return out;
}

/**
 * D02 v80: the BOM a sheet reads: the AS03 table, which parts lists and
 * balloons show, and the body showing each component, which a balloon's
 * leader must touch for its item number to be that part's.
 */
export interface SheetBom extends AssemblyBomTable {
  bodyByComponent: ReadonlyMap<string, BodyId>;
}

/** The project's BOM for its sheets; absent with no assembly parts. */
export function sheetBom(document: ProjectDocument): SheetBom | undefined {
  const components = document.assembly?.components ?? [];
  if (components.length === 0) return undefined;
  const live = assemblyComponentBodies(document, (bodyId) =>
    isLiveAssemblyBody(document, bodyId)
  );
  const bodyByComponent = new Map<string, BodyId>();
  for (const component of components)
    bodyByComponent.set(
      component.id,
      live.get(component.id) ?? component.bodyId
    );
  return { ...assemblyBomTable(deriveAssemblyBom(document)), bodyByComponent };
}

/** The listed component a body shows: the part a balloon on it names. */
export function balloonComponent(
  bom: SheetBom | undefined,
  bodyId: string | undefined
): string | undefined {
  if (!bom || bodyId === undefined) return undefined;
  for (const [componentId, body] of bom.bodyByComponent)
    if (body === bodyId && bom.itemByComponent.has(componentId))
      return componentId;
  return undefined;
}

/** v73: a sheet's annotations by id, for points its marks mark. */
export function sheetMarkLookup(
  sheet: Pick<DrawingSheet, 'annotations'>
): MarkLookup {
  const byId = new Map(
    (sheet.annotations ?? []).map((entry) => [entry.annotationId, entry])
  );
  return (annotationId) => byId.get(annotationId);
}

export function resolveSheetAnnotations(
  sheet: DrawingSheet,
  bodies: AnnotationBodies,
  units: UnitSystem,
  holes?: HoleCalloutLookup,
  /** D02 v80: the assembly's BOM, for parts lists and balloons. */
  bom?: SheetBom,
  /** D02 v92: the project's pictures, for sheet images. */
  pictures?: SheetPictureLookup,
  /**
   * D07 v98: datum letters across the whole drawing (see
   * drawingDatumLetters); absent counts this sheet's alone, and null skips
   * the datum checks (a placement preview).
   */
  datums: DatumLetters | null = drawingDatumLetters([sheet])
): Map<DrawingAnnotationId, AnnotationResolution> {
  const views = new Map(sheet.views.map((view) => [view.viewId, view]));
  const marks = sheetMarkLookup(sheet);
  const out = new Map(
    (sheet.annotations ?? []).map((annotation) => [
      annotation.annotationId,
      resolveDrawingAnnotation(
        annotation,
        annotation.viewId ? views.get(annotation.viewId) : undefined,
        bodies,
        units,
        holes,
        sheetNumberFormat(sheet, units),
        marks,
        bom,
        pictures,
        datums ?? undefined
      )
    ])
  );
  return markBrokenHosts(sheet, out);
}

/**
 * v98: `resolutions` with every attachment whose host is broken marked
 * `host-broken`: it has nowhere to be drawn, and export must wait for the
 * host's repair. A datum symbol may hang from a frame that hangs from a
 * dimension, so this runs until nothing changes (at most twice).
 */
export function markBrokenHosts(
  sheet: Pick<DrawingSheet, 'annotations'>,
  resolutions: ReadonlyMap<DrawingAnnotationId, AnnotationResolution>
): Map<DrawingAnnotationId, AnnotationResolution> {
  const out = new Map(resolutions);
  let changed = true;
  while (changed) {
    changed = false;
    for (const annotation of sheet.annotations ?? []) {
      const hostId = drawingAnnotationHost(annotation);
      if (!hostId || !out.get(annotation.annotationId)?.ok) continue;
      const host = out.get(hostId);
      if (host && !host.ok) {
        out.set(annotation.annotationId, failure('host-broken'));
        changed = true;
      }
    }
  }
  return out;
}

/**
 * `resolutions` with every note marked broken whose leader edge its drawn
 * view no longer shows at all (occluded after an Update, with hidden lines
 * off): the leader is the note's intent, and quietly dropping it would hand
 * off a plain note instead. Views not yet drawn are left alone.
 */
export function markHiddenLeaders(
  sheet: DrawingSheet,
  resolutions: ReadonlyMap<DrawingAnnotationId, AnnotationResolution>,
  views: readonly ComposedView[],
  units: UnitSystem,
  bodies: AnnotationBodies
): Map<DrawingAnnotationId, AnnotationResolution> {
  const out = new Map(resolutions);
  // Notes' leaders, (v80) balloons' and (v98) datum symbols' and frames'.
  const leaders = (sheet.annotations ?? []).filter(
    (annotation) =>
      ((annotation.kind === 'note' ||
        isDrawingToleranceAnnotation(annotation)) &&
        annotation.leader) ||
      annotation.kind === 'balloon'
  );
  if (leaders.length === 0) return out;
  const drawn = new Map(views.map((entry) => [entry.view.viewId, entry]));
  for (const annotation of leaders) {
    const resolution = out.get(annotation.annotationId);
    const entry = annotation.viewId ? drawn.get(annotation.viewId) : undefined;
    if (
      !resolution?.ok ||
      (resolution.resolved.kind !== 'note' &&
        resolution.resolved.kind !== 'balloon' &&
        resolution.resolved.kind !== 'datum-feature' &&
        resolution.resolved.kind !== 'feature-control-frame') ||
      !resolution.resolved.leader ||
      !entry?.projection.bounds
    )
      continue;
    // A detail (v78) draws at its own scale and only inside its circle: a
    // leader may point only at what it draws there.
    const k = viewPaperPerModelUnit(entry.view, sheet, units);
    const clip = viewClipCircle(entry.view, units);
    const toPage = viewPageTransform(
      entry.view,
      entry.projection.bounds,
      sheet,
      units
    );
    const pieces = ownedLeaderPieces(
      resolution.resolved,
      entry,
      bodies,
      drawnCoincidence(bodies, entry.view.bodyIds, k)
    ).flatMap((piece) =>
      clip ? clipPieceToCircle(piece, toPage, clip) : [piece]
    );
    out.set(
      annotation.annotationId,
      pieces.length === 0
        ? failure('leader-hidden')
        : {
            ok: true,
            resolved: { ...resolution.resolved, leaderPieces: pieces }
          }
    );
  }
  return out;
}

/**
 * The parts of a flat `[u, v, …]` piece that lie inside a page circle, each
 * a `[u0, v0, u1, v1]` segment: a detail (v78) draws only inside its
 * circle, so a leader may end only there. The page transform is affine, so
 * a segment's parameter is the same on the page as in (u, v).
 */
function clipPieceToCircle(
  piece: readonly number[],
  toPage: (u: number, v: number) => XY,
  clip: { center: XY; radius: number }
): number[][] {
  const out: number[][] = [];
  for (let i = 0; i + 3 < piece.length; i += 2) {
    const u0 = piece[i]!;
    const v0 = piece[i + 1]!;
    const u1 = piece[i + 2]!;
    const v1 = piece[i + 3]!;
    const a = toPage(u0, v0);
    const b = toPage(u1, v1);
    const d: XY = [b[0] - a[0], b[1] - a[1]];
    const f: XY = [a[0] - clip.center[0], a[1] - clip.center[1]];
    const qa = d[0] * d[0] + d[1] * d[1];
    const qb = 2 * (f[0] * d[0] + f[1] * d[1]);
    const qc = f[0] * f[0] + f[1] * f[1] - clip.radius * clip.radius;
    let t0: number;
    let t1: number;
    if (qa <= 1e-18) {
      if (qc > 0) continue;
      t0 = 0;
      t1 = 1;
    } else {
      const disc = qb * qb - 4 * qa * qc;
      if (disc < 0) continue;
      const root = Math.sqrt(disc);
      t0 = Math.max(0, (-qb - root) / (2 * qa));
      t1 = Math.min(1, (-qb + root) / (2 * qa));
      if (t1 < t0) continue;
    }
    out.push([
      u0 + (u1 - u0) * t0,
      v0 + (v1 - v0) * t0,
      u0 + (u1 - u0) * t1,
      v0 + (v1 - v0) * t1
    ]);
  }
  return out;
}

/** Points of a flat `[u, v, …]` polyline. */
function uvPoints(flat: ArrayLike<number>): XY[] {
  const out: XY[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2)
    out.push([flat[i]!, flat[i + 1]!]);
  return out;
}

/**
 * Where on a polyline the point nearest `to` lies: its distance from `to`
 * and the depth there, interpolated between the polyline's points.
 */
function nearestWithDepth(
  points: readonly XY[],
  depths: readonly number[],
  to: XY
): { distance: number; depth: number } {
  let distance = Infinity;
  let depth = Infinity;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared > 0
        ? Math.min(
            1,
            Math.max(
              0,
              ((to[0] - a[0]) * dx + (to[1] - a[1]) * dy) / lengthSquared
            )
          )
        : 0;
    const d = Math.hypot(a[0] + dx * t - to[0], a[1] + dy * t - to[1]);
    if (d < distance) {
      distance = d;
      depth = depths[i]! + (depths[i + 1]! - depths[i]!) * t;
    }
  }
  return { distance, depth };
}

/**
 * The segments its view draws that belong to the leader's own edge. A drawn
 * segment lying on the edge counts only where no other edge lies on it
 * nearer the viewer: when the leader edge is occluded and another edge
 * projects onto the same line (a box's back top edge behind its front one),
 * the drawn line is the other edge's, not this one's.
 */
function ownedLeaderPieces(
  resolved: Extract<
    ResolvedAnnotation,
    {
      kind: 'note' | 'balloon' | 'datum-feature' | 'feature-control-frame';
    }
  >,
  entry: ComposedView,
  bodies: AnnotationBodies,
  tolerance: number
): number[][] {
  const { view, projection } = entry;
  const leader = uvPoints(resolved.leader ?? []);
  const leaderDepths = resolved.leaderDepths ?? leader.map(() => 0);
  const frame = drawingViewFrame(view);
  // Every other physical edge of the view's bodies, in (u, v) with depths.
  const others: { points: XY[]; depths: number[] }[] = [];
  for (const bodyId of view.bodyIds) {
    const body = annotationBody(bodies, view, bodyId);
    if (!body?.topology || body.consumed) continue;
    for (const edge of body.topology.edges) {
      if (edge.displayRole === 'seam' || edge.points.length < 6) continue;
      if (
        bodyId === resolved.leaderEdge?.bodyId &&
        edge.topologyId === resolved.leaderEdge.topologyId
      )
        continue;
      const points: XY[] = [];
      const depths: number[] = [];
      for (let i = 0; i + 2 < edge.points.length; i += 3) {
        const projected = projectToView(frame, {
          x: edge.points[i]!,
          y: edge.points[i + 1]!,
          z: edge.points[i + 2]!
        });
        points.push([projected.u, projected.v]);
        depths.push(projected.depth);
      }
      others.push({ points, depths });
    }
  }
  // Physical edges only: a silhouette lying on a hidden edge is not it.
  const edgeRuns = projection.edgeRuns ?? projection;
  const runs = view.hiddenLines
    ? [...edgeRuns.visible, ...edgeRuns.hidden]
    : edgeRuns.visible;
  const pieces: number[][] = [];
  for (const run of runs) {
    const points = uvPoints(run);
    for (let i = 0; i + 1 < points.length; i += 1) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const middle: XY = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const own = nearestWithDepth(leader, leaderDepths, middle);
      // How far the segment strays from an edge: its worst of three points.
      const stray = (points: readonly XY[], depths: readonly number[]) =>
        Math.max(
          nearestWithDepth(points, depths, a).distance,
          nearestWithDepth(points, depths, middle).distance,
          nearestWithDepth(points, depths, b).distance
        );
      const ownStray = stray(leader, leaderDepths);
      if (ownStray > tolerance) continue;
      // The segment belongs to the edge it lies on. Another edge claims it
      // only by lying on it more closely, or, when the two coincide (a
      // box's back top edge behind its front one), by being nearer the
      // viewer there. A separate edge merely within tolerance, drawn as its
      // own run beside this one, does not take this edge's run.
      const coincide = 0.1 * tolerance;
      const depthTolerance = 1e-6 * Math.max(1, Math.abs(own.depth));
      const nearer = others.some((other) => {
        const otherStray = stray(other.points, other.depths);
        if (otherStray > tolerance) return false;
        if (otherStray < ownStray - coincide) return true;
        if (otherStray > ownStray + coincide) return false;
        const at = nearestWithDepth(other.points, other.depths, middle);
        return at.depth < own.depth - depthTolerance;
      });
      if (!nearer) pieces.push([a[0], a[1], b[0], b[1]]);
    }
  }
  return pieces;
}

/**
 * One not-yet-placed annotation laid out as it would be once placed: the
 * same resolution, leader visibility and layout the sheet uses, so the
 * placement preview never draws what the placed annotation would not.
 */
export function previewAnnotationLayer(
  sheet: DrawingSheet,
  draft: DrawingAnnotation,
  views: readonly ComposedView[],
  bodies: AnnotationBodies,
  units: UnitSystem
): ReturnType<typeof composeSheetAnnotations> {
  // v98: an attachment is laid out against its host, so the host (and a
  // frame's own host) is laid out with it.
  const byId = sheetMarkLookup(sheet);
  const hosts: DrawingAnnotation[] = [];
  for (
    let hostId = drawingAnnotationHost(draft), depth = 0;
    hostId && depth < 2;
    depth += 1
  ) {
    const host = byId(hostId);
    if (!host) break;
    hosts.unshift(host);
    hostId = drawingAnnotationHost(host);
  }
  const withDraft = { ...sheet, annotations: [...hosts, draft] };
  return composeSheetAnnotations(
    withDraft,
    views,
    markHiddenLeaders(
      withDraft,
      resolveSheetAnnotations(
        withDraft,
        bodies,
        units,
        undefined,
        undefined,
        undefined,
        // A draft is checked against the letters once it is placed.
        null
      ),
      views,
      units,
      bodies
    ),
    units
  );
}

/**
 * The sheet's annotations laid out on its page, for the preview and both
 * exports. An annotation of a view not yet drawn (`views` holds the drawn
 * ones), or one that is broken, is left out; the workspace marks broken
 * ones itself and export refuses while any is.
 */
export function composeSheetAnnotations(
  sheet: DrawingSheet,
  views: readonly ComposedView[],
  resolutions: ReadonlyMap<DrawingAnnotationId, AnnotationResolution>,
  units: UnitSystem
): {
  strokes: SheetStroke[];
  texts: SheetText[];
  images: SheetImage[];
  boxes: Map<DrawingAnnotationId, AnnotationBox>;
} {
  const strokes: SheetStroke[] = [];
  const texts: SheetText[] = [];
  const images: SheetImage[] = [];
  const boxes = new Map<DrawingAnnotationId, AnnotationBox>();
  const drawn = new Map(views.map((entry) => [entry.view.viewId, entry]));
  // v98: attachments after their hosts (a datum symbol may hang from a
  // frame on a dimension), each in sheet order; a sheet without them keeps
  // its order, so it lays out byte-identical.
  const all = sheet.annotations ?? [];
  const byId = new Map(all.map((entry) => [entry.annotationId, entry]));
  // Hosts never nest deeper than a datum on a frame on a dimension.
  const depth = (annotation: DrawingAnnotation): number => {
    const hostId = drawingAnnotationHost(annotation);
    const host = hostId ? byId.get(hostId) : undefined;
    if (!hostId) return 0;
    return host && drawingAnnotationHost(host) ? 2 : 1;
  };
  const ordered = all.some((annotation) => drawingAnnotationHost(annotation))
    ? [0, 1, 2].flatMap((level) =>
        all.filter((annotation) => depth(annotation) === level)
      )
    : all;
  for (const annotation of ordered) {
    const resolution = resolutions.get(annotation.annotationId);
    if (!resolution?.ok) continue;
    const hostId = drawingAnnotationHost(annotation);
    const host = hostId ? boxes.get(hostId) : undefined;
    // An attachment whose host is not drawn (its view not yet drawn) waits.
    if (hostId && !host) continue;
    let toPage: ((u: number, v: number) => XY) | null = null;
    let view: DrawingView | undefined;
    let k = drawingPaperPerModelUnit(sheet.scale, units);
    if (annotation.viewId) {
      const entry = drawn.get(annotation.viewId);
      if (!entry?.projection.bounds) continue;
      view = entry.view;
      toPage = viewPageTransform(view, entry.projection.bounds, sheet, units);
      // A detail (v78) draws its circles at its own scale.
      k = viewPaperPerModelUnit(view, sheet, units);
    }
    const layout = layoutAnnotation(
      resolution.resolved,
      toPage,
      k,
      annotationAnchor(annotation, view),
      host
    );
    strokes.push(...layout.strokes);
    texts.push(...layout.texts);
    if (layout.images) images.push(...layout.images);
    boxes.set(annotation.annotationId, layout.box);
  }
  return { strokes, texts, images, boxes };
}
