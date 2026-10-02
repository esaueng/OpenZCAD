/**
 * Whole-sketch → 2D DXF entities (D04).
 *
 * This is the pure extraction half of `exportSketchDxf`: it lowers one saved
 * sketch's own 2D objects to the exact analytic DXF subset the writer already
 * speaks — LINE, CIRCLE, ARC — in sketch-local (u, v) coordinates scaled once
 * to millimetres. It never solves, mutates, projects world points, or touches
 * document nodes; the adapter owns history, parameter scope, and plane
 * resolution, and `@openzcad/io-dxf` owns serialization.
 *
 * Fail-closed throughout: the extractor either returns the complete supported
 * sketch or a named refusal. It never drops an authored object and keeps
 * going, so a laser cutter can never receive a drawing with a silent hole in
 * it. Rectangles and regular polygons lower through the same shared helpers
 * the profile builders use (`rectangleProfile`, `polygonProfile`), so their
 * edges are the authored segments, not approximations.
 */

import { resolveParamValue } from '@openzcad/document-core';
import {
  polygonProfile,
  rectangleProfile,
  type PlaneBasis,
  type Vec2
} from '@openzcad/geometry';
import type { DxfEntity } from '@openzcad/io-dxf';
import {
  MAX_SKETCH_ARC_SWEEP_DEGREES,
  type ParamValue,
  type SketchObjectData
} from '@openzcad/shared';

/**
 * Why a whole-sketch DXF export was refused. Each reason names a case where
 * emitting a file would misrepresent the sketch, matching the contract table
 * in `docs/plans/sketch-dxf-export-plan.md`.
 */
export type SketchDxfRefusalReason =
  /** The requested sketch ID is absent. */
  | 'sketch-not-found'
  /** Parameter scope has evaluation errors, or an expression won't resolve. */
  | 'parameters-invalid'
  /** Face lineage cannot resolve exactly at the sketch history position. */
  | 'stale-plane-attachment'
  /** Basis axes are non-finite, degenerate, non-orthonormal, or left-handed. */
  | 'invalid-plane-frame'
  /** A non-construction object is text or a future/unknown kind. */
  | 'unsupported-object'
  /** Non-finite values, non-positive dimensions, degenerate or invalid sweeps. */
  | 'invalid-geometry'
  /** No manufacturing entities remain after construction exclusion. */
  | 'construction-only'
  /** The format writer rejects a value or cannot assemble the document. */
  | 'writer-refused';

export interface SketchDxfRefusal {
  readonly status: 'refused';
  readonly reason: SketchDxfRefusalReason;
  readonly message: string;
}

export interface SketchDxfSuccess {
  readonly status: 'ok';
  /** Entities in sketch `objectIds` order; composite edges in helper order. */
  readonly entities: DxfEntity[];
  /** How many `construction: true` objects were intentionally excluded. */
  readonly excludedConstructionCount: number;
  /**
   * Human-readable notes that do not change the bytes: full-turn arcs lowered
   * to circles, and the construction count. Recorded here rather than logged
   * so a caller can surface them wherever its diagnostics live.
   */
  readonly diagnostics: string[];
}

export type SketchDxfOutcome = SketchDxfSuccess | SketchDxfRefusal;

/** One sketch object in `objectIds` order; `data` is absent for a dangling id. */
export interface SketchDxfInputObject {
  readonly id: string;
  readonly data: SketchObjectData | undefined;
}

export interface SketchDxfInput {
  readonly objects: readonly SketchDxfInputObject[];
  readonly scope: Readonly<Record<string, number>>;
  readonly basis: PlaneBasis;
  readonly millimeterScale: number;
}

/**
 * The existing error/refusal path is a thrown `Error` whose message the
 * worker forwards verbatim, so the machine-readable reason travels in the
 * message head (`reason: detail`) and on `.reason` for direct callers.
 */
export class SketchDxfExportError extends Error {
  readonly reason: SketchDxfRefusalReason;
  constructor(reason: SketchDxfRefusalReason, message: string) {
    super(`${reason}: ${message}`);
    this.name = 'SketchDxfExportError';
    this.reason = reason;
  }
}

/** Thrown out of the resolver and caught once at the module edge. */
class RefusalSignal extends Error {
  constructor(
    readonly reason: SketchDxfRefusalReason,
    message: string
  ) {
    super(message);
    this.name = 'RefusalSignal';
  }
}

const refuse = (reason: SketchDxfRefusalReason, message: string): never => {
  throw new RefusalSignal(reason, message);
};

/** Tight frame check: a measured basis is either right or it refuses. */
const FRAME_TOLERANCE = 1e-9;

function finiteComponent(value: number): boolean {
  return Number.isFinite(value);
}

