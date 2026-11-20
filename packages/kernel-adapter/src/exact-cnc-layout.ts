/**
 * L09: the CNC-cut layout. Each part is copied (the build's solids are only
 * read), laid flat on its largest planar face, and its top faces — the
 * planar faces that then face straight up — are projected onto the bed as
 * exact LINE/CIRCLE/ARC entities (span-true polylines where a curve has no
 * exact R12 entity), one DXF layer per face height. The parts are arranged
 * in rows with a gap between them and labelled with their body names on a
 * layer of their own, so a laser or router's CAM can map each height to a
 * cut depth and ignore the labels.
 *
 * Projection is exact for a top face because it is parallel to the bed:
 * projecting it is a rigid motion in its own plane, so circles stay circles
 * of the same radius. The layout is a simple row arrangement, not nesting:
 * parts keep their bounding boxes apart and are never rotated to pack
 * tighter.
 */

import { dxfTextLength, type DxfEntity, type DxfLayer } from '@openzcad/io-dxf';

import {
  dxfPlaneFrame,
  edgeDxfEntities,
  type DxfFaceKernel,
  type DxfPlaneFrame
} from './exact-dxf';

/** The kernel queries the layout reads, on top of the face extraction's. */
export interface CncLayoutKernel extends DxfFaceKernel {
  getSolidFaces(solid: number): Uint32Array | number[];
  faceArea(face: number, deflection: number): number;
}

/** One solid to lay flat, named for its label. */
export interface CncLayoutPart {
  readonly bodyId: string;
  readonly name: string;
  readonly solid: number;
}

/** Why a part has no place in the layout. */
export type CncLayoutRefusalReason =
  /** No planar face to lay it on (a sphere, a cylinder's wall only…). */
  | 'no-flat-face'
  /** Laid flat, no planar face looks straight up (a wedge's slope…). */
  | 'no-top-face'
  /** A mesh reference has no exact faces. */
  | 'mesh-reference';

/** How a status names each refusal, after the part's name. */
export const CNC_LAYOUT_REFUSAL_TEXT: Readonly<
  Record<CncLayoutRefusalReason, string>
> = {
  'no-flat-face': 'has no flat face to lay it on',
  'no-top-face': 'has no flat face looking straight up once laid flat',
  'mesh-reference': 'is a mesh reference with no exact faces'
};

export interface CncLayoutRefusal {
  readonly bodyId: string;
  readonly name: string;
  readonly reason: CncLayoutRefusalReason;
}

/** A part as placed: its extent on the sheet and the heights it cuts at. */
export interface CncLayoutPlacement {
  readonly bodyId: string;
  readonly name: string;
  /** Lower-left corner of the part's extent, in output units. */
  readonly origin: readonly [number, number];
  readonly width: number;
  readonly height: number;
  /** Top-face heights above the bed, in output units, ascending. */
  readonly faceHeights: readonly number[];
}

export interface CncLayout {
  readonly entities: DxfEntity[];
  readonly layers: DxfLayer[];
  readonly placements: CncLayoutPlacement[];
}

/** The adapter's export: the file and what went into it. */
export interface CncLayoutExport {
  readonly text: string;
  readonly placements: readonly CncLayoutPlacement[];
  readonly refused: readonly CncLayoutRefusal[];
  /** Each refusal as a sentence fragment: "Ball has no flat face…". */
  readonly warnings: readonly string[];
}

/** A refusal as the status names it. */
export function cncRefusalText(part: CncLayoutRefusal): string {
  return `${part.name} ${CNC_LAYOUT_REFUSAL_TEXT[part.reason]}`;
}

export interface CncLayoutOptions {
  /** Output units per model unit. */
  readonly scale: number;
  /** Millimetres per model unit (for curve sampling, physical tolerances). */
  readonly modelUnitMm: number;
  /** Millimetres per output unit (gap and label height are physical). */
  readonly outputUnitMm: number;
  /** The clear gap between parts, in millimetres; 10 when absent. */
  readonly gapMm?: number;
}

