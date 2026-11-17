/**
 * M16 sheet-metal features: a flat blank folded by a table of bends
 * ([specification](../../../docs/plans/sheet-metal-plan.md), "Exact build").
 *
 * The build is composed from ordinary kernel operations. Everything happens
 * in the blank's sketch frame (x along `u`, y along `v`, z along the sketch
 * normal), where the plate's faces are `z = const` and
 * `@openzcad/shared`'s fold kinematics apply as written:
 *
 * 1. The blank is extruded to the thickness and moved into the sketch frame.
 * 2. Relief slots are cut from it, giving the flat sheet `F` (the flat
 *    pattern).
 * 3. Each bend's zone box cuts `F` into regions and takes a zone piece.
 * 4. The checks run, each a named `sheet-metal:<reason>` refusal.
 * 5. The regions form a tree from the fixed region. Each region moves
 *    rigidly; each zone piece's parent-side face is revolved about the bend
 *    axis.
 * 6. The pieces are fused pairwise in tree order (parent first), the result
 *    is checked against the analytic volume, named by role, and placed in
 *    the world.
 *
 * Nothing is named by output order: a face is named from the plane, cylinder
 * or sketch curve it lies on and the region it belongs to.
 */
import {
  applyAffine,
  bendZoneStart,
  bentZoneVolume,
  composeAffine,
  isFeatureManuallySuppressed,
  isFeatureRollbackSuppressed,
  minimumFlangeLength,
  minimumHoleToBendDistance,
  minimumReliefWidth,
  resolveKFactor,
  SHEET_METAL_IDENTITY,
  SHEET_METAL_MOLD_LINE_MAX_ANGLE_DEG,
  sheetMetalBendMetrics,
  sheetMetalFold,
  sheetMetalMaterialById,
  type BodyId,
  type FeatureId,
  type FeatureNode,
  type ParamValue,
  type ProjectDocument,
  type SheetMetalAffine,
  type SheetMetalBend,
  type SheetMetalBendMetrics,
  type SheetMetalBendPosition,
  type SheetMetalRelief,
  type SheetMetalReliefShape,
  type SheetMetalVec3,
  type SketchId
} from '@openzcad/shared';
import {
  findSketch,
  listFeaturesInOrder,
  resolveParamValue
} from '@openzcad/document-core';
import type { PlaneBasis } from '@openzcad/geometry';
import type { DxfEntity } from '@openzcad/io-dxf';

import { faceComponentsOf } from './exact-boolean-helpers';
import type { FeatureBuildContext, FeatureDataOf } from './exact-build-loop';
import { dxfSampleDeflection, edgeDxfEntities } from './exact-dxf';
import { raiseFeatureWarning } from './exact-feature-warnings';
import { withFacePairEdgeLineage } from './exact-gear-edges';
import { topologyCandidatesForSolid } from './exact-lineage-builders';
import { affineMatrix } from './exact-math';
import {
  buildRegionExtrude,
  regionSideSources
} from './exact-profile-builders';
import { assertFeatureSketchProjectionsValid } from './exact-sketch-projection-failures';
import type { ExactBuildResult } from './exact-types';
import { KernelRefusal, type KernelRefusalCategory } from './kernel-refusal';
import {
  createRemusSemanticLineage,
  type RemusLineageState,
  type RemusSemanticAssignment
} from './remus-lineage';
import type { RemusKernel } from './remus-runtime';

type P2 = readonly [number, number];
type V3 = SheetMetalVec3;

const DEG = Math.PI / 180;
/** The kernel's volume of planes and cylinders is analytic at any value. */
const VOLUME_DEFLECTION = 1e-4;
/** Lengths this close, as a fraction of the blank's diagonal, coincide. */
const LENGTH_TOLERANCE_RATIO = 1e-8;
/** Unit vectors whose cross or dot differs from 0 or 1 by less are aligned. */
const DIRECTION_TOLERANCE = 1e-9;
/** Volumes this close, as a fraction of the expected volume, agree. */
const VOLUME_TOLERANCE_RATIO = 1e-7;
/** A zone box reaches this fraction of the thickness past its line's ends. */
const ZONE_END_MARGIN_RATIO = 0.01;

/** The reasons a sheet-metal build refuses, as `sheet-metal:<code>`. */
export type SheetMetalRefusalCode =
  | 'invalid-parameter'
  | 'bend-line-missing'
  | 'bend-line-not-coplanar'
  | 'bend-line-outside'
  | 'bend-zone-not-clear'
  | 'bends-overlap'
  | 'bend-not-separating'
  | 'bend-loop'
  | 'folded-overlap'
  | 'relief-failed'
  | 'fold-failed';

function refuse(
  code: SheetMetalRefusalCode,
  reason: string,
  category: KernelRefusalCategory = 'invalid_input'
): never {
  throw new KernelRefusal({
    family: 'sheet-metal',
    category,
    kernelCode: `sheet-metal:${code}`,
    kernelMessage: reason,
    reason,
    message: `Sheet metal: ${reason}`
  });
}

// ---------------------------------------------------------------------------
// Small vector helpers
// ---------------------------------------------------------------------------

const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
const norm3 = (a: V3): number => Math.hypot(a[0], a[1], a[2]);

/** The inverse of a rigid motion (rotation and translation only). */
function invertRigid(m: SheetMetalAffine): SheetMetalAffine {
  const t: V3 = [m[3], m[7], m[11]];
  return [
    m[0],
    m[4],
    m[8],
    -(m[0] * t[0] + m[4] * t[1] + m[8] * t[2]),
    m[1],
    m[5],
    m[9],
    -(m[1] * t[0] + m[5] * t[1] + m[9] * t[2]),
    m[2],
    m[6],
    m[10],
    -(m[2] * t[0] + m[6] * t[1] + m[10] * t[2])
  ];
}

/** A rigid motion's rotation applied to a direction. */
function rotate(m: SheetMetalAffine, v: V3): V3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[4] * v[0] + m[5] * v[1] + m[6] * v[2],
    m[8] * v[0] + m[9] * v[1] + m[10] * v[2]
  ];
}

function vertexPositions(
  kernel: RemusKernel,
  vertices: Iterable<number>
): V3[] {
  const points: V3[] = [];
  for (const vertex of vertices) {
    const p = kernel.getVertexPosition(vertex);
    points.push([p[0]!, p[1]!, p[2]!]);
  }
  return points;
}

/** A prism on a counter-clockwise sketch-frame polygon, from `z0` to `z1`. */
function prism(
  kernel: RemusKernel,
  points: readonly P2[],
  z0: number,
  z1: number
): number {
  const area = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]!;
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0);
  const ordered = area >= 0 ? points : [...points].reverse();
  const face = kernel.makePolygon(
    new Float64Array(ordered.flatMap(([x, y]) => [x, y, z0]))
  );
  return kernel.extrude(face, 0, 0, 1, z1 - z0);
}

// ---------------------------------------------------------------------------
// Resolved inputs
// ---------------------------------------------------------------------------

interface ResolvedRelief {
  shape: SheetMetalReliefShape;
  width: number;
  extension: number;
}

/** One bend with its numbers resolved, in the blank's sketch frame. */
interface ResolvedBend {
  bend: SheetMetalBend;
  label: string;
  p0: P2;
  /** Unit direction along the line, from its first to its second end. */
  along: P2;
  /** Unit normal to the left of `along`; `n` coordinates are along it. */
  left: P2;
  length: number;
  metrics: SheetMetalBendMetrics;
  position: SheetMetalBendPosition;
  relief: ResolvedRelief;
}

/** A bend's zone in the flat for a chosen moving side. */
interface Zone {
  /** `+1` when the moving side is to the left of the line, else `-1`. */
  side: 1 | -1;
  /** Zone start `s₀` along the moving normal. */
  start: number;
  /** The zone along `left`: `[lo, hi]`. */
  lo: number;
  hi: number;
}

/** One connected piece of a bend zone: a rectangular prism across it. */
interface ZonePiece {
  bend: number;
  /** Index among the bend's pieces, counted along the line. */
  index: number;
  /** Extent along the line from its first end. */
  from: number;
  to: number;
  /** The region on each side of the zone along `left`. */
  loRegion: number;
  hiRegion: number;
}

interface Region {
  /** The region in the flat sketch frame (never moved). */
  flat: number;
  volume: number;
  vertices: V3[];
}

interface EdgeSource {
  token: string;
  /** A vertical plane `normal · (x, y) = offset`, or a vertical cylinder. */
  carrier:
    | {
        kind: 'plane';
        normal: P2;
        offset: number;
        /** The stretch of the plane's line this source covers. */
        segment: readonly [P2, P2];
      }
    | { kind: 'cylinder'; center: P2; radius: number };
}

/** A vertical plane source standing on the sketch-frame segment `a`–`b`. */
function planeSource(token: string, a: P2, b: P2): EdgeSource | null {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!(length > 0)) return null;
  const normal: P2 = [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];
  return {
    token,
    carrier: {
      kind: 'plane',
      normal,
      offset: normal[0] * a[0] + normal[1] * a[1],
      segment: [a, b]
    }
  };
}

/** Whether a sketch-frame point lies on the segment `a`–`b`. */
function onSegment(
  point: V3 | P2,
  [a, b]: readonly [P2, P2],
  tol: number
): boolean {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (!(length > 0)) return false;
  const px = point[0] - a[0];
  const py = point[1] - a[1];
  const along = (px * dx + py * dy) / length;
  return (
    Math.abs(px * dy - py * dx) / length <= tol &&
    along >= -tol &&
    along <= length + tol
  );
}

interface TreeNode {
  region: number;
  /** Stable name of the region: `fixed`, or the bend piece that carries it. */
  key: string;
  /**
   * The zone pieces joining this region to its parent: none at the root, one
   * for most bends, several where one bend line crosses a window or notch
   * between the same two regions.
   */
  pieces: number[];
  parent: number | null;
}

interface SheetMetalFrame {
  basis: PlaneBasis;
  toWorld: SheetMetalAffine;
  toLocal: SheetMetalAffine;
}