/**
 * Validate the sketch basis before any entity is emitted: finite,
 * non-degenerate, orthonormal axes with `u × v = normal`. Canonical bases are
 * constructed right-handed; only a corrupt persisted frame can fail this, and
 * no broad tolerance is introduced to make one pass.
 */
export function validateSketchDxfBasis(
  basis: PlaneBasis
): SketchDxfRefusal | null {
  const axes = [basis.u, basis.v, basis.normal];
  for (const [index, axis] of axes.entries()) {
    if (
      !finiteComponent(axis.x) ||
      !finiteComponent(axis.y) ||
      !finiteComponent(axis.z)
    ) {
      return {
        status: 'refused',
        reason: 'invalid-plane-frame',
        message: `Sketch plane axis ${index} is not finite; the sketch cannot be placed exactly.`
      };
    }
    const length = Math.hypot(axis.x, axis.y, axis.z);
    if (Math.abs(length - 1) > FRAME_TOLERANCE) {
      return {
        status: 'refused',
        reason: 'invalid-plane-frame',
        message: `Sketch plane axis ${index} has length ${length}; plane axes must be unit vectors.`
      };
    }
  }
  const dot = (
    a: { x: number; y: number; z: number },
    b: { x: number; y: number; z: number }
  ): number => a.x * b.x + a.y * b.y + a.z * b.z;
  const pairs: Array<[typeof basis.u, typeof basis.u, string]> = [
    [basis.u, basis.v, 'u/v'],
    [basis.u, basis.normal, 'u/normal'],
    [basis.v, basis.normal, 'v/normal']
  ];
  for (const [a, b, label] of pairs) {
    if (Math.abs(dot(a, b)) > FRAME_TOLERANCE) {
      return {
        status: 'refused',
        reason: 'invalid-plane-frame',
        message: `Sketch plane axes ${label} are not perpendicular; the frame is not orthonormal.`
      };
    }
  }
  const cross = {
    x: basis.u.y * basis.v.z - basis.u.z * basis.v.y,
    y: basis.u.z * basis.v.x - basis.u.x * basis.v.z,
    z: basis.u.x * basis.v.y - basis.u.y * basis.v.x
  };
  if (
    Math.abs(cross.x - basis.normal.x) > FRAME_TOLERANCE ||
    Math.abs(cross.y - basis.normal.y) > FRAME_TOLERANCE ||
    Math.abs(cross.z - basis.normal.z) > FRAME_TOLERANCE
  ) {
    return {
      status: 'refused',
      reason: 'invalid-plane-frame',
      message:
        'Sketch plane axes are not right-handed (u × v must equal the normal); the frame would mirror the sketch.'
    };
  }
  return null;
}

/** Resolve one parametric scalar; an unresolvable expression refuses the file. */
function resolveScalar(
  value: ParamValue,
  scope: Readonly<Record<string, number>>,
  label: string,
  objectId: string
): number {
  let resolved: number;
  // A non-finite literal is malformed geometry, not an unresolvable
  // expression; only expression evaluation failures are parameter errors.
  if (typeof value === 'number' && !Number.isFinite(value)) {
    refuse(
      'invalid-geometry',
      `Sketch object ${objectId}: ${label} is not finite.`
    );
  }
  try {
    resolved = resolveParamValue(value, scope, label);
  } catch (error) {
    refuse(
      'parameters-invalid',
      `Sketch object ${objectId}: ${label} could not be resolved (${error instanceof Error ? error.message : 'evaluation failed'}).`
    );
  }
  if (!Number.isFinite(resolved!)) {
    refuse(
      'invalid-geometry',
      `Sketch object ${objectId}: ${label} is not finite.`
    );
  }
  return resolved!;
}

function lineEntities(
  data: Extract<SketchObjectData, { objectKind: 'line' }>,
  scope: Readonly<Record<string, number>>,
  objectId: string,
  millimeterScale: number
): DxfEntity[] {
  const x1 = resolveScalar(data.x1, scope, 'line x1', objectId);
  const y1 = resolveScalar(data.y1, scope, 'line y1', objectId);
  const x2 = resolveScalar(data.x2, scope, 'line x2', objectId);
  const y2 = resolveScalar(data.y2, scope, 'line y2', objectId);
  if (x1 === x2 && y1 === y2) {
    refuse(
      'invalid-geometry',
      `Sketch object ${objectId}: line has zero length; a point is not exportable geometry.`
    );
  }
  return [
    {
      kind: 'line',
      start: [x1 * millimeterScale, y1 * millimeterScale],
      end: [x2 * millimeterScale, y2 * millimeterScale]
    }
  ];
}