/** The labels' layer; every face-height layer is `Z…`. */
export const CNC_LAYOUT_LABEL_LAYER = 'LABELS';
const DEFAULT_GAP_MM = 10;
const LABEL_HEIGHT_MM = 3;
/**
 * Two unit normals whose dot product is within this of 1 are the same
 * direction (about 0.0001°); a top face must also hold every boundary
 * vertex within {@link FLAT_TOLERANCE_MM} of one height, which is what
 * actually rules a slight slope out on a large part.
 */
const PARALLEL_TOLERANCE = 1e-12;
/** How far a top face's vertices may differ in height, in millimetres. */
const FLAT_TOLERANCE_MM = 1e-4;
/** Two face areas within this many square millimetres tie. */
const AREA_TIE_MM2 = 1e-6;
/** Face-area deflection; planar faces integrate exactly regardless. */
const AREA_DEFLECTION = 0.01;
/** Heights are grouped and named to this physical resolution (1 µm). */
const HEIGHT_RESOLUTION_MM = 1e-3;
/** The most a label may take once written as DXF TEXT. */
const MAX_LABEL_LENGTH = 120;

type Vec3 = readonly [number, number, number];
type Vec2 = readonly [number, number];

const dot = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A part's top faces as entities in its bed frame, before placement. */
interface FlatPart {
  readonly bodyId: string;
  readonly name: string;
  readonly entities: DxfEntity[];
  readonly heights: number[];
}

interface PlanarFace {
  readonly face: number;
  readonly normal: Vec3;
  /** A point on the face (its first boundary vertex). */
  readonly point: Vec3;
  /**
   * Points along every boundary edge: its ends and its curve at each
   * quarter of its span, so a closed rim (one edge whose ends coincide)
   * still shows a tilt of the plane it lies in.
   */
  readonly vertices: Vec3[];
}

function planarFace(kernel: CncLayoutKernel, face: number): PlanarFace | null {
  if (kernel.getSurfaceType(face) !== 'plane') return null;
  let raw: Float64Array | number[];
  try {
    raw = kernel.getFaceNormal(face);
  } catch {
    // A NURBS-backed plane has no analytic normal: not a face to rest on.
    return null;
  }
  const normal: Vec3 = [raw[0]!, raw[1]!, raw[2]!];
  if (!normal.every(Number.isFinite)) return null;
  const vertices: Vec3[] = [];
  for (const wire of kernel.getFaceWires(face)) {
    for (const edge of kernel.getWireEdges(wire)) {
      const v = kernel.getEdgeVertices(edge);
      vertices.push([v[0]!, v[1]!, v[2]!], [v[3]!, v[4]!, v[5]!]);
      const span = kernel.getEdgeParamSpan(edge);
      const t0 = span[0]!;
      const t1 = span[1]!;
      if (Number.isFinite(t0) && Number.isFinite(t1)) {
        for (const fraction of [0.25, 0.5, 0.75]) {
          const p = kernel.evaluateEdgeCurve(edge, t0 + (t1 - t0) * fraction);
          vertices.push([p[0]!, p[1]!, p[2]!]);
        }
      }
    }
  }
  if (vertices.length === 0) return null;
  return { face, normal, point: vertices[0]!, vertices };
}

/**
 * The face a part rests on: its largest planar face. Ties (a plate's two
 * sides) go to the face whose outward normal points furthest down in the
 * model, so a part modelled lying flat keeps its orientation, then to the
 * first face in the kernel's order.
 */
