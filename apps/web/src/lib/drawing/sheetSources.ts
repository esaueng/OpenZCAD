import {
  createDrawingSheetId,
  createDrawingViewId,
  DRAWING_SCALE_PRESETS,
  MAX_DRAWING_SCALE_TERM,
  drawingPaperPerModelUnit,
  type BodyId,
  type BodyRepresentation,
  type DrawingPaperSize,
  type DrawingProjectionAngle,
  type DrawingScale,
  type DrawingSheet,
  type DrawingView,
  type DrawingViewOrientation,
  type GeometryBodyRepresentation,
  type UnitSystem
} from '@openzcad/shared';
import type { ProjectionBodyInput } from './projectView';
import { projectedExtent, sheetViewArea, type ViewExtent } from './sheetPage';

type SourceBody = BodyRepresentation | GeometryBodyRepresentation;
type SourceBodies = Readonly<Record<string, SourceBody | undefined>>;

/** Every body any view of the sheet draws, in first-use order. */
export function sheetBodyIds(sheet: Pick<DrawingSheet, 'views'>): BodyId[] {
  return [...new Set(sheet.views.flatMap((view) => view.bodyIds))];
}

/** The projection input for one body, or null when it has no geometry. */
export function projectionBodyInput(
  body: SourceBody
): ProjectionBodyInput | null {
  if (body.mesh.indices.length === 0) return null;
  return {
    vertices: body.mesh.vertices,
    indices: body.mesh.indices,
    faces: body.topology?.faces.map((face) => ({
      triangleStart: face.triangleStart,
      triangleCount: face.triangleCount
    })),
    edges: (body.topology?.edges ?? [])
      .filter((edge) => edge.displayRole !== 'seam' && edge.points.length >= 6)
      .map((edge) => edge.points)
  };
}

/** Two 32-bit FNV-style lanes over the text, as 16 hex digits. */
function hashString(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x5bd1e995);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * A fingerprint of the model a sheet draws: each source body's persistent
 * face and edge hashes (ADR-011 witnesses, which change with the geometry
 * and are stable across replay — display meshes are not) and its extent.
 * Null while any body is missing or its topology is still pending, so a
 * sheet is never fenced to a half-built model.
 */
export function drawingSourceFingerprint(
  bodies: SourceBodies,
  bodyIds: readonly BodyId[]
): string | null {
  const parts: string[] = [];
  for (const bodyId of [...bodyIds].sort()) {
    const body = bodies[bodyId];
    if (!body?.topology) return null;
    const faces = body.topology.faces
      .map((face) => face.hash)
      .sort((a, b) => a - b);
    const edges = body.topology.edges
      .filter((edge) => edge.displayRole !== 'seam')
      .map((edge) => edge.hash)
      .sort((a, b) => a - b);
    const box = [
      body.bbox.min.x,
      body.bbox.min.y,
      body.bbox.min.z,
      body.bbox.max.x,
      body.bbox.max.y,
      body.bbox.max.z
    ].map((value) => Math.round(value * 1e4));
    parts.push(
      `${bodyId}|${faces.join(',')}|${edges.join(',')}|${box.join(',')}`
    );
  }
  return `v1:${hashString(parts.join(';'))}`;
}

/** Projected extent of the bodies' display meshes in one orientation. */
export function estimateViewExtent(
  bodies: SourceBodies,
  bodyIds: readonly BodyId[],
  orientation: DrawingViewOrientation
): ViewExtent | null {
  const meshes = bodyIds
    .map((id) => bodies[id]?.mesh.vertices)
    .filter((vertices): vertices is Float32Array => vertices !== undefined);
  return projectedExtent(orientation, meshes);
}

export function defaultDrawingPaper(units: UnitSystem): {
  size: DrawingPaperSize;
  projectionAngle: DrawingProjectionAngle;
} {
  return units === 'inch'
    ? { size: 'ANSI-B', projectionAngle: 'third' }
    : { size: 'A3', projectionAngle: 'first' };
}

const VIEW_GAP_MM = 15;

/**
 * Where a four-view starter places its views: front base, top and side
 * projected from it on the projection angle's sides, isometric in the free
 * corner. Third angle puts the top above and the right view to the right;
 * first angle puts the top below and the left view to the right.
 */
function starterOrientations(angle: DrawingProjectionAngle): {
  side: DrawingViewOrientation;
  topRow: 'upper' | 'lower';
} {
  return angle === 'third'
    ? { side: 'right', topRow: 'upper' }
    : { side: 'left', topRow: 'lower' };
}

export interface StarterSheetInput {
  name: string;
  bodyIds: BodyId[];
  bodies: SourceBodies;
  units: UnitSystem;
  paper: DrawingSheet['paper'];
  projectionAngle: DrawingProjectionAngle;
  fingerprint: string;
}