function circleEntities(
  data: Extract<SketchObjectData, { objectKind: 'circle' }>,
  scope: Readonly<Record<string, number>>,
  objectId: string,
  millimeterScale: number
): DxfEntity[] {
  const centerX = resolveScalar(data.centerX, scope, 'center X', objectId);
  const centerY = resolveScalar(data.centerY, scope, 'center Y', objectId);
  const radius = resolveScalar(data.radius, scope, 'radius', objectId);
  if (!(radius > 0)) {
    refuse(
      'invalid-geometry',
      `Sketch object ${objectId}: circle radius must be positive, got ${radius}.`
    );
  }
  return [
    {
      kind: 'circle',
      center: [centerX * millimeterScale, centerY * millimeterScale],
      radius: radius * millimeterScale
    }
  ];
}

function arcEntities(
  data: Extract<SketchObjectData, { objectKind: 'arc' }>,
  scope: Readonly<Record<string, number>>,
  objectId: string,
  millimeterScale: number,
  diagnostics: string[]
): DxfEntity[] {
  const centerX = resolveScalar(data.centerX, scope, 'center X', objectId);
  const centerY = resolveScalar(data.centerY, scope, 'center Y', objectId);
  const radius = resolveScalar(data.radius, scope, 'radius', objectId);
  if (!(radius > 0)) {
    refuse(
      'invalid-geometry',
      `Sketch object ${objectId}: arc radius must be positive, got ${radius}.`
    );
  }
  const start = resolveScalar(
    data.startAngleDeg,
    scope,
    'start angle',
    objectId
  );
  const end = resolveScalar(data.endAngleDeg, scope, 'end angle', objectId);
  // Classify the RAW difference before any modulo normalization: `end - start
  // === 0` is a zero sweep, while an allowed raw `+360°` is full-circle intent
  // (DXF R12 has no portable full-turn arc). A normalization that turned
  // either case into equal ARC endpoints would serialize a zero-length ARC.
  const raw = end - start;
  if (raw === 0) {
    refuse(
      'invalid-geometry',
      `Sketch object ${objectId}: arc sweep is zero; a zero-length arc is not exportable geometry.`
    );
  }
  if (Math.abs(raw) > MAX_SKETCH_ARC_SWEEP_DEGREES) {
    refuse(
      'invalid-geometry',
      `Sketch object ${objectId}: arc sweep ${raw}° exceeds the supported ±${MAX_SKETCH_ARC_SWEEP_DEGREES}°.`
    );
  }
  // The sketch model's own sweep rule (`boundedArcSweepDegrees`) rejects a raw
  // -360°: the wrapped sweep would be zero. Passing it through would emit an
  // ARC whose endpoints coincide mod 360° (e.g. 300° to -60°).
  if (raw + MAX_SKETCH_ARC_SWEEP_DEGREES <= 0) {
    refuse(
      'invalid-geometry',
      `Sketch object ${objectId}: arc sweep ${raw}° wraps to a zero sweep; a zero-length arc is not exportable geometry.`
    );
  }
  const center: readonly [number, number] = [
    centerX * millimeterScale,
    centerY * millimeterScale
  ];
  if (raw === MAX_SKETCH_ARC_SWEEP_DEGREES) {
    diagnostics.push(
      `Sketch object ${objectId}: a full-turn arc is the same locus as a circle and is exported as CIRCLE.`
    );
    return [{ kind: 'circle', center, radius: radius * millimeterScale }];
  }
  // A negative raw difference that crosses zero (e.g. 300° to -60°) keeps its
  // stored endpoints: DXF ARC is counter-clockwise from start to end exactly
  // like the sketch model, so passing the degrees through preserves the
  // directed sweep without ever swapping them into a clockwise arc.
  return [
    {
      kind: 'arc',
      center,
      radius: radius * millimeterScale,
      startAngleDeg: start,
      endAngleDeg: end
    }
  ];
}

function rectangleEntities(
  data: Extract<SketchObjectData, { objectKind: 'rectangle' }>,
  scope: Readonly<Record<string, number>>,
  objectId: string,
  millimeterScale: number
): DxfEntity[] {
  const width = resolveScalar(data.width, scope, 'width', objectId);
  const height = resolveScalar(data.height, scope, 'height', objectId);
  const centerX = resolveScalar(data.centerX, scope, 'center X', objectId);
  const centerY = resolveScalar(data.centerY, scope, 'center Y', objectId);
  let corners: Vec2[];
  try {
    corners = rectangleProfile(width, height, centerX, centerY);
  } catch (error) {
    throw new RefusalSignal(
      'invalid-geometry',
      `Sketch object ${objectId}: rectangle is not exportable (${error instanceof Error ? error.message : 'invalid dimensions'}).`
    );
  }
  return corners.map((corner, index) => {
    const next = corners[(index + 1) % corners.length]!;
    return {
      kind: 'line',
      start: [corner.x * millimeterScale, corner.y * millimeterScale],
      end: [next.x * millimeterScale, next.y * millimeterScale]
    } satisfies DxfEntity;
  });
}