function bedFace(
  kernel: CncLayoutKernel,
  faces: readonly PlanarFace[],
  modelUnitMm: number
): PlanarFace | null {
  // An absolute tie: a relative one lets a large plate's pocketed side,
  // smaller by a small pocket, tie with its intact side and be chosen.
  const tieArea = AREA_TIE_MM2 / (modelUnitMm * modelUnitMm);
  let best: { face: PlanarFace; area: number } | null = null;
  for (const face of faces) {
    const area = kernel.faceArea(face.face, AREA_DEFLECTION);
    if (!(area > 0)) continue;
    if (!best) {
      best = { face, area };
      continue;
    }
    const tie = Math.abs(area - best.area) <= tieArea;
    if (
      (!tie && area > best.area) ||
      (tie && face.normal[2] < best.face.normal[2] - 1e-9)
    ) {
      best = { face, area };
    }
  }
  return best?.face ?? null;
}

/**
 * The decimals that state 1 µm in an output unit: 3 in millimetres, 4 in
 * centimetres, 5 in inches, 6 in metres.
 */
export function cncHeightDecimals(outputUnitMm: number): number {
  return Math.max(
    0,
    Math.ceil(Math.log10(outputUnitMm / HEIGHT_RESOLUTION_MM) - 1e-9)
  );
}

/** A height in micrometres, as output units at the unit's decimals. */
function heightInUnits(micrometres: number, outputUnitMm: number): number {
  const decimals = cncHeightDecimals(outputUnitMm);
  const value = Number(
    ((micrometres * HEIGHT_RESOLUTION_MM) / outputUnitMm).toFixed(decimals)
  );
  return Object.is(value, -0) ? 0 : value;
}

/** `Z12`, `Z3_5`: a height as an R12 layer name (no `.` allowed). */
export function cncHeightLayer(height: number, outputUnitMm = 1): string {
  const decimals = cncHeightDecimals(outputUnitMm);
  const text = Number(height.toFixed(decimals)).toString();
  return `Z${text.replace('.', '_')}`;
}

function flattenPart(
  kernel: CncLayoutKernel,
  part: CncLayoutPart,
  options: CncLayoutOptions
): FlatPart | CncLayoutRefusal {
  const planar = Array.from(kernel.getSolidFaces(part.solid))
    .map((face) => planarFace(kernel, face))
    .filter((face): face is PlanarFace => face !== null);
  const bed = bedFace(kernel, planar, options.modelUnitMm);
  if (!bed) {
    return { bodyId: part.bodyId, name: part.name, reason: 'no-flat-face' };
  }
  const up: Vec3 = [-bed.normal[0], -bed.normal[1], -bed.normal[2]];
  const bedLevel = dot(up, bed.point);
  const frame: DxfPlaneFrame = dxfPlaneFrame(
    up,
    bed.point,
    options.scale,
    options.modelUnitMm
  );

  // Faces facing straight up, grouped by height above the bed in whole
  // micrometres, so every unit keeps the same physical resolution.
  const flatTolerance = FLAT_TOLERANCE_MM / options.modelUnitMm;
  const byHeight = new Map<number, number[]>();
  for (const face of planar) {
    if (dot(face.normal, up) < 1 - PARALLEL_TOLERANCE) continue;
    const levels = face.vertices.map((vertex) => dot(up, vertex) - bedLevel);
    if (Math.max(...levels) - Math.min(...levels) > flatTolerance) continue;
    const micrometres = Math.round(
      (levels[0]! * options.modelUnitMm) / HEIGHT_RESOLUTION_MM
    );
    if (!(micrometres > 0)) continue;
    const group = byHeight.get(micrometres) ?? [];
    group.push(face.face);
    byHeight.set(micrometres, group);
  }
  if (byHeight.size === 0) {
    return { bodyId: part.bodyId, name: part.name, reason: 'no-top-face' };
  }

  const levels = [...byHeight.keys()].sort((a, b) => a - b);
  const heights = levels.map((level) =>
    heightInUnits(level, options.outputUnitMm)
  );
  const entities: DxfEntity[] = [];
  for (const [index, level] of levels.entries()) {
    const layer = cncHeightLayer(heights[index]!, options.outputUnitMm);
    // An edge two coplanar top faces share is a seam between them, not an
    // outline: cutting it would score a line through the surface.
    const uses = new Map<number, number>();
    const edges: number[] = [];
    for (const face of byHeight.get(level)!) {
      for (const wire of kernel.getFaceWires(face)) {
        for (const edge of kernel.getWireEdges(wire)) {
          if (!uses.has(edge)) edges.push(edge);
          uses.set(edge, (uses.get(edge) ?? 0) + 1);
        }
      }
    }
    for (const edge of edges) {
      if (uses.get(edge)! > 1) continue;
      for (const entity of edgeDxfEntities(kernel, edge, frame)) {
        entities.push({ ...entity, layer });
      }
    }
  }
  if (entities.length === 0) {
    return { bodyId: part.bodyId, name: part.name, reason: 'no-top-face' };
  }
  return { bodyId: part.bodyId, name: part.name, entities, heights };
}