/** Standard reductions past the presets, down to the smallest a sheet holds. */
const LARGE_MODEL_SCALES: readonly DrawingScale[] = [
  { numerator: 1, denominator: 200 },
  { numerator: 1, denominator: 500 },
  { numerator: 1, denominator: MAX_DRAWING_SCALE_TERM }
];

/**
 * The largest scale at which the starter's two columns and two rows fit the
 * view area with gaps: a preset, or past them a standard reduction down to
 * 1:1000. Null when even that does not fit.
 */
function fittingScale(
  needU: number,
  needV: number,
  area: { width: number; height: number },
  units: UnitSystem
): DrawingScale | null {
  for (const scale of [...DRAWING_SCALE_PRESETS, ...LARGE_MODEL_SCALES]) {
    const k = drawingPaperPerModelUnit(scale, units);
    if (
      needU * k + 3 * VIEW_GAP_MM <= area.width &&
      needV * k + 3 * VIEW_GAP_MM <= area.height
    )
      return scale;
  }
  return null;
}

/**
 * A new sheet with the four-view starter, scaled to fit its paper. Throws,
 * with a message for the user, when the model is too large to fit at any
 * scale a sheet can hold.
 */
export function createStarterSheet(input: StarterSheetInput): DrawingSheet {
  const { side, topRow } = starterOrientations(input.projectionAngle);
  const extent = (orientation: DrawingViewOrientation) => {
    const box = estimateViewExtent(input.bodies, input.bodyIds, orientation);
    return box
      ? { w: box.maxU - box.minU, h: box.maxV - box.minV }
      : { w: 0, h: 0 };
  };
  const front = extent('front');
  const top = extent('top');
  const sideBox = extent(side);
  const iso = extent('iso');
  const leftColumn = Math.max(front.w, top.w);
  const rightColumn = Math.max(sideBox.w, iso.w);
  const frontRow = Math.max(front.h, sideBox.h);
  const topRowHeight = Math.max(top.h, iso.h);
  const sheetBase = {
    sheetId: createDrawingSheetId(),
    name: input.name,
    paper: input.paper,
    projectionAngle: input.projectionAngle,
    titleBlock: {},
    source: { fingerprint: input.fingerprint }
  };
  const area = sheetViewArea(sheetBase);
  const scale = fittingScale(
    leftColumn + rightColumn,
    frontRow + topRowHeight,
    area,
    input.units
  );
  if (!scale)
    throw new Error(
      `The model is too large for a sheet: its views do not fit ${input.paper.size} paper even at 1:${MAX_DRAWING_SCALE_TERM}.`
    );
  const k = drawingPaperPerModelUnit(scale, input.units);
  const gapU = Math.max(0, (area.width - (leftColumn + rightColumn) * k) / 3);
  const gapV = Math.max(0, (area.height - (frontRow + topRowHeight) * k) / 3);
  const leftX = area.x + gapU + (leftColumn * k) / 2;
  const rightX = area.x + 2 * gapU + leftColumn * k + (rightColumn * k) / 2;
  const lowerRowHeight = topRow === 'upper' ? frontRow : topRowHeight;
  const lowerY = area.y + gapV + (lowerRowHeight * k) / 2;
  const upperY =
    area.y +
    2 * gapV +
    lowerRowHeight * k +
    ((topRow === 'upper' ? topRowHeight : frontRow) * k) / 2;
  const frontY = topRow === 'upper' ? lowerY : upperY;
  const topY = topRow === 'upper' ? upperY : lowerY;
  const frontView: DrawingView = {
    viewId: createDrawingViewId(),
    orientation: 'front',
    bodyIds: [...input.bodyIds],
    centerMm: { x: leftX, y: frontY },
    hiddenLines: true
  };
  const views: DrawingView[] = [
    frontView,
    {
      viewId: createDrawingViewId(),
      orientation: 'top',
      bodyIds: [...input.bodyIds],
      centerMm: { x: leftX, y: topY },
      hiddenLines: true,
      parentViewId: frontView.viewId
    },
    {
      viewId: createDrawingViewId(),
      orientation: side,
      bodyIds: [...input.bodyIds],
      centerMm: { x: rightX, y: frontY },
      hiddenLines: true,
      parentViewId: frontView.viewId
    },
    {
      viewId: createDrawingViewId(),
      orientation: 'iso',
      bodyIds: [...input.bodyIds],
      centerMm: { x: rightX, y: topY },
      // Isometric views conventionally omit hidden lines.
      hiddenLines: false
    }
  ];
  return { ...sheetBase, scale, views };
}