function polygonEntities(
  data: Extract<SketchObjectData, { objectKind: 'polygon' }>,
  scope: Readonly<Record<string, number>>,
  objectId: string,
  millimeterScale: number
): DxfEntity[] {
  const sides = resolveScalar(data.sides, scope, 'sides', objectId);
  const radius = resolveScalar(data.radius, scope, 'radius', objectId);
  const centerX = resolveScalar(data.centerX, scope, 'center X', objectId);
  const centerY = resolveScalar(data.centerY, scope, 'center Y', objectId);
  let points: Vec2[];
  try {
    points = polygonProfile(sides, radius, centerX, centerY);
  } catch (error) {
    throw new RefusalSignal(
      'invalid-geometry',
      `Sketch object ${objectId}: polygon is not exportable (${error instanceof Error ? error.message : 'invalid sides or radius'}).`
    );
  }
  // Individual LINEs in the helper's stable order — never a POLYLINE, which
  // would introduce implicit closure, and never a sampled approximation.
  return points.map((point, index) => {
    const next = points[(index + 1) % points.length]!;
    return {
      kind: 'line',
      start: [point.x * millimeterScale, point.y * millimeterScale],
      end: [next.x * millimeterScale, next.y * millimeterScale]
    } satisfies DxfEntity;
  });
}

/**
 * Lower one saved sketch to DXF entities in sketch-local (u, v) coordinates
 * scaled once to millimetres. Object order is the sketch node's `objectIds`
 * order, so repeat exports of unchanged history are byte-identical.
 */
export function sketchDxfEntities(input: SketchDxfInput): SketchDxfOutcome {
  try {
    if (
      !Number.isFinite(input.millimeterScale) ||
      !(input.millimeterScale > 0)
    ) {
      refuse(
        'invalid-geometry',
        `Unit scale ${input.millimeterScale} is not a positive number.`
      );
    }
    const basisRefusal = validateSketchDxfBasis(input.basis);
    if (basisRefusal) {
      return basisRefusal;
    }
    const entities: DxfEntity[] = [];
    const diagnostics: string[] = [];
    let excludedConstructionCount = 0;
    for (const object of input.objects) {
      const data = object.data;
      if (data === undefined) {
        throw new RefusalSignal(
          'unsupported-object',
          `Sketch object ${object.id} is missing or is not a sketch object.`
        );
      }
      if (data.construction === true) {
        excludedConstructionCount += 1;
        continue;
      }
      switch (data.objectKind) {
        case 'line':
          entities.push(
            ...lineEntities(data, input.scope, object.id, input.millimeterScale)
          );
          break;
        case 'circle':
          entities.push(
            ...circleEntities(
              data,
              input.scope,
              object.id,
              input.millimeterScale
            )
          );
          break;
        case 'arc':
          entities.push(
            ...arcEntities(
              data,
              input.scope,
              object.id,
              input.millimeterScale,
              diagnostics
            )
          );
          break;
        case 'rectangle':
          entities.push(
            ...rectangleEntities(
              data,
              input.scope,
              object.id,
              input.millimeterScale
            )
          );
          break;
        case 'polygon':
          entities.push(
            ...polygonEntities(
              data,
              input.scope,
              object.id,
              input.millimeterScale
            )
          );
          break;
        case 'text':
          refuse(
            'unsupported-object',
            `Sketch object ${object.id} is text; glyph outlines are derived font curves, not persisted sketch primitives, so the sketch cannot be exported exactly.`
          );
          break;
        default:
          refuse(
            'unsupported-object',
            `Sketch object ${object.id} has kind ${(data as { objectKind: string }).objectKind}; only line, circle, arc, rectangle, and polygon export.`
          );
      }
    }
    if (entities.length === 0) {
      return {
        status: 'refused',
        reason: 'construction-only',
        message:
          excludedConstructionCount > 0
            ? `The sketch holds only ${excludedConstructionCount} construction object(s); construction geometry is reference-only and never enters manufacturing DXF output.`
            : 'The sketch holds no exportable geometry.'
      };
    }
    if (excludedConstructionCount > 0) {
      diagnostics.push(
        `Excluded ${excludedConstructionCount} construction object(s); manufacturing output holds none of them.`
      );
    }
    return { status: 'ok', entities, excludedConstructionCount, diagnostics };
  } catch (error) {
    if (error instanceof RefusalSignal) {
      return {
        status: 'refused',
        reason: error.reason,
        message: error.message
      };
    }
    throw error;
  }
}