/** Whether the CCW sweep from `from` to `to` (degrees) passes `probe`. */
function sweepContains(from: number, to: number, probe: number): boolean {
  const sweep = (((to - from) % 360) + 360) % 360;
  const offset = (((probe - from) % 360) + 360) % 360;
  return offset <= sweep;
}

/** The exact extent of 2D curve entities: arcs by their axis extremes. */
export function cncEntityBounds(entities: readonly DxfEntity[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (p: Vec2) => {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  };
  for (const entity of entities) {
    switch (entity.kind) {
      case 'line':
        include(entity.start);
        include(entity.end);
        break;
      case 'polyline':
        entity.points.forEach(include);
        break;
      case 'circle': {
        const [cx, cy] = entity.center;
        include([cx - entity.radius, cy - entity.radius]);
        include([cx + entity.radius, cy + entity.radius]);
        break;
      }
      case 'arc': {
        const [cx, cy] = entity.center;
        const r = entity.radius;
        const at = (deg: number): Vec2 => [
          cx + r * Math.cos((deg * Math.PI) / 180),
          cy + r * Math.sin((deg * Math.PI) / 180)
        ];
        include(at(entity.startAngleDeg));
        include(at(entity.endAngleDeg));
        for (const axis of [0, 90, 180, 270]) {
          if (sweepContains(entity.startAngleDeg, entity.endAngleDeg, axis)) {
            include(at(axis));
          }
        }
        break;
      }
      default:
        throw new Error(`CNC layout: unexpected ${entity.kind} entity.`);
    }
  }
  return { minX, minY, maxX, maxY };
}

function translate(entity: DxfEntity, dx: number, dy: number): DxfEntity {
  const move = (p: Vec2): Vec2 => [p[0] + dx, p[1] + dy];
  switch (entity.kind) {
    case 'line':
      return { ...entity, start: move(entity.start), end: move(entity.end) };
    case 'polyline':
      return { ...entity, points: entity.points.map(move) };
    case 'circle':
    case 'arc':
      return { ...entity, center: move(entity.center) };
    default:
      throw new Error(`CNC layout: unexpected ${entity.kind} entity.`);
  }
}

/**
 * A body name as one line of TEXT: control and astral characters (which
 * R12 cannot carry) become `?`, and a long name is cut short by its written
 * length — a non-ASCII character is written as a 7-character escape — so a
 * label never exceeds what a TEXT value may hold.
 */
export function cncLabel(name: string): string {
  const ellipsis = '…';
  let whole = '';
  for (const char of name) {
    const code = char.codePointAt(0)!;
    const printable =
      (code >= 0x20 && code < 0x7f) || (code >= 0xa0 && code <= 0xffff);
    whole += printable ? char : '?';
  }
  // A name that fits is kept whole; only a longer one gives up room for
  // the ellipsis.
  if (dxfTextLength(whole) <= MAX_LABEL_LENGTH) return whole.trim() || '?';
  const room = MAX_LABEL_LENGTH - dxfTextLength(ellipsis);
  let out = '';
  for (const char of whole) {
    if (dxfTextLength(out + char) > room) break;
    out += char;
  }
  return `${out.trim() || '?'}${ellipsis}`;
}

/**
 * Lay the parts flat and arrange them. Parts that cannot be laid flat are
 * returned as refusals; the caller decides whether a layout of the rest is
 * worth writing.
 */
export function cncLayout(
  kernel: CncLayoutKernel,
  parts: readonly CncLayoutPart[],
  options: CncLayoutOptions
): { layout: CncLayout | null; refused: CncLayoutRefusal[] } {
  if (!(options.scale > 0) || !Number.isFinite(options.scale)) {
    throw new Error(`CNC layout: invalid unit scale ${options.scale}.`);
  }
  if (!(options.outputUnitMm > 0) || !Number.isFinite(options.outputUnitMm)) {
    throw new Error(`CNC layout: invalid output unit ${options.outputUnitMm}.`);
  }
  const gapMm = options.gapMm ?? DEFAULT_GAP_MM;
  if (!(gapMm >= 0) || !Number.isFinite(gapMm)) {
    throw new Error(`CNC layout: invalid gap ${gapMm} mm.`);
  }
  const gap = gapMm / options.outputUnitMm;
  const labelHeight = LABEL_HEIGHT_MM / options.outputUnitMm;
  // The label's band under each part: the text and a text height of air.
  const labelBand = labelHeight * 2;

  const flat: FlatPart[] = [];
  const refused: CncLayoutRefusal[] = [];
  for (const part of parts) {
    const result = flattenPart(kernel, part, options);
    if ('reason' in result) refused.push(result);
    else flat.push(result);
  }
  if (flat.length === 0) return { layout: null, refused };

  const sized = flat.map((part) => {
    const bounds = cncEntityBounds(part.entities);
    return {
      part,
      bounds,
      width: bounds.maxX - bounds.minX,
      height: bounds.maxY - bounds.minY
    };
  });
  // Rows about as wide as the parts would be tall laid out square, and
  // never narrower than the widest part.
  const footprint = sized.reduce(
    (sum, { width, height }) =>
      sum + (width + gap) * (height + labelBand + gap),
    0
  );
  const rowLimit = Math.max(
    ...sized.map(({ width }) => width),
    Math.sqrt(footprint)
  );

  const entities: DxfEntity[] = [];
  const placements: CncLayoutPlacement[] = [];
  const heightLayers = new Set<string>();
  let x = 0;
  let rowY = 0;
  let rowHeight = 0;
  for (const { part, bounds, width, height } of sized) {
    if (x > 0 && x + width > rowLimit) {
      rowY += rowHeight + gap;
      x = 0;
      rowHeight = 0;
    }
    const originY = rowY + labelBand;
    const dx = x - bounds.minX;
    const dy = originY - bounds.minY;
    for (const entity of part.entities)
      entities.push(translate(entity, dx, dy));
    entities.push({
      kind: 'text',
      layer: CNC_LAYOUT_LABEL_LAYER,
      position: [x, rowY],
      height: labelHeight,
      text: cncLabel(part.name)
    });
    for (const h of part.heights)
      heightLayers.add(cncHeightLayer(h, options.outputUnitMm));
    placements.push({
      bodyId: part.bodyId,
      name: part.name,
      origin: [x, originY],
      width,
      height,
      faceHeights: part.heights
    });
    x += width + gap;
    rowHeight = Math.max(rowHeight, height + labelBand);
  }

  // Layers by ascending height: ACI 1–6 in turn, then the labels in 7.
  const ordered = [...heightLayers].sort(
    (a, b) =>
      Number(a.slice(1).replace('_', '.')) -
      Number(b.slice(1).replace('_', '.'))
  );
  const layers: DxfLayer[] = [
    ...ordered.map((name, index) => ({ name, color: (index % 6) + 1 })),
    { name: CNC_LAYOUT_LABEL_LAYER, color: 7 }
  ];
  return { layout: { entities, layers, placements }, refused };
}