/** The flat sheet, its bends and its region tree: everything but the fold. */
interface SheetMetalPlan {
  kernel: RemusKernel;
  frame: SheetMetalFrame;
  thickness: number;
  z0: number;
  z1: number;
  tolerance: number;
  /** The flat sheet `F` in the sketch frame. */
  flat: number;
  flatVolume: number;
  sources: EdgeSource[];
  bends: ResolvedBend[];
  zones: Zone[];
  pieces: ZonePiece[];
  regions: Region[];
  /** Regions in breadth-first order from the fixed one. */
  tree: TreeNode[];
  advisories: string[];
}

interface PlanInput {
  kernel: RemusKernel;
  document: ProjectDocument;
  scope: Record<string, number>;
  sketchBases: ReadonlyMap<SketchId, PlaneBasis>;
  feature: FeatureNode;
  data: FeatureDataOf<'sheet-metal'>;
}

function frameOf(basis: PlaneBasis): SheetMetalFrame {
  const toWorld: SheetMetalAffine = [
    basis.u.x,
    basis.v.x,
    basis.normal.x,
    basis.origin.x,
    basis.u.y,
    basis.v.y,
    basis.normal.y,
    basis.origin.y,
    basis.u.z,
    basis.v.z,
    basis.normal.z,
    basis.origin.z
  ];
  return { basis, toWorld, toLocal: invertRigid(toWorld) };
}

function resolveRelief(
  relief: SheetMetalRelief | undefined,
  thickness: number,
  resolve: (value: ParamValue, label: string) => number,
  label: string
): ResolvedRelief {
  const shape = relief?.shape ?? 'rectangular';
  const width =
    relief?.width === undefined
      ? thickness
      : resolve(relief.width, `${label} width`);
  const extension =
    relief?.extension === undefined
      ? thickness
      : resolve(relief.extension, `${label} extension`);
  if (shape !== 'none') {
    if (!(width > 0) || !Number.isFinite(width)) {
      refuse('invalid-parameter', `The ${label} width must be greater than 0.`);
    }
    if (!(extension >= 0) || !Number.isFinite(extension)) {
      refuse(
        'invalid-parameter',
        `The ${label} extension must not be negative.`
      );
    }
  }
  return { shape, width, extension };
}

function resolveBends(
  input: PlanInput,
  frame: SheetMetalFrame,
  thickness: number,
  defaultRadius: number,
  defaultK: number,
  tolerance: number
): ResolvedBend[] {
  const { document, scope, data, sketchBases } = input;
  const resolve = (value: ParamValue, label: string) =>
    resolveParamValue(value, scope, `sheet metal ${label}`, document.units);
  return data.bends.map((bend, index) => {
    const label = `bend ${index + 1}`;
    const sketch = findSketch(document, bend.line.sketchId);
    const node = document.nodes[bend.line.objectId];
    if (
      !sketch ||
      !sketch.objectIds.includes(bend.line.objectId) ||
      node?.kind !== 'sketch-object' ||
      node.data.objectKind !== 'line'
    ) {
      refuse(
        'bend-line-missing',
        `The line of ${label} no longer exists or is not a straight line. Pick a line for the bend again.`
      );
    }
    const basis = sketchBases.get(sketch.sketchId);
    if (!basis) {
      refuse(
        'bend-line-missing',
        `The sketch holding the line of ${label} did not resolve at this point in the history.`
      );
    }
    const normal: V3 = [basis.normal.x, basis.normal.y, basis.normal.z];
    const blankNormal: V3 = [
      frame.basis.normal.x,
      frame.basis.normal.y,
      frame.basis.normal.z
    ];
    const origin = applyAffine(frame.toLocal, [
      basis.origin.x,
      basis.origin.y,
      basis.origin.z
    ]);
    if (
      norm3(cross3(normal, blankNormal)) > DIRECTION_TOLERANCE ||
      Math.abs(origin[2]) > tolerance
    ) {
      refuse(
        'bend-line-not-coplanar',
        `The line of ${label} is not on the blank's sketch plane. Draw it in the blank's sketch or in a sketch on the same plane.`
      );
    }
    const local = (x: ParamValue, y: ParamValue): P2 => {
      const sx = resolve(x, `${label} line`);
      const sy = resolve(y, `${label} line`);
      const point = applyAffine(frame.toLocal, [
        basis.origin.x + basis.u.x * sx + basis.v.x * sy,
        basis.origin.y + basis.u.y * sx + basis.v.y * sy,
        basis.origin.z + basis.u.z * sx + basis.v.z * sy
      ]);
      return [point[0], point[1]];
    };
    const p0 = local(node.data.x1, node.data.y1);
    const p1 = local(node.data.x2, node.data.y2);
    const length = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    if (!(length > tolerance)) {
      refuse('bend-line-missing', `The line of ${label} has no length.`);
    }
    const along: P2 = [(p1[0] - p0[0]) / length, (p1[1] - p0[1]) / length];
    const angleDeg = resolve(bend.angleDeg, `${label} angle`);
    if (!(angleDeg > 0 && angleDeg <= 180)) {
      refuse(
        'invalid-parameter',
        `The angle of ${label} must be greater than 0° and at most 180°.`
      );
    }
    const radius =
      bend.radius === undefined
        ? defaultRadius
        : resolve(bend.radius, `${label} inside radius`);
    if (!(radius > 0) || !Number.isFinite(radius)) {
      refuse(
        'invalid-parameter',
        `The inside radius of ${label} must be greater than 0.`
      );
    }
    let k: number;
    try {
      k =
        bend.kFactor === undefined
          ? resolveKFactor(
              data.kFactorMethod ?? 'value',
              defaultK,
              radius,
              thickness
            )
          : resolveKFactor(
              'value',
              resolve(bend.kFactor, `${label} K-factor`),
              radius,
              thickness
            );
    } catch {
      refuse(
        'invalid-parameter',
        `The K-factor of ${label} must be greater than 0 and less than 1.`
      );
    }
    const position = bend.position ?? 'centerline';
    if (
      position === 'outside-mold-line' &&
      angleDeg > SHEET_METAL_MOLD_LINE_MAX_ANGLE_DEG
    ) {
      refuse(
        'invalid-parameter',
        `${label[0]!.toUpperCase()}${label.slice(1)} is placed by its outside mold line, which needs an angle of at most ${SHEET_METAL_MOLD_LINE_MAX_ANGLE_DEG}°.`
      );
    }
    return {
      bend,
      label,
      p0,
      along,
      left: [-along[1], along[0]],
      length,
      metrics: sheetMetalBendMetrics(angleDeg * DEG, radius, thickness, k),
      position,
      relief: resolveRelief(
        bend.relief ?? data.relief,
        thickness,
        resolve,
        `${label} relief`
      )
    };
  });
}

function zoneOf(bend: ResolvedBend, side: 1 | -1, centered: boolean): Zone {
  const start = centered
    ? -bend.metrics.bendAllowance / 2
    : bendZoneStart(bend.position, bend.metrics);
  const a = side * start;
  const b = side * (start + bend.metrics.bendAllowance);
  return { side, start, lo: Math.min(a, b), hi: Math.max(a, b) };
}

/** A sketch-frame point from a bend's line coordinates. */
function bendPoint(bend: ResolvedBend, along: number, across: number): P2 {
  return [
    bend.p0[0] + bend.along[0] * along + bend.left[0] * across,
    bend.p0[1] + bend.along[1] * along + bend.left[1] * across
  ];
}

/** A point's coordinates along a bend's line and across it. */
function bendCoordinates(bend: ResolvedBend, point: V3 | P2): P2 {
  const x = point[0] - bend.p0[0];
  const y = point[1] - bend.p0[1];
  return [
    x * bend.along[0] + y * bend.along[1],
    x * bend.left[0] + y * bend.left[1]
  ];
}

function zoneCorners(bend: ResolvedBend, zone: Zone, margin: number): P2[] {
  return [
    bendPoint(bend, -margin, zone.lo),
    bendPoint(bend, bend.length + margin, zone.lo),
    bendPoint(bend, bend.length + margin, zone.hi),
    bendPoint(bend, -margin, zone.hi)
  ];
}

/** Whether two convex polygons share area (separating-axis test). */
function convexOverlap(
  a: readonly P2[],
  b: readonly P2[],
  tol: number
): boolean {
  for (const polygon of [a, b]) {
    for (let index = 0; index < polygon.length; index += 1) {
      const p = polygon[index]!;
      const q = polygon[(index + 1) % polygon.length]!;
      const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (!(length > 0)) continue;
      const axis: P2 = [-(q[1] - p[1]) / length, (q[0] - p[0]) / length];
      const span = (points: readonly P2[]) => {
        const values = points.map(
          (point) => point[0] * axis[0] + point[1] * axis[1]
        );
        return [Math.min(...values), Math.max(...values)] as const;
      };
      const [aMin, aMax] = span(a);
      const [bMin, bMax] = span(b);
      if (aMax - bMin <= tol || bMax - aMin <= tol) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// The flat sheet
// ---------------------------------------------------------------------------

function analyticParams(
  kernel: RemusKernel,
  face: number
): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(kernel.getAnalyticSurfaceParams(face));
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function vector3(value: unknown): V3 | null {
  return Array.isArray(value) &&
    value.length === 3 &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
    ? [value[0] as number, value[1] as number, value[2] as number]
    : null;
}

/**
 * The blank extruded to the thickness, in the sketch frame, with the sketch
 * curve each of its side faces was drawn by.
 */
function buildBlank(
  input: PlanInput,
  frame: SheetMetalFrame,
  thickness: number,
  negativeSide: boolean
): { solid: number; sources: EdgeSource[] } {
  const { kernel, document, scope, feature, data } = input;
  const sketch = findSketch(document, data.sketchId);
  if (!sketch) {
    refuse('invalid-parameter', "The blank's sketch no longer exists.");
  }
  const shape = buildRegionExtrude(
    kernel,
    document,
    sketch,
    feature,
    {
      featureKind: 'extrude',
      sketchId: data.sketchId,
      profiles: data.profiles,
      distance: negativeSide ? -thickness : thickness
    },
    scope,
    frame.basis,
    () => undefined
  );
  if (shape.solids.length !== 1) {
    refuse(
      'invalid-parameter',
      'The blank must be one connected piece. Pick sketch cells that touch, or make a second sheet-metal part.'
    );
  }
  const solid = shape.solids[0]!;
  kernel.transformSolid(solid, affineMatrix([...frame.toLocal]));
  // Each boundary curve of the blank, with the name its edge face takes.
  const sources: EdgeSource[] = [];
  for (const curve of regionSideSources(document, sketch, data, scope) ?? []) {
    if (curve.kind === 'line') {
      const source = planeSource(
        curve.token,
        [curve.a.x, curve.a.y],
        [curve.b.x, curve.b.y]
      );
      if (source) sources.push(source);
    } else {
      sources.push({
        token: curve.token,
        carrier: {
          kind: 'cylinder',
          center: [curve.center.x, curve.center.y],
          radius: curve.radius
        }
      });
    }
  }
  return { solid, sources };
}

/**
 * One relief slot as a cutting tool, from `zLo` to `zHi`: a rectangle along
 * the line from `from` to `to` and across it from the zone's moving edge to
 * `back`; an obround one is closed past `back` by a semicircle on that width
 * (two quarter arcs, so the tool is one profile with tangent joins rather
 * than a box and a cylinder the exact boolean will not cut in turn).
 */
function reliefTool(
  kernel: RemusKernel,
  bend: ResolvedBend,
  obround: boolean,
  from: number,
  to: number,
  movingEdge: number,
  back: number,
  zLo: number,
  zHi: number
): number {
  if (!obround) {
    return prism(
      kernel,
      [
        bendPoint(bend, from, movingEdge),
        bendPoint(bend, to, movingEdge),
        bendPoint(bend, to, back),
        bendPoint(bend, from, back)
      ],
      zLo,
      zHi
    );
  }
  // Counter-clockwise in the sketch frame whichever way the slot points.
  const away = Math.sign(back - movingEdge) || 1;
  const first = away > 0 ? from : to;
  const second = away > 0 ? to : from;
  const radius = (to - from) / 2;
  const middle = (from + to) / 2;
  const p1 = bendPoint(bend, first, movingEdge);
  const p2 = bendPoint(bend, second, movingEdge);
  const p3 = bendPoint(bend, second, back);
  const apex = bendPoint(bend, middle, back + away * radius);
  const p4 = bendPoint(bend, first, back);
  const center = bendPoint(bend, middle, back);
  const lineEdge = (a: P2, b: P2) =>
    kernel.makeLineEdge(a[0], a[1], zLo, b[0], b[1], zLo);
  const arcEdge = (a: P2, b: P2) =>
    kernel.makeCircleArc3d(
      a[0],
      a[1],
      zLo,
      b[0],
      b[1],
      zLo,
      center[0],
      center[1],
      zLo,
      0,
      0,
      1
    );
  const wire = kernel.makeWire(
    Uint32Array.from([
      lineEdge(p1, p2),
      lineEdge(p2, p3),
      arcEdge(p3, apex),
      arcEdge(apex, p4),
      lineEdge(p4, p1)
    ]),
    true
  );
  return kernel.extrude(kernel.makeFaceFromWire(wire), 0, 0, 1, zHi - zLo);
}

/**
 * Cuts each bend's relief slots (spec "Reliefs") and records the planes and
 * cylinders their walls lie on.
 *
 * Every slot is cut by the exact kernel, which decides what it meets: a slot
 * off the sheet, or only touching it, comes back unchanged. Where the kernel
 * declines the tool that passes through the plate (a slot that swallows a
 * whole lug standing off the blank's edge), the same slot is cut flush with
 * the plate's faces, which it does build. A slot neither tool cuts refuses
 * `relief-failed` by name; a relief is never skipped or swapped for another.
 */
function cutReliefs(
  kernel: RemusKernel,
  blank: number,
  bends: readonly ResolvedBend[],
  zones: readonly Zone[],
  z0: number,
  z1: number,
  sources: EdgeSource[]
): number {
  let flat = blank;
  const thickness = z1 - z0;
  bends.forEach((bend, index) => {
    const { shape, width, extension } = bend.relief;
    if (shape === 'none') return;
    const zone = zones[index]!;
    // The slot runs from the zone's moving edge back past its fixed edge.
    const fixedEdge = zone.side === 1 ? zone.lo : zone.hi;
    const movingEdge = zone.side === 1 ? zone.hi : zone.lo;
    const reach =
      shape === 'obround' ? Math.max(extension - width / 2, 0) : extension;
    const back = fixedEdge - zone.side * reach;
    const lo = Math.min(back, movingEdge);
    const hi = Math.max(back, movingEdge);
    for (const end of ['start', 'end'] as const) {
      const near = end === 'start' ? 0 : bend.length;
      const far = end === 'start' ? -width : bend.length + width;
      const from = Math.min(near, far);
      const to = Math.max(near, far);
      let cut: number | null = null;
      let failure = 'the kernel returned no result';
      for (const [zLo, zHi] of [
        [z0 - thickness, z1 + thickness],
        [z0, z1]
      ] as const) {
        try {
          const outcome = kernel.cutDetailed(
            flat,
            reliefTool(
              kernel,
              bend,
              shape === 'obround',
              from,
              to,
              movingEdge,
              back,
              zLo,
              zHi
            )
          );
          if (outcome.status === 'ok') {
            cut = outcome.value;
            break;
          }
          failure = outcome.code;
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
      }
      if (cut === null) {
        refuse(
          'relief-failed',
          `The ${shape} relief at the ${end} of ${bend.label} could not be cut exactly (${failure}). Change its width or extension, use another relief shape, or tidy the edge beside the bend.`,
          'unsupported'
        );
      }
      flat = cut;
      const name = `relief[${bend.bend.id}].${end}`;
      const wall = (suffix: string, a: P2, b: P2) => {
        const source = planeSource(`${name}.${suffix}`, a, b);
        if (source) sources.push(source);
      };
      wall('near', bendPoint(bend, near, lo), bendPoint(bend, near, hi));
      wall('far', bendPoint(bend, far, lo), bendPoint(bend, far, hi));
      wall(
        'front',
        bendPoint(bend, from, movingEdge),
        bendPoint(bend, to, movingEdge)
      );
      if (shape === 'obround') {
        sources.push({
          token: `${name}.round`,
          carrier: {
            kind: 'cylinder',
            center: bendPoint(bend, (near + far) / 2, back),
            radius: width / 2
          }
        });
      } else {
        wall('back', bendPoint(bend, from, back), bendPoint(bend, to, back));
      }
    }
  });
  if (flat !== blank) kernel.unifyFaces(flat);
  return flat;
}

function boxesOverlap(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  tol: number
): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if (a[axis + 3]! - b[axis]! <= tol || b[axis + 3]! - a[axis]! <= tol) {
      return false;
    }
  }
  return true;
}

/**
 * Whether the segment `a`–`b` passes through the open rectangle
 * `(x0, x1) × (y0, y1)` (Liang–Barsky clipping).
 */
function segmentCrossesRectangle(
  a: P2,
  b: P2,
  x0: number,
  x1: number,
  y0: number,
  y1: number
): boolean {
  if (!(x1 > x0) || !(y1 > y0)) return false;
  let enter = 0;
  let leave = 1;
  const clip = (delta: number, distance: number): boolean => {
    if (delta === 0) return distance >= 0;
    const t = distance / delta;
    if (delta < 0) enter = Math.max(enter, t);
    else leave = Math.min(leave, t);
    return enter <= leave;
  };
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return (
    clip(-dx, a[0] - x0) &&
    clip(dx, x1 - a[0]) &&
    clip(-dy, a[1] - y0) &&
    clip(dy, y1 - a[1])
  );
}

/**
 * The pieces of a bend zone: the stretches of the line along which the flat
 * sheet fills the zone's strip from one clean cross edge to the next.
 *
 * Every edge face of `flat` that enters the strip must be a plane square to
 * the line that crosses the whole strip; anything else (a hole, a notch, an
 * angled or parallel edge) leaves the zone not clear. A piece that reaches
 * past an end of the line is still attached beside the bend.
 */
function zonePieces(
  kernel: RemusKernel,
  flat: number,
  bend: ResolvedBend,
  zone: Zone,
  margin: number,
  z0: number,
  z1: number,
  tolerance: number
): { from: number; to: number }[] {
  const start = -margin;
  const end = bend.length + margin;
  const notClear = (): never =>
    refuse(
      'bend-zone-not-clear',
      `A hole, notch or angled edge lies inside the zone of ${bend.label}. Keep the strip ${formatted(bend.metrics.bendAllowance)} wide along the line clear, or move the bend.`
    );
  // The strip that must be clear is the line's own length; the box's margin
  // past each end only shows whether the sheet runs on beside the bend.
  const inside = ([along, across]: P2): boolean =>
    along > tolerance &&
    along < bend.length - tolerance &&
    across > zone.lo + tolerance &&
    across < zone.hi - tolerance;
  const cuts: number[] = [];
  for (const face of kernel.getSolidFaces(flat)) {
    if (kernel.getSurfaceType(face) !== 'plane') {
      // A curved edge face: any of it within the strip spoils the zone.
      const mesh = kernel.tessellateFace(face, (z1 - z0) / 50);
      try {
        const positions = mesh.positions;
        for (let at = 0; at + 2 < positions.length; at += 3) {
          if (
            inside(bendCoordinates(bend, [positions[at]!, positions[at + 1]!]))
          ) {
            notClear();
          }
        }
      } finally {
        mesh.free();
      }
      continue;
    }
    const normal = kernel.getFaceNormal(face);
    if (Math.abs(Math.abs(normal[2]!) - 1) <= DIRECTION_TOLERANCE) continue;
    // An edge face stands on a segment of the outline: its two far corners.
    const corners = vertexPositions(kernel, kernel.getFaceVertices(face)).map(
      (point) => bendCoordinates(bend, point)
    );
    let a = corners[0];
    let b = corners[0];
    let span = -1;
    for (const p of corners) {
      for (const q of corners) {
        const distance = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (distance > span) {
          span = distance;
          a = p;
          b = q;
        }
      }
    }
    if (!a || !b) continue;
    const square = Math.abs(a[0] - b[0]) <= tolerance;
    const across =
      Math.min(a[1], b[1]) <= zone.lo + tolerance &&
      Math.max(a[1], b[1]) >= zone.hi - tolerance;
    if (
      segmentCrossesRectangle(
        a,
        b,
        tolerance,
        bend.length - tolerance,
        zone.lo + tolerance,
        zone.hi - tolerance
      )
    ) {
      if (!square || !across) notClear();
      cuts.push(a[0]);
    } else if (
      square &&
      across &&
      a[0] >= start - tolerance &&
      a[0] <= end + tolerance
    ) {
      // A clean cross edge at an end of the line, or just past it.
      cuts.push(a[0]);
    }
  }
  const bounds = [start, ...cuts.sort((left, right) => left - right), end];
  const middle = (zone.lo + zone.hi) / 2;
  const height = (z0 + z1) / 2;
  const pieces: { from: number; to: number }[] = [];
  for (let index = 0; index + 1 < bounds.length; index += 1) {
    const from = bounds[index]!;
    const to = bounds[index + 1]!;
    if (to - from <= tolerance) continue;
    const point = bendPoint(bend, (from + to) / 2, middle);
    if (
      kernel.classifyPoint(flat, point[0], point[1], height, tolerance) !==
      'inside'
    ) {
      continue;
    }
    if (from < -tolerance || to > bend.length + tolerance) {
      refuse(
        'bend-not-separating',
        `The sheet is still attached beside ${bend.label}, past an end of its line. Extend the line across the flange, or add relief at that end.`
      );
    }
    const last = pieces[pieces.length - 1];
    if (last && Math.abs(last.to - from) <= tolerance) last.to = to;
    else pieces.push({ from, to });
  }
  if (pieces.length === 0) {
    refuse(
      'bend-line-outside',
      `The zone of ${bend.label} does not cross the sheet. Move the line onto the blank.`
    );
  }
  return pieces;
}

/**
 * `flat` with every zone box cut away, as one solid per connected region.
 *
 * The kernel's region boolean keeps disconnected results apart, but declines
 * some it cannot give a complete lineage (a zone crossing a window). The
 * plain cut builds those; each face-connected lump of its result is then
 * rebuilt as its own solid from copies of its faces, and the lumps' volumes
 * must add up to the whole.
 */
function cutRegions(
  kernel: RemusKernel,
  flat: number,
  boxes: readonly number[]
): number[] {
  if (boxes.length === 0) return [kernel.copySolid(flat)];
  let remaining = flat;
  for (const box of boxes.slice(0, -1)) remaining = kernel.cut(remaining, box);
  const last = boxes[boxes.length - 1]!;
  try {
    return Array.from(
      kernel.getCompoundSolids(kernel.booleanRegions('cut', remaining, last))
    );
  } catch {
    const cut = kernel.cut(remaining, last);
    const lumps = faceComponentsOf(kernel, cut);
    if (!lumps || lumps.length <= 1) return [cut];
    const solids = lumps.map((faces) =>
      kernel.makeSolid(
        Uint32Array.from(faces.map((face) => kernel.copyFace(face)))
      )
    );
    const whole = kernel.volume(cut, VOLUME_DEFLECTION);
    const parts = solids.reduce(
      (sum, solid) => sum + kernel.volume(solid, VOLUME_DEFLECTION),
      0
    );
    if (
      solids.some((solid) => kernel.validateSolid(solid) !== 0) ||
      Math.abs(whole - parts) > VOLUME_TOLERANCE_RATIO * whole
    ) {
      throw new Error(
        'the regions between the bend zones could not be separated'
      );
    }
    return solids;
  }
}

/** A region's faces lying on a zone's two edge planes. */
interface ZoneContact {
  bend: number;
  side: 'lo' | 'hi';
  region: number;
  from: number;
  to: number;
}

function zoneContacts(
  kernel: RemusKernel,
  regions: readonly Region[],
  bends: readonly ResolvedBend[],
  zones: readonly Zone[],
  tolerance: number
): ZoneContact[] {
  const contacts: ZoneContact[] = [];
  regions.forEach((region, regionIndex) => {
    for (const face of kernel.getSolidFaces(region.flat)) {
      if (kernel.getSurfaceType(face) !== 'plane') continue;
      const normal = kernel.getFaceNormal(face);
      if (Math.abs(normal[2]!) > DIRECTION_TOLERANCE) continue;
      const points = vertexPositions(kernel, kernel.getFaceVertices(face));
      if (points.length === 0) continue;
      bends.forEach((bend, bendIndex) => {
        if (
          Math.abs(
            Math.abs(normal[0]! * bend.left[0] + normal[1]! * bend.left[1]) - 1
          ) > DIRECTION_TOLERANCE
        ) {
          return;
        }
        const coordinates = points.map((point) => bendCoordinates(bend, point));
        const zone = zones[bendIndex]!;
        const side = coordinates.every(
          ([, across]) => Math.abs(across - zone.lo) <= tolerance
        )
          ? 'lo'
          : coordinates.every(
                ([, across]) => Math.abs(across - zone.hi) <= tolerance
              )
            ? 'hi'
            : null;
        if (!side) return;
        contacts.push({
          bend: bendIndex,
          side,
          region: regionIndex,
          from: Math.min(...coordinates.map(([along]) => along)),
          to: Math.max(...coordinates.map(([along]) => along))
        });
      });
    }
  });
  return contacts;
}

function regionsOf(kernel: RemusKernel, solids: readonly number[]): Region[] {
  return solids.map((solid) => {
    kernel.unifyFaces(solid);
    return {
      flat: solid,
      volume: kernel.volume(solid, VOLUME_DEFLECTION),
      vertices: vertexPositions(kernel, kernel.getSolidVertices(solid))
    };
  });
}

function rootRegion(
  kernel: RemusKernel,
  regions: readonly Region[],
  fixedPoint: readonly [number, number] | undefined,
  z: number,
  tolerance: number
): number {
  if (fixedPoint) {
    const index = regions.findIndex(
      (region) =>
        kernel.classifyPoint(
          region.flat,
          fixedPoint[0],
          fixedPoint[1],
          z,
          tolerance
        ) !== 'outside'
    );
    if (index < 0) {
      refuse(
        'invalid-parameter',
        'The fixed point is not on a flat region of the sheet. Pick a point inside the region that should stay still.'
      );
    }
    return index;
  }
  let best = 0;
  regions.forEach((region, index) => {
    if (region.volume > regions[best]!.volume) best = index;
  });
  return best;
}

/** One bend-zone crossing between two regions. */
interface Crossing {
  bend: number;
  lo: number;
  hi: number;
  piece: number | null;
}

/**
 * The region tree from `root`, breadth first. A crossing that joins two
 * regions already in the tree closes a loop of bends.
 */
function buildTree(
  regions: readonly Region[],
  crossings: readonly Crossing[],
  root: number,
  bends: readonly ResolvedBend[],
  pieceKey: (crossing: Crossing) => string
): { tree: TreeNode[]; sides: Map<number, 1 | -1> } {
  const tree: TreeNode[] = [
    { region: root, key: 'fixed', pieces: [], parent: null }
  ];
  const visited = new Set([root]);
  const used = new Set<number>();
  const sides = new Map<number, 1 | -1>();
  const pieceCrossing = new Map<number, number>();
  crossings.forEach((crossing, index) => {
    if (crossing.piece !== null) pieceCrossing.set(crossing.piece, index);
  });
  for (let cursor = 0; cursor < tree.length; cursor += 1) {
    const node = tree[cursor]!;
    crossings.forEach((crossing, index) => {
      if (used.has(index)) return;
      const parentOnLo = crossing.lo === node.region;
      if (!parentOnLo && crossing.hi !== node.region) return;
      used.add(index);
      const child = parentOnLo ? crossing.hi : crossing.lo;
      const label = bends[crossing.bend]!.label;
      const joined = tree.findIndex((entry) => entry.region === child);
      if (
        joined >= 0 &&
        tree[joined]!.parent === cursor &&
        tree[joined]!.pieces.length > 0 &&
        crossing.piece !== null &&
        tree[joined]!.pieces.every(
          (piece) =>
            crossings[pieceCrossing.get(piece)!]!.bend === crossing.bend
        )
      ) {
        // The same bend line meets the same flange again past a window.
        tree[joined]!.pieces.push(crossing.piece);
        return;
      }
      if (visited.has(child)) {
        refuse(
          'bend-loop',
          `The bends form a closed loop through ${label}: a region would have to move two ways at once. Remove one bend of the loop or cut the sheet so it can open.`
        );
      }
      const side: 1 | -1 = parentOnLo ? 1 : -1;
      const previous = sides.get(crossing.bend);
      if (previous !== undefined && previous !== side) {
        refuse(
          'invalid-parameter',
          `The line of ${label} crosses the sheet in two places that fold opposite ways. Use a separate bend line for each.`
        );
      }
      sides.set(crossing.bend, side);
      visited.add(child);
      tree.push({
        region: child,
        key: pieceKey(crossing),
        pieces: crossing.piece === null ? [] : [crossing.piece],
        parent: cursor
      });
    });
  }
  if (visited.size !== regions.length) {
    refuse(
      'bend-not-separating',
      'A part of the sheet is not joined to the fixed region through a bend. Extend the bend lines across the sheet or add relief.'
    );
  }
  return { tree, sides };
}

/** Pairs each `lo` contact of a bend with the `hi` contacts opposite it. */
function crossingsOf(
  contacts: readonly ZoneContact[],
  bendCount: number,
  tolerance: number
): Crossing[] {
  const crossings: Crossing[] = [];
  for (let bend = 0; bend < bendCount; bend += 1) {
    const los = contacts.filter((c) => c.bend === bend && c.side === 'lo');
    const his = contacts.filter((c) => c.bend === bend && c.side === 'hi');
    for (const lo of los) {
      for (const hi of his) {
        if (Math.min(lo.to, hi.to) - Math.max(lo.from, hi.from) <= tolerance) {
          continue;
        }
        if (
          !crossings.some(
            (c) => c.bend === bend && c.lo === lo.region && c.hi === hi.region
          )
        ) {
          crossings.push({ bend, lo: lo.region, hi: hi.region, piece: null });
        }
      }
    }
  }
  return crossings;
}

/**
 * The fixed region among provisional, centre-line regions. These zones are
 * not the bends' own, so a fixed point may fall inside one while lying in
 * the fixed region of the real layout (a `moving-side` bend's zone starts on
 * its line, and the point may sit just before the line). Such a point takes
 * the region on its own side of that line; nothing is refused here, because
 * the build proper checks the point against the bends' actual zones.
 */
function provisionalRoot(
  kernel: RemusKernel,
  regions: readonly Region[],
  contacts: readonly ZoneContact[],
  bends: readonly ResolvedBend[],
  zones: readonly Zone[],
  fixedPoint: readonly [number, number] | undefined,
  z: number,
  tolerance: number
): number {
  const largest = () => {
    let best = 0;
    regions.forEach((region, index) => {
      if (region.volume > regions[best]!.volume) best = index;
    });
    return best;
  };
  if (!fixedPoint) return largest();
  const inside = regions.findIndex(
    (region) =>
      kernel.classifyPoint(
        region.flat,
        fixedPoint[0],
        fixedPoint[1],
        z,
        tolerance
      ) !== 'outside'
  );
  if (inside >= 0) return inside;
  for (let index = 0; index < bends.length; index += 1) {
    const bend = bends[index]!;
    const zone = zones[index]!;
    const [along, across] = bendCoordinates(bend, fixedPoint);
    if (
      along < -tolerance ||
      along > bend.length + tolerance ||
      across < zone.lo - tolerance ||
      across > zone.hi + tolerance
    ) {
      continue;
    }
    const side = across < 0 ? 'lo' : 'hi';
    const contact = contacts.find(
      (entry) =>
        entry.bend === index &&
        entry.side === side &&
        along >= entry.from - tolerance &&
        along <= entry.to + tolerance
    );
    if (contact) return contact.region;
  }
  return largest();
}

/**
 * Which side of each bend moves: found on centre-line zones without reliefs,
 * because a zone's place and its relief depend on the answer. It is a first
 * answer only: the build lays the zones out for it, reads the sides again
 * from that real layout, and retries with them if they differ.
 */
function discoverSides(
  input: PlanInput,
  blank: number,
  bends: readonly ResolvedBend[],
  z0: number,
  z1: number,
  tolerance: number
): Map<number, 1 | -1> {
  const { kernel, data } = input;
  const thickness = z1 - z0;
  const zones = bends.map((bend) => zoneOf(bend, 1, true));
  const boxes = bends.map((bend, index) =>
    prism(
      kernel,
      zoneCorners(bend, zones[index]!, thickness * ZONE_END_MARGIN_RATIO),
      z0 - thickness,
      z1 + thickness
    )
  );
  let solids: number[];
  try {
    solids = cutRegions(kernel, blank, boxes);
  } catch {
    // A zone that misses the sheet is reported by the build proper.
    return new Map();
  }
  const regions = regionsOf(kernel, solids);
  const contacts = zoneContacts(kernel, regions, bends, zones, tolerance);
  const crossings = crossingsOf(contacts, bends.length, tolerance);
  const root = provisionalRoot(
    kernel,
    regions,
    contacts,
    bends,
    zones,
    data.fixedPoint,
    (z0 + z1) / 2,
    tolerance
  );
  // Loops and stray regions are the build proper's to refuse, by name.
  const sides = new Map<number, 1 | -1>();
  const visited = new Set([root]);
  const queue = [root];
  while (queue.length > 0) {
    const region = queue.shift()!;
    for (const crossing of crossings) {
      const parentOnLo = crossing.lo === region;
      if (!parentOnLo && crossing.hi !== region) continue;
      const child = parentOnLo ? crossing.hi : crossing.lo;
      if (visited.has(child)) continue;
      visited.add(child);
      if (!sides.has(crossing.bend))
        sides.set(crossing.bend, parentOnLo ? 1 : -1);
      queue.push(child);
    }
  }
  return sides;
}

/** The moving sides a plan assumed were not the ones its tree found. */
class MovingSidesChanged extends Error {
  constructor(readonly sides: Map<number, 1 | -1>) {
    super('Sheet metal moving sides changed.');
  }
}

function planSheetMetal(input: PlanInput): SheetMetalPlan {
  try {
    return planWithSides(input, null);
  } catch (error) {
    if (!(error instanceof MovingSidesChanged)) throw error;
    try {
      return planWithSides(input, error.sides);
    } catch (second) {
      if (!(second instanceof MovingSidesChanged)) throw second;
      return refuse(
        'invalid-parameter',
        'Which side of each bend moves could not be settled from the fixed region: it lies beyond a bend zone that is placed away from its line. Move the fixed point, or place the bend on its centre line.'
      );
    }
  }
}

function planWithSides(
  input: PlanInput,
  knownSides: Map<number, 1 | -1> | null
): SheetMetalPlan {
  const { kernel, document, scope, data, sketchBases } = input;
  const resolve = (value: ParamValue, label: string) =>
    resolveParamValue(value, scope, `sheet metal ${label}`, document.units);
  const thickness = resolve(data.thickness, 'thickness');
  if (!(thickness > 0) || !Number.isFinite(thickness)) {
    refuse('invalid-parameter', 'The thickness must be greater than 0.');
  }
  const defaultRadius = resolve(data.bendRadius, 'inside bend radius');
  if (!(defaultRadius > 0) || !Number.isFinite(defaultRadius)) {
    refuse(
      'invalid-parameter',
      'The inside bend radius must be greater than 0.'
    );
  }
  const defaultK = resolve(data.kFactor, 'K-factor');
  if (!(defaultK > 0 && defaultK < 1)) {
    refuse(
      'invalid-parameter',
      'The K-factor must be greater than 0 and less than 1.'
    );
  }
  const basis = sketchBases.get(data.sketchId);
  if (!basis) {
    refuse(
      'invalid-parameter',
      "The blank's sketch plane did not resolve at this point in the history."
    );
  }
  const frame = frameOf(basis);
  const negativeSide = data.thicknessSide === 'negative';
  const z0 = negativeSide ? -thickness : 0;
  const z1 = z0 + thickness;
  const blank = buildBlank(input, frame, thickness, negativeSide);
  const box = kernel.boundingBox(blank.solid);
  const tolerance =
    LENGTH_TOLERANCE_RATIO *
    Math.max(Math.hypot(box[3]! - box[0]!, box[4]! - box[1]!, thickness), 1e-6);
  const bends = resolveBends(
    input,
    frame,
    thickness,
    defaultRadius,
    defaultK,
    tolerance
  );
  const advisories: string[] = [];
  const material =
    data.materialPresetId === undefined
      ? null
      : sheetMetalMaterialById(data.materialPresetId);

  // Which side of each bend moves, wherever a zone or relief depends on it.
  const needsSides = bends.some(
    (bend) => bend.position !== 'centerline' || bend.relief.shape !== 'none'
  );
  const guessed =
    knownSides ??
    (needsSides
      ? discoverSides(input, blank.solid, bends, z0, z1, tolerance)
      : new Map<number, 1 | -1>());
  const zones = bends.map((bend, index) =>
    zoneOf(bend, guessed.get(index) ?? 1, false)
  );

  const margin = thickness * ZONE_END_MARGIN_RATIO;
  for (let a = 0; a < bends.length; a += 1) {
    for (let b = a + 1; b < bends.length; b += 1) {
      if (
        convexOverlap(
          zoneCorners(bends[a]!, zones[a]!, 0),
          zoneCorners(bends[b]!, zones[b]!, 0),
          tolerance
        )
      ) {
        refuse(
          'bends-overlap',
          `The zones of ${bends[a]!.label} and ${bends[b]!.label} overlap in the flat. Move the lines apart, or reduce a radius or an angle.`
        );
      }
    }
  }

  const sources = [...blank.sources];
  const flat = cutReliefs(kernel, blank.solid, bends, zones, z0, z1, sources);
  const flatVolume = kernel.volume(flat, VOLUME_DEFLECTION);

  // Zone pieces: F ∩ Zᵢ must be rectangular prisms across the zone, inside
  // the line's own length. They are read from F's own edge faces rather than
  // from an intersection the exact kernel declines around windows and holes.
  const boxes: number[] = [];
  const pieces: ZonePiece[] = [];
  bends.forEach((bend, index) => {
    const zone = zones[index]!;
    boxes.push(
      prism(
        kernel,
        zoneCorners(bend, zone, margin),
        z0 - thickness,
        z1 + thickness
      )
    );
    zonePieces(kernel, flat, bend, zone, margin, z0, z1, tolerance).forEach(
      ({ from, to }, pieceIndex) =>
        pieces.push({
          bend: index,
          index: pieceIndex,
          from,
          to,
          loRegion: -1,
          hiRegion: -1
        })
    );
  });

  let regionSolids: number[];
  try {
    regionSolids = cutRegions(kernel, flat, boxes);
  } catch (error) {
    refuse(
      'fold-failed',
      `The sheet could not be divided along its bend zones (${error instanceof Error ? error.message : String(error)}).`,
      'internal'
    );
  }
  const regions = regionsOf(kernel, regionSolids);
  // F is its regions plus its zones' material, so the zones hold exactly
  // the pieces' prisms only if the volumes say so: a hole, notch or angled
  // edge anywhere in a zone shows here whatever the edge scan made of it.
  const zoneVolume = pieces.reduce(
    (sum, piece) =>
      sum +
      bends[piece.bend]!.metrics.bendAllowance *
        thickness *
        (piece.to - piece.from),
    0
  );
  const regionVolume = regions.reduce((sum, region) => sum + region.volume, 0);
  if (
    Math.abs(flatVolume - regionVolume - zoneVolume) >
    VOLUME_TOLERANCE_RATIO * flatVolume
  ) {
    refuse(
      'bend-zone-not-clear',
      'A hole, notch or angled edge lies inside a bend zone. Keep the strip along each bend line clear, or move the bend.'
    );
  }
  const contacts = zoneContacts(kernel, regions, bends, zones, tolerance);
  for (const piece of pieces) {
    const bend = bends[piece.bend]!;
    const touching = (side: 'lo' | 'hi') => [
      ...new Set(
        contacts
          .filter(
            (contact) =>
              contact.bend === piece.bend &&
              contact.side === side &&
              Math.min(contact.to, piece.to) -
                Math.max(contact.from, piece.from) >
                tolerance
          )
          .map((contact) => contact.region)
      )
    ];
    const lo = touching('lo');
    const hi = touching('hi');
    if (lo.length === 0 || hi.length === 0) {
      refuse(
        'bend-line-outside',
        `The zone of ${bend.label} reaches the edge of the sheet, so nothing lies beyond it to fold. Move the line inward or change where the bend sits on it.`
      );
    }
    if (lo.length > 1 || hi.length > 1) {
      refuse(
        'bend-not-separating',
        `More than one flat region meets one side of ${bend.label}. A cut that ends at the bend splits the sheet there; move the cut or the bend.`
      );
    }
    piece.loRegion = lo[0]!;
    piece.hiRegion = hi[0]!;
  }

  const pieceCount = bends.map(
    (_bend, index) => pieces.filter((piece) => piece.bend === index).length
  );
  const pieceName = (piece: ZonePiece) =>
    pieceCount[piece.bend]! > 1
      ? `${bends[piece.bend]!.bend.id}.${piece.index}`
      : bends[piece.bend]!.bend.id;
  const crossings: Crossing[] = pieces.map((piece, index) => ({
    bend: piece.bend,
    lo: piece.loRegion,
    hi: piece.hiRegion,
    piece: index
  }));
  const root = rootRegion(
    kernel,
    regions,
    data.fixedPoint,
    (z0 + z1) / 2,
    tolerance
  );
  const { tree, sides } = buildTree(
    regions,
    crossings,
    root,
    bends,
    (crossing) => pieceName(pieces[crossing.piece!]!)
  );
  if (
    needsSides &&
    bends.some((_bend, index) => sides.get(index) !== zones[index]!.side)
  ) {
    throw new MovingSidesChanged(sides);
  }
  // A centre-line zone without relief lies the same whichever side moves.
  sides.forEach((side, index) => {
    zones[index]!.side = side;
  });

  // Advisories: nominal shop rules of thumb, never refusals.
  bends.forEach((bend, index) => {
    const zone = zones[index]!;
    const { insideRadius, outsideSetback } = bend.metrics;
    if (material && insideRadius < material.minInsideRadiusOverT * thickness) {
      advisories.push(
        `The inside radius of ${bend.label} (${formatted(insideRadius)}) is below the nominal minimum for ${material.label} (${formatted(material.minInsideRadiusOverT * thickness)}); it may crack. A rule of thumb, not a material certification.`
      );
    }
    if (
      bend.relief.shape !== 'none' &&
      bend.relief.width < minimumReliefWidth(thickness)
    ) {
      advisories.push(
        `The relief of ${bend.label} (${formatted(bend.relief.width)} wide) is narrower than the thickness; it may tear instead of clearing the bend.`
      );
    }
    const setback = Math.min(outsideSetback, insideRadius + thickness);
    const shortest = minimumFlangeLength(thickness);
    const holeClearance = minimumHoleToBendDistance(thickness);
    let shortFlange = false;
    let nearHole = false;
    for (const piece of pieces.filter((entry) => entry.bend === index)) {
      for (const [regionIndex, sign, edge] of [
        [piece.loRegion, -1, zone.lo],
        [piece.hiRegion, 1, zone.hi]
      ] as const) {
        const region = regions[regionIndex]!;
        const reach = Math.max(
          ...region.vertices.map(
            (point) => sign * (bendCoordinates(bend, point)[1] - edge)
          )
        );
        if (reach + setback < shortest - tolerance) shortFlange = true;
        for (const face of kernel.getSolidFaces(region.flat)) {
          if (kernel.getSurfaceType(face) !== 'cylinder') continue;
          const params = analyticParams(kernel, face);
          const origin = vector3(params?.origin);
          if (!origin || typeof params?.radius !== 'number') continue;
          const radius = params.radius;
          // A relief's own rounded end stands beside its bend by design.
          const reliefEnd = sources.some(
            ({ token, carrier }) =>
              token.startsWith(`relief[${bend.bend.id}].`) &&
              carrier.kind === 'cylinder' &&
              Math.abs(carrier.radius - radius) <= tolerance &&
              Math.hypot(
                carrier.center[0] - origin[0],
                carrier.center[1] - origin[1]
              ) <= tolerance
          );
          if (reliefEnd) continue;
          const [along, across] = bendCoordinates(bend, origin);
          const gap =
            Math.hypot(
              Math.max(piece.from - along, 0, along - piece.to),
              Math.max(zone.lo - across, 0, across - zone.hi)
            ) - params.radius;
          if (gap < holeClearance - tolerance) nearHole = true;
        }
      }
    }
    if (shortFlange) {
      advisories.push(
        `A flange at ${bend.label} is shorter than a press brake usually holds (about ${formatted(shortest)} from the outside of the bend, for an 8 × thickness die opening).`
      );
    }
    if (nearHole) {
      advisories.push(
        `A hole or rounded cut-out is closer than ${formatted(holeClearance)} (2 × thickness) to the zone of ${bend.label}; it may distort when the bend is made.`
      );
    }
  });

  return {
    kernel,
    frame,
    thickness,
    z0,
    z1,
    tolerance,
    flat,
    flatVolume,
    sources,
    bends,
    zones,
    pieces,
    regions,
    tree,
    advisories
  };
}

/** Six significant digits, without exponent noise for ordinary sizes. */
function formatted(value: number): string {
  return String(Number(value.toPrecision(6)));
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

interface FoldedPart {
  solid: number;
  volume: number;
  /** A region's tree index, or the zone piece between a node and its parent. */
  kind: 'region' | 'bend';
  node: number;
  label: string;
}

interface FoldedBend {
  piece: number;
  /** A point on the bend axis and its unit direction, folded. */
  axisPoint: V3;
  axisDirection: V3;
  insideRadius: number;
  /** The zone's moving side: the flat axis is `side` times the line. */
  side: 1 | -1;
}

interface FoldResult {
  /** The folded body in the sketch frame. */
  solid: number;
  /** Each tree node's rigid motion from the flat. */
  transforms: SheetMetalAffine[];
  bends: FoldedBend[];
}

/**
 * Folds the plan at `fraction` of every bend's angle (1 is the stored part;
 * a smaller fraction is the view-only fold preview, which keeps each zone's
 * flat width and so opens its radius).
 */
function foldSheetMetal(
  plan: SheetMetalPlan,
  fraction: number,
  checkOverlap: boolean
): FoldResult {
  const { kernel, tree, pieces, bends, zones, regions, z0, z1 } = plan;
  const transforms: SheetMetalAffine[] = [SHEET_METAL_IDENTITY];
  const parts: FoldedPart[] = [];
  const folded: FoldedBend[] = [];
  let expected = 0;
  tree.forEach((node, index) => {
    for (const pieceIndex of node.parent === null ? [] : node.pieces) {
      const piece = pieces[pieceIndex]!;
      const bend = bends[piece.bend]!;
      const zone = zones[piece.bend]!;
      const parent = transforms[node.parent!]!;
      const fold = sheetMetalFold({
        linePoint: [bend.p0[0], bend.p0[1], 0],
        movingNormal: [zone.side * bend.left[0], zone.side * bend.left[1], 0],
        zoneStart: zone.start,
        metrics: bend.metrics,
        direction: bend.bend.direction,
        plateBottom: z0,
        fraction
      });
      // The zone piece's face on its parent side, turned about the axis.
      const edge = zone.side * zone.start;
      const a = bendPoint(bend, piece.from, edge);
      const b = bendPoint(bend, piece.to, edge);
      const face = kernel.makePolygon(
        new Float64Array([
          a[0],
          a[1],
          z0,
          b[0],
          b[1],
          z0,
          b[0],
          b[1],
          z1,
          a[0],
          a[1],
          z1
        ])
      );
      const sign = fold.signedAngle >= 0 ? 1 : -1;
      let bent: number;
      try {
        bent = kernel.revolve(
          face,
          fold.axisPoint[0],
          fold.axisPoint[1],
          fold.axisPoint[2],
          fold.axisDirection[0] * sign,
          fold.axisDirection[1] * sign,
          fold.axisDirection[2] * sign,
          Math.abs(fold.signedAngle) / DEG
        );
      } catch (error) {
        refuse(
          'fold-failed',
          `The zone of ${bend.label} could not be bent (${error instanceof Error ? error.message : String(error)}).`,
          'internal'
        );
      }
      kernel.unifyFaces(bent);
      kernel.transformSolid(bent, affineMatrix([...parent]));
      const volume = bentZoneVolume(
        Math.abs(fold.signedAngle),
        fold.effectiveInsideRadius,
        plan.thickness,
        piece.to - piece.from
      );
      expected += volume;
      parts.push({
        solid: bent,
        volume,
        kind: 'bend',
        node: index,
        label: bend.label
      });
      folded.push({
        piece: pieceIndex,
        axisPoint: applyAffine(parent, fold.axisPoint),
        axisDirection: rotate(parent, fold.axisDirection),
        insideRadius: fold.effectiveInsideRadius,
        side: zone.side
      });
      transforms[index] = composeAffine(parent, fold.movingTransform);
    }
    const region = regions[node.region]!;
    const moved = kernel.copySolid(region.flat);
    if (index > 0) {
      kernel.transformSolid(moved, affineMatrix([...transforms[index]!]));
    }
    expected += region.volume;
    parts.push({
      solid: moved,
      volume: region.volume,
      kind: 'region',
      node: index,
      label:
        node.pieces.length === 0
          ? 'the fixed region'
          : `the flange of ${bends[pieces[node.pieces[0]!]!.bend]!.label}`
    });
  });

  if (checkOverlap) refuseFoldedOverlap(plan, parts);

  // Pairwise in tree order: every operand meets the body built so far on one
  // face. `fuseAll` leaves some of these contacts unmerged on the pin.
  let solid = parts[0]!.solid;
  try {
    for (const part of parts.slice(1)) solid = kernel.fuse(solid, part.solid);
    kernel.unifyFaces(solid);
  } catch (error) {
    refuse(
      'fold-failed',
      `The folded pieces could not be joined (${error instanceof Error ? error.message : String(error)}).`,
      'internal'
    );
  }
  const volume = kernel.volume(solid, VOLUME_DEFLECTION);
  const components = faceComponentsOf(kernel, solid);
  if (
    kernel.validateSolid(solid) !== 0 ||
    (components !== null && components.length !== 1) ||
    Math.abs(volume - expected) > VOLUME_TOLERANCE_RATIO * expected
  ) {
    refuse(
      'fold-failed',
      Math.abs(volume - expected) > VOLUME_TOLERANCE_RATIO * expected
        ? `The folded part's volume (${formatted(volume)}) is not the sum of its flanges and bends (${formatted(expected)}); folded material overlaps or a join failed.`
        : 'The folded pieces did not join into one valid solid.',
      'internal'
    );
  }
  return { solid, transforms, bends: folded };
}

/** The volume two solids share; 0 where the kernel finds none. */
function sharedVolume(kernel: RemusKernel, a: number, b: number): number {
  try {
    return kernel.volume(kernel.intersect(a, b), VOLUME_DEFLECTION);
  } catch {
    // No common material: the kernel refuses an empty intersection.
    return 0;
  }
}

/**
 * Refuses a fold whose pieces pass through each other. Neighbours in the
 * region tree (a bend and the two regions it joins) meet on a face and are
 * not compared; any other pair that shares material is a collision, and
 * their union would silently lose it.
 */
function refuseFoldedOverlap(
  plan: SheetMetalPlan,
  parts: readonly FoldedPart[]
): void {
  const { kernel, tree, tolerance } = plan;
  const boxes = parts.map((part) => kernel.boundingBox(part.solid));
  const neighbours = (a: FoldedPart, b: FoldedPart): boolean => {
    if (a.kind === b.kind) return false;
    const bend = a.kind === 'bend' ? a : b;
    const region = a.kind === 'bend' ? b : a;
    return region.node === bend.node || region.node === tree[bend.node]!.parent;
  };
  for (let a = 0; a < parts.length; a += 1) {
    for (let b = a + 1; b < parts.length; b += 1) {
      const left = parts[a]!;
      const right = parts[b]!;
      if (neighbours(left, right)) continue;
      if (!boxesOverlap(boxes[a]!, boxes[b]!, tolerance)) continue;
      const shared = sharedVolume(kernel, left.solid, right.solid);
      if (
        shared >
        VOLUME_TOLERANCE_RATIO * Math.min(left.volume, right.volume)
      ) {
        const name = (part: FoldedPart) =>
          part.kind === 'bend' ? `the zone of ${part.label}` : part.label;
        refuse(
          'folded-overlap',
          `Folded, ${name(left)} passes through ${name(right)}. Shorten a flange, reduce an angle or reverse a bend's direction.`
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * A role name for every face of the folded body (sketch frame), keyed by
 * face handle. A face is named from what it lies on, never from its place
 * in the kernel's output:
 *
 * - `sheet.face.top[<region>]` / `sheet.face.bottom[<region>]`: a region's
 *   faces on the blank's `+normal` and `−normal` sides;
 * - `sheet.bend[<bend>].inner` / `.outer`: a bend's two cylinders;
 * - `sheet.face.edge[<region>].<source>`: a thickness face, from the sketch
 *   curve or relief wall it lies on and the region nearest the fixed one
 *   that it touches (a face that runs on through a bend is one face);
 * - `sheet.bend[<bend>].side.start` / `.side.end`: a bend's end faces that
 *   no region's edge continues.
 *
 * `<region>` is `fixed` or the bend that carries the region; a bend whose
 * line crosses the sheet more than once counts its pieces along the line
 * (`<bendId>.<n>`). A name two faces would share is given to neither.
 */
function sheetFaceNames(
  plan: SheetMetalPlan,
  fold: FoldResult
): Map<number, string> {
  const { kernel, tree, regions, pieces, bends, sources, z0, z1, tolerance } =
    plan;
  const middle = (z0 + z1) / 2;
  const inverses = fold.transforms.map(invertRigid);
  const pieceCount = bends.map(
    (_bend, index) => pieces.filter((piece) => piece.bend === index).length
  );
  const bendName = (piece: ZonePiece) =>
    pieceCount[piece.bend]! > 1
      ? `${bends[piece.bend]!.bend.id}.${piece.index}`
      : bends[piece.bend]!.bend.id;
  const touches = (node: number, point: V3): V3 | null => {
    const flat = applyAffine(inverses[node]!, point);
    if (flat[2] < z0 - tolerance || flat[2] > z1 + tolerance) return null;
    return kernel.classifyPoint(
      regions[tree[node]!.region]!.flat,
      flat[0],
      flat[1],
      middle,
      tolerance
    ) === 'outside'
      ? null
      : flat;
  };
  const proposals = new Map<number, string>();
  for (const face of kernel.getSolidFaces(fold.solid)) {
    const type = kernel.getSurfaceType(face);
    const points = vertexPositions(kernel, kernel.getFaceVertices(face));
    if (points.length === 0) continue;
    const params = analyticParams(kernel, face);
    let name: string | null = null;

    if (type === 'cylinder' && params) {
      const origin = vector3(params.origin);
      const axis = vector3(params.axis);
      const radius = typeof params.radius === 'number' ? params.radius : NaN;
      if (origin && axis) {
        for (const bend of fold.bends) {
          const offset = sub3(origin, bend.axisPoint);
          if (
            norm3(cross3(axis, bend.axisDirection)) > DIRECTION_TOLERANCE ||
            norm3(cross3(offset, bend.axisDirection)) > tolerance
          ) {
            continue;
          }
          const role =
            Math.abs(radius - bend.insideRadius) <= tolerance
              ? 'inner'
              : Math.abs(radius - bend.insideRadius - plan.thickness) <=
                  tolerance
                ? 'outer'
                : null;
          // Pieces of one bend share its axis: each owns its own stretch.
          const piece = pieces[bend.piece]!;
          const within = points.every((point) => {
            const along =
              bend.side * dot3(sub3(point, bend.axisPoint), bend.axisDirection);
            return (
              along >= piece.from - tolerance && along <= piece.to + tolerance
            );
          });
          if (role && within) {
            name = `sheet.bend[${bendName(pieces[bend.piece]!)}].${role}`;
            break;
          }
        }
      }
    }

    const normal =
      type === 'plane'
        ? (() => {
            const n = kernel.getFaceNormal(face);
            return [n[0]!, n[1]!, n[2]!] as V3;
          })()
        : null;

    if (!name) {
      for (let node = 0; node < tree.length && !name; node += 1) {
        const touching = points
          .map((point) => touches(node, point))
          .filter((point): point is V3 => point !== null);
        const flatPoint = touching[0];
        if (!flatPoint) continue;
        const key = tree[node]!.key;
        const inverse = inverses[node]!;
        if (normal) {
          const flatNormal = rotate(inverse, normal);
          if (Math.abs(Math.abs(flatNormal[2]) - 1) <= DIRECTION_TOLERANCE) {
            // A plate face of this region, if it is on one of its two sides.
            const height = applyAffine(inverse, points[0]!)[2];
            if (Math.abs(height - z1) <= tolerance) {
              name = `sheet.face.top[${key}]`;
            } else if (Math.abs(height - z0) <= tolerance) {
              name = `sheet.face.bottom[${key}]`;
            }
            continue;
          }
          if (Math.abs(flatNormal[2]) > DIRECTION_TOLERANCE) continue;
          const offset =
            flatNormal[0] * flatPoint[0] + flatNormal[1] * flatPoint[1];
          const source = sources.find(
            ({ carrier }) =>
              carrier.kind === 'plane' &&
              Math.abs(
                carrier.normal[0] * flatNormal[1] -
                  carrier.normal[1] * flatNormal[0]
              ) <= DIRECTION_TOLERANCE &&
              Math.abs(
                carrier.offset *
                  Math.sign(
                    carrier.normal[0] * flatNormal[0] +
                      carrier.normal[1] * flatNormal[1]
                  ) -
                  offset
              ) <= tolerance &&
              touching.some((point) =>
                onSegment(point, carrier.segment, tolerance)
              )
          );
          if (source) name = `sheet.face.edge[${key}].${source.token}`;
        } else if (type === 'cylinder' && params) {
          const origin = vector3(params.origin);
          const axis = vector3(params.axis);
          if (!origin || !axis || typeof params.radius !== 'number') continue;
          const flatAxis = rotate(inverse, axis);
          if (Math.abs(Math.abs(flatAxis[2]) - 1) > DIRECTION_TOLERANCE) {
            continue;
          }
          const center = applyAffine(inverse, origin);
          const radius = params.radius;
          const source = sources.find(
            ({ carrier }) =>
              carrier.kind === 'cylinder' &&
              Math.abs(carrier.radius - radius) <= tolerance &&
              Math.hypot(
                carrier.center[0] - center[0],
                carrier.center[1] - center[1]
              ) <= tolerance
          );
          if (source) name = `sheet.face.edge[${key}].${source.token}`;
        }
      }
    }

    if (!name && normal) {
      // A bend's own end face, where no region's edge runs on through it.
      for (const bend of fold.bends) {
        if (
          Math.abs(Math.abs(dot3(normal, bend.axisDirection)) - 1) >
          DIRECTION_TOLERANCE
        ) {
          continue;
        }
        const piece = pieces[bend.piece]!;
        // The folded axis runs along the line (reversed when the moving side
        // is to its right) from the line's first end, so a point's place
        // along the axis is its place along the line.
        const alongLine =
          bend.side *
          dot3(sub3(points[0]!, bend.axisPoint), bend.axisDirection);
        const role =
          Math.abs(alongLine - piece.from) <= tolerance
            ? 'start'
            : Math.abs(alongLine - piece.to) <= tolerance
              ? 'end'
              : null;
        if (role && points.every((point) => nearBend(point, bend, plan))) {
          name = `sheet.bend[${bendName(piece)}].side.${role}`;
          break;
        }
      }
    }
    if (name) proposals.set(face, name);
  }
  const uses = new Map<string, number>();
  for (const name of proposals.values()) {
    uses.set(name, (uses.get(name) ?? 0) + 1);
  }
  return new Map([...proposals].filter(([, name]) => uses.get(name) === 1));
}

/** Whether a point lies within a bend's swept annulus (inside its outer radius). */
function nearBend(point: V3, bend: FoldedBend, plan: SheetMetalPlan): boolean {
  const offset = sub3(point, bend.axisPoint);
  const radial = norm3(cross3(offset, bend.axisDirection));
  return (
    radial >= bend.insideRadius - plan.tolerance &&
    radial <= bend.insideRadius + plan.thickness + plan.tolerance
  );
}

function sheetLineage(
  kernel: RemusKernel,
  solid: number,
  featureId: FeatureId,
  names: ReadonlyMap<number, string>
): RemusLineageState {
  const assignments: RemusSemanticAssignment[] = [];
  for (const candidate of topologyCandidatesForSolid(kernel, solid)) {
    if (candidate.kind !== 'face') continue;
    const name = names.get(candidate.handle);
    if (name) assignments.push({ ...candidate, lineageName: name });
  }
  return withFacePairEdgeLineage(
    kernel,
    solid,
    featureId,
    createRemusSemanticLineage(featureId, 'primitive', assignments),
    null,
    'sheet'
  );
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Later features that cut or add to a body, following it through each one's
 * result. Moves and mirrored copies change no material and are left out.
 *
 * Read by the flat-pattern API, not by the build: a feature's build must not
 * depend on the features after it (the history cache restores it without
 * looking at them), so the "not in the flat pattern" advisory is carried by
 * {@link SheetMetalFlatPattern.changedBy} instead of a build warning.
 */
export function featuresChangingBodyAfter(
  document: ProjectDocument,
  feature: FeatureNode
): FeatureNode[] {
  if (!feature.bodyId) return [];
  const tracked = new Set<BodyId>([feature.bodyId]);
  const changed: FeatureNode[] = [];
  let reached = false;
  for (const later of listFeaturesInOrder(document)) {
    if (later.featureId === feature.featureId) {
      reached = true;
      continue;
    }
    if (
      !reached ||
      isFeatureManuallySuppressed(later) ||
      isFeatureRollbackSuppressed(later)
    ) {
      continue;
    }
    const data = later.data as unknown as Record<string, unknown>;
    const list = (value: unknown): unknown[] =>
      Array.isArray(value) ? (value as unknown[]) : [];
    const used = [
      data.targetBodyId,
      ...list(data.targetBodyIds),
      ...list(data.toolBodyIds)
    ].some((id) => typeof id === 'string' && tracked.has(id as BodyId));
    if (!used) continue;
    if (later.bodyId) tracked.add(later.bodyId);
    if (later.featureKind !== 'transform' && later.featureKind !== 'mirror') {
      changed.push(later);
    }
  }
  return changed;
}

export function buildSheetMetalFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'sheet-metal'>
): void {
  if (!feature.bodyId) {
    throw new Error('Sheet metal has no result body.');
  }
  const { kernel, document, scope, result } = ctx;
  const plan = planSheetMetal({
    kernel,
    document,
    scope,
    sketchBases: result.sketchBases,
    feature,
    data
  });
  const fold = foldSheetMetal(plan, 1, true);
  const names = sheetFaceNames(plan, fold);
  kernel.transformSolid(fold.solid, affineMatrix([...plan.frame.toWorld]));
  for (const advisory of plan.advisories) {
    raiseFeatureWarning(result, feature, advisory, 'advisory');
  }
  result.shapes.set(feature.bodyId, {
    solids: [fold.solid],
    lineage: sheetLineage(kernel, fold.solid, feature.featureId, names)
  });
}

/** One bend centre line of the flat pattern, across one zone piece. */
export interface SheetMetalFlatPatternBend {
  bendId: string;
  /** This piece's index among the bend's zone pieces, along its line. */
  piece: number;
  /** The bend's centre line across the piece, sketch-local 2D. */
  segment: [[number, number], [number, number]];
  direction: 'up' | 'down';
  angleDeg: number;
  insideRadius: number;
  kFactor: number;
  bendAllowance: number;
  /** Null at 180°, where there is no finite setback. */
  bendDeduction: number | null;
  /** Length of `segment`. */
  lineLength: number;
}

/**
 * The flat pattern of a sheet-metal feature (spec "Outputs"): the flat sheet
 * `F`'s outline and the bend centre lines, in the blank's sketch coordinates
 * and document units.
 */
export interface SheetMetalFlatPattern {
  featureId: FeatureId;
  thickness: number;
  /**
   * The blank's sketch frame in the world: a 2D point `(x, y)` here is
   * `origin + x·u + y·v`.
   */
  frame: {
    origin: [number, number, number];
    u: [number, number, number];
    v: [number, number, number];
    normal: [number, number, number];
  };
  /**
   * The closed loops of the flat sheet's outline, as the lines, arcs,
   * circles and polylines the face-outline DXF export writes. The outer
   * boundary comes first; the rest are holes and cut-outs.
   */
  loops: { outer: boolean; entities: DxfEntity[] }[];
  bends: SheetMetalFlatPatternBend[];
  /**
   * Later features that cut or added to the folded body. Their material is
   * not in this pattern.
   */
  changedBy: { featureId: FeatureId; name: string }[];
}

function requireSheetMetal(
  document: ProjectDocument,
  featureId: FeatureId
): { feature: FeatureNode; data: FeatureDataOf<'sheet-metal'> } {
  const feature = listFeaturesInOrder(document).find(
    (entry) => entry.featureId === featureId
  );
  if (!feature || feature.data.featureKind !== 'sheet-metal') {
    throw new Error(`Feature ${featureId} is not a sheet-metal feature.`);
  }
  return { feature, data: feature.data };
}

/**
 * What the flat-pattern and fold-preview entry points read from a finished
 * build, so they rebuild from the same sketches the feature was built from.
 */
export type SheetMetalBuildState = Pick<
  ExactBuildResult,
  'sketchBases' | 'sketchProjectionFailures'
>;

/**
 * The plan input for a rebuild outside the build loop. `document` must be
 * the document as the build read it (linked sketch projections re-projected,
 * `withSketchObjectOverrides`), and a blank or bend-line sketch whose linked
 * projections failed to solve refuses here as it does in the build.
 */
function rebuildInput(
  kernel: RemusKernel,
  document: ProjectDocument,
  scope: Record<string, number>,
  build: SheetMetalBuildState,
  featureId: FeatureId
): PlanInput {
  const { feature, data } = requireSheetMetal(document, featureId);
  assertFeatureSketchProjectionsValid(build, data);
  return {
    kernel,
    document,
    scope,
    sketchBases: build.sketchBases,
    feature,
    data
  };
}

/**
 * `document` is the document as the build read it; see {@link rebuildInput}.
 */
export function sheetMetalFlatPattern(
  kernel: RemusKernel,
  document: ProjectDocument,
  scope: Record<string, number>,
  build: SheetMetalBuildState,
  featureId: FeatureId,
  modelUnitMm: number
): SheetMetalFlatPattern {
  const input = rebuildInput(kernel, document, scope, build, featureId);
  const { feature } = input;
  const plan = planSheetMetal(input);
  const top = Array.from(kernel.getSolidFaces(plan.flat)).find((face) => {
    if (kernel.getSurfaceType(face) !== 'plane') return false;
    const normal = kernel.getFaceNormal(face);
    if (Math.abs(Math.abs(normal[2]!) - 1) > DIRECTION_TOLERANCE) return false;
    const [point] = vertexPositions(kernel, kernel.getFaceVertices(face));
    return (
      point !== undefined && Math.abs(point[2] - plan.z1) <= plan.tolerance
    );
  });
  if (top === undefined) {
    throw new Error('The flat sheet has no top face to outline.');
  }
  const dxfFrame = {
    origin: [0, 0, 0] as const,
    u: [1, 0, 0] as const,
    v: [0, 1, 0] as const,
    scale: 1,
    sampleDeflection: dxfSampleDeflection(modelUnitMm)
  };
  const outer = kernel.getFaceOuterWire(top);
  const wires = Array.from(kernel.getFaceWires(top));
  const loops = [outer, ...wires.filter((wire) => wire !== outer)].map(
    (wire) => ({
      outer: wire === outer,
      entities: Array.from(kernel.getWireEdges(wire)).flatMap((edge) =>
        edgeDxfEntities(kernel, edge, dxfFrame)
      )
    })
  );
  const { basis } = plan.frame;
  const triple = (v: { x: number; y: number; z: number }) =>
    [v.x, v.y, v.z] as [number, number, number];
  return {
    featureId,
    thickness: plan.thickness,
    frame: {
      origin: triple(basis.origin),
      u: triple(basis.u),
      v: triple(basis.v),
      normal: triple(basis.normal)
    },
    loops,
    bends: plan.pieces.map((piece) => {
      const bend = plan.bends[piece.bend]!;
      const zone = plan.zones[piece.bend]!;
      const centre = (zone.lo + zone.hi) / 2;
      const a = bendPoint(bend, piece.from, centre);
      const b = bendPoint(bend, piece.to, centre);
      return {
        bendId: bend.bend.id,
        piece: piece.index,
        segment: [
          [a[0], a[1]],
          [b[0], b[1]]
        ],
        direction: bend.bend.direction,
        angleDeg: bend.metrics.angle / DEG,
        insideRadius: bend.metrics.insideRadius,
        kFactor: bend.metrics.kFactor,
        bendAllowance: bend.metrics.bendAllowance,
        bendDeduction: Number.isFinite(bend.metrics.bendDeduction)
          ? bend.metrics.bendDeduction
          : null,
        lineLength: piece.to - piece.from
      };
    }),
    changedBy: featuresChangingBodyAfter(document, feature).map((entry) => ({
      featureId: entry.featureId,
      name: entry.name
    }))
  };
}

/** A view-only fold of a sheet-metal feature, never stored in the document. */
export interface SheetMetalFoldPreview {
  featureId: FeatureId;
  /** The fold fraction built, in [0, 1]; 0 is the flat sheet. */
  fraction: number;
  /** World-space triangle mesh of the body at that fraction. */
  positions: Float64Array;
  normals: Float64Array;
  indices: Uint32Array;
  volume: number;
  /** `[minX, minY, minZ, maxX, maxY, maxZ]`. */
  boundingBox: [number, number, number, number, number, number];
}

/**
 * The feature's body at fold fraction `fraction` (spec "Fold kinematics",
 * fold preview): each zone keeps its flat width and turns by
 * `fraction·θ`; 0 returns the flat sheet. The solid is in the world frame
 * and belongs to the caller's kernel checkpoint.
 */
export function foldSheetMetalAt(
  kernel: RemusKernel,
  document: ProjectDocument,
  scope: Record<string, number>,
  build: SheetMetalBuildState,
  featureId: FeatureId,
  fraction: number
): number {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new RangeError('Fold fraction must be between 0 and 1.');
  }
  const plan = planSheetMetal(
    rebuildInput(kernel, document, scope, build, featureId)
  );
  const solid =
    fraction === 0 || plan.pieces.length === 0
      ? kernel.copySolid(plan.flat)
      : foldSheetMetal(plan, fraction, false).solid;
  kernel.transformSolid(solid, affineMatrix([...plan.frame.toWorld]));
  return solid;
}
