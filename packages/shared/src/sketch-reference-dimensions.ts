import type {
  EntityId,
  ParamValue,
  SketchConstraint,
  SketchComposite,
  SketchCompositeId,
  SketchDimensionIdentity,
  SketchNode,
  SketchObjectData,
  SketchPointRef,
  SketchReferenceAnnotationId,
  SketchReferenceDimension,
  SketchReferenceDimensionData,
  SketchReferenceDistanceMode,
  SketchReferencePointTarget,
  SketchReferenceCurveTarget,
  UnitSystem
} from './index';
import { ownEntry } from './document-validation';

import {
  isSketchCompositeCenterTarget,
  isSketchCompositeCornerTarget,
  isSketchCompositeSideTarget,
  resolveSketchCompositeCenterIdentity,
  resolveSketchCompositeCenterTarget,
  resolveSketchCompositeCornerTarget,
  resolveSketchCompositeSideTarget,
  resolveSketchCompositeTargetIdentity,
  sketchCompositeCenterAliases,
  sketchCompositeTargetMemberIds,
  type SketchCompositeCornerTarget
} from './sketch-composite-targets';
import {
  isSketchShapeCenterTarget,
  isSketchShapeCornerTarget,
  isSketchShapeSideTarget,
  qualifySketchShapeTarget,
  resolveSketchShapePointTarget,
  resolveSketchShapeSideTarget
} from './sketch-shape-targets';
import {
  isSketchAxisTarget,
  isSketchOriginTarget,
  sketchAxisSegment
} from './sketch-datum-targets';

/** Every saved point-target form, including v125 shape centres and legacy shapes. */
export function isSketchReferencePointTarget(
  value: unknown
): value is SketchReferencePointTarget {
  return (
    isSketchPointRef(value) ||
    isSketchCompositeCornerTarget(value) ||
    isSketchCompositeCenterTarget(value) ||
    isSketchShapeCornerTarget(value) ||
    isSketchShapeCenterTarget(value) ||
    isSketchOriginTarget(value)
  );
}

/** Every saved curve-target form, including v125 legacy-shape sides. */
export function isSketchReferenceCurveTarget(
  value: unknown
): value is SketchReferenceCurveTarget {
  return (
    typeof value === 'string' ||
    isSketchCompositeSideTarget(value) ||
    isSketchShapeSideTarget(value) ||
    isSketchAxisTarget(value)
  );
}

/**
 * S02-A — shared types and pure resolver for driven/reference dimensions.
 *
 * A reference dimension is a saved sketch annotation. It owns an
 * `annotationId`, stores only target identity, and derives a measured value
 * from the current sketch geometry. It never enters GCS, never changes a
 * `SketchObjectData` field, and never becomes a constraint through a click
 * or a label drag. Commands, persistence envelopes, and rendering arrive in
 * S02-B/C; this module is intentionally command- and DOM-free so the
 * document, worker, and viewport layers can share it.
 */

export type SketchReferenceDimensionKind =
  SketchReferenceDimensionData['dimensionKind'];

export type SketchReferenceDimensionStatus = 'current' | 'unresolved';

export interface SketchReferencePoint {
  x: number;
  y: number;
}

export type SketchReferenceDimensionOutcome =
  | {
      status: 'current';
      dimensionKind: 'distance';
      /** Measured separation in sketch-local (document) units. */
      value: number;
      distanceMode?: SketchReferenceDistanceMode;
      a: SketchReferencePoint;
      b: SketchReferencePoint;
    }
  | {
      status: 'current';
      dimensionKind: 'radius';
      /** Resolved positive radius in sketch-local (document) units. */
      value: number;
      center: SketchReferencePoint;
      radius: number;
    }
  | {
      status: 'current';
      dimensionKind: 'angle';
      /** Included angle in degrees, in `[0, 180]`. */
      valueDeg: number;
      a: SketchReferencePoint;
      b: SketchReferencePoint;
      c: SketchReferencePoint;
      d: SketchReferencePoint;
    }
  | {
      status: 'unresolved';
      dimensionKind: SketchReferenceDimensionKind;
      /**
       * Named failure that identifies the annotation and its target, e.g.
       * `Reference dimension "sref_…": line "ent_…" has no 'center' point.`
       * Callers surface this verbatim; it never guesses a replacement.
       */
      reason: string;
    };

/** Turns a `ParamValue` into a number; `undefined` means unknown/cyclic/non-finite. */
export type ReferenceValueResolve = (value: ParamValue) => number | undefined;

/** Millimetres per document unit. Mirrors `UNIT_TO_MM`; kept local so this
 * module stays free of a runtime import cycle with `./index`. */
const REFERENCE_MM_PER_UNIT: Record<UnitSystem, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  inch: 25.4
};

/** Creates a stable annotation id. Never derived from target order or the
 * current numeric result; retained when parameters move and replayed verbatim. */
export function createSketchReferenceAnnotationId(): SketchReferenceAnnotationId {
  return `sref_${crypto.randomUUID()}` as SketchReferenceAnnotationId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPointRole(value: unknown): value is SketchPointRef['point'] {
  return value === 'start' || value === 'end' || value === 'center';
}

export function isSketchPointRef(value: unknown): value is SketchPointRef {
  return (
    isRecord(value) &&
    typeof value.objectId === 'string' &&
    isPointRole(value.point) &&
    Object.keys(value).length === 2
  );
}

function hasDrivingField(value: Record<string, unknown>): boolean {
  return (
    'value' in value ||
    'valueDeg' in value ||
    'constraintKind' in value ||
    'constraintId' in value ||
    'expression' in value
  );
}

function isDistanceMode(
  value: unknown
): value is SketchReferenceDistanceMode | undefined {
  return (
    value === undefined ||
    value === 'absolute' ||
    value === 'horizontal' ||
    value === 'vertical'
  );
}

/** Structural guard for persisted payloads. Rejects driving-dimension fields
 * (`value`, `valueDeg`, `constraintKind`, …): a reference row carries no
 * authored numeric value and no `ParamValue`, so a payload smuggling one is
 * malformed rather than convertible. */
export function isSketchReferenceDimensionData(
  value: unknown
): value is SketchReferenceDimensionData {
  if (!isRecord(value) || typeof value.dimensionKind !== 'string') {
    return false;
  }
  if (hasDrivingField(value)) {
    return false;
  }
  switch (value.dimensionKind) {
    case 'distance':
      return (
        isSketchReferencePointTarget(value.a) &&
        isSketchReferencePointTarget(value.b) &&
        isDistanceMode(value.distanceMode) &&
        Object.keys(value).length === ('distanceMode' in value ? 4 : 3)
      );
    case 'radius':
      return (
        typeof value.objectId === 'string' && Object.keys(value).length === 2
      );
    case 'angle':
      return (
        isSketchReferenceCurveTarget(value.a) &&
        isSketchReferenceCurveTarget(value.b) &&
        Object.keys(value).length === 3
      );
    default:
      return false;
  }
}

export function isSketchReferenceDimension(
  value: unknown
): value is SketchReferenceDimension {
  if (!isRecord(value) || typeof value.annotationId !== 'string') {
    return false;
  }
  if (!isSketchReferenceDimensionData(value.data)) {
    return false;
  }
  return Object.keys(value).length === 2;
}

export function isSketchDimensionIdentity(
  value: unknown
): value is SketchDimensionIdentity {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return false;
  }
  if (value.kind === 'constraint') {
    return (
      typeof value.constraintId === 'string' && Object.keys(value).length === 2
    );
  }
  if (value.kind === 'reference') {
    return (
      typeof value.annotationId === 'string' && Object.keys(value).length === 2
    );
  }
  return false;
}

/** Presentation-map key for a tagged dimension identity. Driving rows use
 * `constraintId`, reference rows use `annotationId`; both share S01's
 * string-keyed `dimensionLabelPositions` map. */
export function sketchDimensionIdentityKey(
  identity: SketchDimensionIdentity
): string {
  return identity.kind === 'constraint'
    ? String(identity.constraintId)
    : String(identity.annotationId);
}

/**
 * Tagged lookup for a reference row. Accepts only an explicit annotation id;
 * no implementation may accept a bare string and infer whether it is a
 * constraint or an annotation by searching both arrays.
 */
export function findSketchReferenceDimension(
  sketch: Pick<SketchNode, 'referenceDimensions'>,
  annotationId: SketchReferenceAnnotationId | string
): SketchReferenceDimension | undefined {
  return (sketch.referenceDimensions ?? []).find(
    (entry) => entry.annotationId === annotationId
  );
}

/**
 * The constraints the GCS solve receives. Reference dimensions are excluded
 * by construction: they are a different record type with no `ParamValue`,
 * and this helper is the single place a solve gathers its inputs.
 */
export function sketchConstraintsForSolve(
  sketch: Pick<SketchNode, 'constraints'>
): SketchConstraint[] {
  return sketch.constraints ?? [];
}

/** True when the sketch carries no reference rows (the v15-absent case). */
export function hasSketchReferenceDimensions(
  sketch: Pick<SketchNode, 'referenceDimensions'>
): boolean {
  return (sketch.referenceDimensions ?? []).length > 0;
}

/** All saved geometry dependencies, including complete named composite topology. */
export function sketchReferenceDimensionObjectIds(
  data: SketchReferenceDimensionData
): EntityId[] {
  const pointIds = (target: SketchReferencePointTarget): EntityId[] =>
    isSketchOriginTarget(target)
      ? []
      : isSketchPointRef(target) ||
          isSketchShapeCornerTarget(target) ||
          isSketchShapeCenterTarget(target)
        ? [target.objectId]
        : sketchCompositeTargetMemberIds(target);
  const curveIds = (target: SketchReferenceCurveTarget): EntityId[] =>
    typeof target === 'string'
      ? [target]
      : isSketchAxisTarget(target)
        ? []
        : isSketchShapeSideTarget(target)
          ? [target.objectId]
          : sketchCompositeTargetMemberIds(target);
  return [
    ...new Set(
      data.dimensionKind === 'distance'
        ? [...pointIds(data.a), ...pointIds(data.b)]
        : data.dimensionKind === 'angle'
          ? [...curveIds(data.a), ...curveIds(data.b)]
          : [data.objectId]
    )
  ];
}

/**
 * A lowered point operand: a primitive point the existing rules measure, or a
 * point derived from a named shape (a composite centre, a legacy shape's
 * corner or centre). `aliases` are the primitive points naming the same
 * physical target, so one target picked through two names is refused.
 */
type PointOperand =
  | { kind: 'ref'; ref: SketchPointRef; aliases: SketchPointRef[] }
  | {
      kind: 'derived';
      key: string;
      label: string;
      aliases: SketchPointRef[];
      /** Present only when lowered with a resolver. */
      point?: SketchReferencePoint;
    };

/** A lowered curve operand: a real line, or a legacy shape's side. */
type CurveOperand =
  | { kind: 'id'; id: EntityId }
  | {
      kind: 'derived';
      key: string;
      label: string;
      /** Present only when lowered with a resolver. */
      start?: SketchReferencePoint;
      end?: SketchReferencePoint;
    };

type LoweredReferenceDimensionData =
  | (Omit<
      Extract<SketchReferenceDimensionData, { dimensionKind: 'distance' }>,
      'a' | 'b'
    > & {
      a: PointOperand;
      b: PointOperand;
    })
  | Extract<SketchReferenceDimensionData, { dimensionKind: 'radius' }>
  | { dimensionKind: 'angle'; a: CurveOperand; b: CurveOperand };

type LoweredReferenceTargets =
  | { ok: true; data: LoweredReferenceDimensionData }
  | { ok: false; reason: string };

function cornerAliases(target: SketchCompositeCornerTarget): SketchPointRef[] {
  const { edgeIds } = target.topology;
  return [
    { objectId: edgeIds[target.index]!, point: 'start' },
    {
      objectId: edgeIds[(target.index + edgeIds.length - 1) % edgeIds.length]!,
      point: 'end'
    }
  ];
}

function sameRef(x: SketchPointRef, y: SketchPointRef): boolean {
  return x.objectId === y.objectId && x.point === y.point;
}

function samePointOperand(a: PointOperand, b: PointOperand): boolean {
  if (a.kind === 'derived' && b.kind === 'derived' && a.key === b.key)
    return true;
  return a.aliases.some((x) => b.aliases.some((y) => sameRef(x, y)));
}

function curveOperandName(operand: CurveOperand): string {
  return operand.kind === 'id' ? String(operand.id) : operand.label;
}

function sameCurveOperand(a: CurveOperand, b: CurveOperand): boolean {
  return a.kind === 'id' && b.kind === 'id'
    ? a.id === b.id
    : a.kind === 'derived' && b.kind === 'derived' && a.key === b.key;
}

function pointOperandLabel(operand: PointOperand): string {
  return operand.kind === 'ref' ? pointTargetLabel(operand.ref) : operand.label;
}

function lowerReferenceTargets(
  objects: ReadonlyMap<EntityId, SketchObjectData>,
  data: SketchReferenceDimensionData,
  composites: readonly SketchComposite[],
  resolve?: ReferenceValueResolve
): LoweredReferenceTargets {
  type PointResult =
    { ok: true; operand: PointOperand } | { ok: false; reason: string };
  const point = (target: SketchReferencePointTarget): PointResult => {
    if (isSketchPointRef(target))
      return {
        ok: true,
        operand: { kind: 'ref', ref: target, aliases: [target] }
      };
    if (isSketchCompositeCornerTarget(target)) {
      const aliases = cornerAliases(target);
      if (resolve) {
        const result = resolveSketchCompositeCornerTarget(
          target,
          composites,
          objects,
          resolve
        );
        return result.status === 'resolved'
          ? {
              ok: true,
              operand: { kind: 'ref', ref: result.pointRef, aliases }
            }
          : { ok: false, reason: result.reason };
      }
      const identity = resolveSketchCompositeTargetIdentity(
        target,
        composites,
        objects
      );
      return identity.status === 'resolved'
        ? {
            ok: true,
            operand: {
              kind: 'ref',
              ref: {
                objectId: identity.composite.edgeIds[target.index]!,
                point: 'start'
              },
              aliases
            }
          }
        : { ok: false, reason: identity.reason };
    }
    if (isSketchCompositeCenterTarget(target)) {
      const identity = resolveSketchCompositeCenterIdentity(
        target,
        composites,
        objects
      );
      if (identity.status === 'unresolved')
        return { ok: false, reason: identity.reason };
      const operand: PointOperand = {
        kind: 'derived',
        key: `composite-center:${target.compositeId}`,
        label: `composite "${target.compositeId}" centre`,
        aliases: sketchCompositeCenterAliases(identity.composite)
      };
      if (!resolve) return { ok: true, operand };
      const result = resolveSketchCompositeCenterTarget(
        target,
        composites,
        objects,
        resolve
      );
      return result.status === 'resolved'
        ? { ok: true, operand: { ...operand, point: result.point } }
        : { ok: false, reason: result.reason };
    }
    if (
      isSketchShapeCornerTarget(target) ||
      isSketchShapeCenterTarget(target)
    ) {
      const qualified = qualifySketchShapeTarget(target, objects, resolve);
      if (qualified.status === 'unresolved')
        return { ok: false, reason: qualified.reason };
      const operand: PointOperand = {
        kind: 'derived',
        key:
          target.kind === 'shape-center'
            ? `shape-center:${target.objectId}`
            : `shape-corner:${target.objectId}:${target.index}`,
        label:
          target.kind === 'shape-center'
            ? `shape "${target.objectId}" centre`
            : `shape "${target.objectId}" corner ${target.index + 1}`,
        aliases: []
      };
      if (!resolve) return { ok: true, operand };
      const result = resolveSketchShapePointTarget(target, objects, resolve);
      return result.status === 'resolved'
        ? { ok: true, operand: { ...operand, point: result.point } }
        : { ok: false, reason: result.reason };
    }
    if (isSketchOriginTarget(target))
      return {
        ok: true,
        operand: {
          kind: 'derived',
          key: 'sketch-origin',
          label: 'sketch origin',
          aliases: [],
          point: { x: 0, y: 0 }
        }
      };
    return { ok: false, reason: 'the point target descriptor is malformed.' };
  };
  type CurveResult =
    { ok: true; operand: CurveOperand } | { ok: false; reason: string };
  const curve = (target: SketchReferenceCurveTarget): CurveResult => {
    if (typeof target === 'string')
      return { ok: true, operand: { kind: 'id', id: target } };
    if (isSketchCompositeSideTarget(target)) {
      if (resolve) {
        const result = resolveSketchCompositeSideTarget(
          target,
          composites,
          objects,
          resolve
        );
        return result.status === 'resolved'
          ? { ok: true, operand: { kind: 'id', id: result.objectId } }
          : { ok: false, reason: result.reason };
      }
      const identity = resolveSketchCompositeTargetIdentity(
        target,
        composites,
        objects
      );
      return identity.status === 'resolved'
        ? {
            ok: true,
            operand: {
              kind: 'id',
              id: identity.composite.edgeIds[target.index]!
            }
          }
        : { ok: false, reason: identity.reason };
    }
    if (isSketchShapeSideTarget(target)) {
      const qualified = qualifySketchShapeTarget(target, objects, resolve);
      if (qualified.status === 'unresolved')
        return { ok: false, reason: qualified.reason };
      const operand: CurveOperand = {
        kind: 'derived',
        key: `shape-side:${target.objectId}:${target.index}`,
        label: `shape "${target.objectId}" side ${target.index + 1}`
      };
      if (!resolve) return { ok: true, operand };
      const result = resolveSketchShapeSideTarget(target, objects, resolve);
      return result.status === 'resolved'
        ? {
            ok: true,
            operand: { ...operand, start: result.start, end: result.end }
          }
        : { ok: false, reason: result.reason };
    }
    if (isSketchAxisTarget(target))
      return {
        ok: true,
        operand: {
          kind: 'derived',
          key: `sketch-axis:${target.axis}`,
          label: `sketch ${target.axis.toUpperCase()} axis`,
          ...sketchAxisSegment(target.axis)
        }
      };
    return { ok: false, reason: 'the side target descriptor is malformed.' };
  };
  if (data.dimensionKind === 'distance') {
    const a = point(data.a);
    if (!a.ok) return a;
    const b = point(data.b);
    if (!b.ok) return b;
    return { ok: true, data: { ...data, a: a.operand, b: b.operand } };
  }
  if (data.dimensionKind === 'angle') {
    const a = curve(data.a);
    if (!a.ok) return a;
    const b = curve(data.b);
    if (!b.ok) return b;
    return { ok: true, data: { ...data, a: a.operand, b: b.operand } };
  }
  return { ok: true, data };
}

function annotationLabel(annotationId: string): string {
  return `Reference dimension "${annotationId}"`;
}

function pointTargetLabel(ref: SketchPointRef): string {
  return `"${String(ref.objectId)}".${ref.point}`;
}

function creationError(
  annotationId: string | undefined,
  detail: string
): Error {
  const prefix =
    annotationId !== undefined
      ? annotationLabel(annotationId)
      : 'Reference dimension';
  return new Error(`${prefix}: ${detail}`);
}

type ObjectKind = SketchObjectData['objectKind'];

function legalPointForKind(
  kind: ObjectKind,
  point: SketchPointRef['point']
): boolean {
  if (kind === 'line') {
    return point === 'start' || point === 'end';
  }
  if (kind === 'circle') {
    return point === 'center';
  }
  if (kind === 'arc') {
    return point === 'start' || point === 'end' || point === 'center';
  }
  return false;
}

function unsupportedKindMessage(kind: string): string {
  return (
    `a ${kind} object cannot carry a reference dimension in this slice; ` +
    `expected a line, circle, or arc point.`
  );
}

/**
 * Structural validation for a reference target against its owning sketch.
 * Every referenced object must belong to the sketch, expose the named point,
 * and pair legally. Throws with a message naming the annotation and target.
 * Expression values are validated at resolve time, when parameters resolve.
 *
 * The same target identity twice (`a` deep-equals `b`) is refused at
 * creation because it is not a meaningful reference. Two distinct points
 * that currently coincide are legal and resolve to a valid zero distance.
 */
export function validateSketchReferenceDimensionData(
  objectsById: ReadonlyMap<EntityId, SketchObjectData>,
  targetData: SketchReferenceDimensionData,
  annotationId?: string,
  composites: readonly SketchComposite[] = []
): void {
  const lowered = lowerReferenceTargets(objectsById, targetData, composites);
  if (!lowered.ok) throw creationError(annotationId, lowered.reason);
  const data = lowered.data;
  switch (data.dimensionKind) {
    case 'distance': {
      if (!isDistanceMode(data.distanceMode)) {
        throw creationError(
          annotationId,
          'the reference distance mode is unknown.'
        );
      }
      for (const operand of [data.a, data.b]) {
        if (operand.kind === 'ref' && !objectsById.get(operand.ref.objectId)) {
          throw creationError(
            annotationId,
            `point target ${pointTargetLabel(operand.ref)} is not part of this sketch.`
          );
        }
      }
      if (samePointOperand(data.a, data.b)) {
        throw creationError(
          annotationId,
          'a reference distance needs two distinct points, not the same target twice.'
        );
      }
      for (const operand of [data.a, data.b]) {
        if (operand.kind !== 'ref') continue;
        const ref = operand.ref;
        const objectData = objectsById.get(ref.objectId)!;
        if (
          objectData.objectKind !== 'line' &&
          objectData.objectKind !== 'circle' &&
          objectData.objectKind !== 'arc'
        ) {
          throw creationError(
            annotationId,
            `${unsupportedKindMessage(objectData.objectKind)} Got ${pointTargetLabel(ref)}.`
          );
        }
        if (!legalPointForKind(objectData.objectKind, ref.point)) {
          throw creationError(
            annotationId,
            `a ${objectData.objectKind} object has no '${ref.point}' point (target ${pointTargetLabel(ref)}).`
          );
        }
      }
      return;
    }
    case 'radius': {
      const objectData = objectsById.get(data.objectId);
      if (!objectData) {
        throw creationError(
          annotationId,
          `target "${String(data.objectId)}" is not part of this sketch.`
        );
      }
      if (
        objectData.objectKind !== 'circle' &&
        objectData.objectKind !== 'arc'
      ) {
        throw creationError(
          annotationId,
          `a radius reference applies to circles and arcs, not ${objectData.objectKind} "${String(data.objectId)}".`
        );
      }
      return;
    }
    case 'angle': {
      for (const operand of [data.a, data.b]) {
        if (operand.kind === 'id' && !objectsById.get(operand.id)) {
          throw creationError(
            annotationId,
            `target "${String(operand.id)}" is not part of this sketch.`
          );
        }
      }
      if (sameCurveOperand(data.a, data.b)) {
        throw creationError(
          annotationId,
          'an angle reference needs two distinct lines.'
        );
      }
      for (const operand of [data.a, data.b]) {
        if (operand.kind !== 'id') continue;
        const objectData = objectsById.get(operand.id)!;
        if (objectData.objectKind !== 'line') {
          throw creationError(
            annotationId,
            `an angle reference applies to two lines, not ${objectData.objectKind} "${String(operand.id)}".`
          );
        }
      }
      return;
    }
  }
}

function unresolved(
  dimensionKind: SketchReferenceDimensionKind,
  annotationId: string,
  detail: string
): Extract<SketchReferenceDimensionOutcome, { status: 'unresolved' }> {
  return {
    status: 'unresolved',
    dimensionKind,
    reason: `${annotationLabel(annotationId)}: ${detail}`
  };
}

function finiteOrUndefined(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function resolvePoint(
  objectsById: ReadonlyMap<EntityId, SketchObjectData>,
  ref: SketchPointRef,
  resolve: ReferenceValueResolve
): { ok: true; point: SketchReferencePoint } | { ok: false; reason: string } {
  const data = objectsById.get(ref.objectId);
  if (!data) {
    return {
      ok: false,
      reason: `point target ${pointTargetLabel(ref)} is not part of this sketch.`
    };
  }
  if (
    data.objectKind !== 'line' &&
    data.objectKind !== 'circle' &&
    data.objectKind !== 'arc'
  ) {
    return { ok: false, reason: unsupportedKindMessage(data.objectKind) };
  }
  if (!legalPointForKind(data.objectKind, ref.point)) {
    return {
      ok: false,
      reason: `a ${data.objectKind} object has no '${ref.point}' point (target ${pointTargetLabel(ref)}).`
    };
  }
  if (data.objectKind === 'line') {
    const x = finiteOrUndefined(
      resolve(ref.point === 'start' ? data.x1 : data.x2)
    );
    const y = finiteOrUndefined(
      resolve(ref.point === 'start' ? data.y1 : data.y2)
    );
    if (x === undefined || y === undefined) {
      return {
        ok: false,
        reason: `target expression could not be resolved (${pointTargetLabel(ref)} coordinate).`
      };
    }
    return { ok: true, point: { x, y } };
  }
  const centerX = finiteOrUndefined(resolve(data.centerX));
  const centerY = finiteOrUndefined(resolve(data.centerY));
  if (centerX === undefined || centerY === undefined) {
    return {
      ok: false,
      reason: `target expression could not be resolved ("${String(ref.objectId)}" center).`
    };
  }
  if (ref.point === 'center') {
    return { ok: true, point: { x: centerX, y: centerY } };
  }
  if (data.objectKind !== 'arc') {
    return {
      ok: false,
      reason: `a circle object has no '${ref.point}' point (target ${pointTargetLabel(ref)}).`
    };
  }
  const radius = finiteOrUndefined(resolve(data.radius));
  const angleDeg = finiteOrUndefined(
    resolve(ref.point === 'start' ? data.startAngleDeg : data.endAngleDeg)
  );
  if (radius === undefined || angleDeg === undefined) {
    return {
      ok: false,
      reason: `target expression could not be resolved (${pointTargetLabel(ref)} arc position).`
    };
  }
  if (!(radius > 0)) {
    return {
      ok: false,
      reason: `degenerate radius on "${String(ref.objectId)}"; a reference radius must be finite and positive.`
    };
  }
  const radians = (angleDeg * Math.PI) / 180;
  const x = centerX + radius * Math.cos(radians);
  const y = centerY + radius * Math.sin(radians);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return {
      ok: false,
      reason: `target expression could not be resolved (${pointTargetLabel(ref)} arc position).`
    };
  }
  return { ok: true, point: { x, y } };
}

function resolvePointOperand(
  objectsById: ReadonlyMap<EntityId, SketchObjectData>,
  operand: PointOperand,
  resolve: ReferenceValueResolve
): { ok: true; point: SketchReferencePoint } | { ok: false; reason: string } {
  if (operand.kind === 'ref')
    return resolvePoint(objectsById, operand.ref, resolve);
  return operand.point
    ? { ok: true, point: operand.point }
    : {
        ok: false,
        reason: `target expression could not be resolved (${operand.label}).`
      };
}

/** A line's resolved ends, or a legacy shape side's. */
function resolveCurveOperand(
  objectsById: ReadonlyMap<EntityId, SketchObjectData>,
  operand: CurveOperand,
  resolve: ReferenceValueResolve
):
  | { ok: true; start: SketchReferencePoint; end: SketchReferencePoint }
  | { ok: false; reason: string } {
  if (operand.kind === 'derived')
    return operand.start && operand.end
      ? { ok: true, start: operand.start, end: operand.end }
      : {
          ok: false,
          reason: `target expression could not be resolved (${operand.label}).`
        };
  const data = objectsById.get(operand.id);
  if (!data)
    return {
      ok: false,
      reason: `target "${String(operand.id)}" is not part of this sketch.`
    };
  if (data.objectKind !== 'line')
    return {
      ok: false,
      reason: `an angle reference applies to two lines, not ${data.objectKind} "${String(operand.id)}".`
    };
  const x1 = finiteOrUndefined(resolve(data.x1));
  const y1 = finiteOrUndefined(resolve(data.y1));
  const x2 = finiteOrUndefined(resolve(data.x2));
  const y2 = finiteOrUndefined(resolve(data.y2));
  if (
    x1 === undefined ||
    y1 === undefined ||
    x2 === undefined ||
    y2 === undefined
  )
    return {
      ok: false,
      reason: 'target expression could not be resolved (angle line endpoint).'
    };
  return { ok: true, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } };
}

/**
 * Pure measurement of one reference dimension from current sketch geometry.
 * Never throws for target problems, never calls the solver, and never mutates
 * the document: every failure is an `unresolved` outcome with a reason naming
 * the annotation and target. Unknown, cyclic, or non-finite target
 * expressions surface as `unresolved` while all authored expression strings
 * stay byte-for-byte unchanged.
 */
export function resolveSketchReferenceDimension(
  objectsById: ReadonlyMap<EntityId, SketchObjectData>,
  annotation: SketchReferenceDimension,
  resolve: ReferenceValueResolve,
  composites: readonly SketchComposite[] = []
): SketchReferenceDimensionOutcome {
  const annotationId = String(annotation.annotationId);
  const lowered = lowerReferenceTargets(
    objectsById,
    annotation.data,
    composites,
    resolve
  );
  if (!lowered.ok)
    return unresolved(
      annotation.data.dimensionKind,
      annotationId,
      lowered.reason
    );
  const data = lowered.data;
  switch (data.dimensionKind) {
    case 'distance': {
      if (!isDistanceMode(data.distanceMode)) {
        return unresolved(
          data.dimensionKind,
          annotationId,
          'the reference distance mode is unknown.'
        );
      }
      if (samePointOperand(data.a, data.b)) {
        return unresolved(
          data.dimensionKind,
          annotationId,
          'a reference distance needs two distinct points, not the same target twice.'
        );
      }
      const a = resolvePointOperand(objectsById, data.a, resolve);
      if (!a.ok) {
        return unresolved(data.dimensionKind, annotationId, a.reason);
      }
      const b = resolvePointOperand(objectsById, data.b, resolve);
      if (!b.ok) {
        return unresolved(data.dimensionKind, annotationId, b.reason);
      }
      const dx = b.point.x - a.point.x;
      const dy = b.point.y - a.point.y;
      const value =
        data.distanceMode === 'horizontal'
          ? Math.abs(dx)
          : data.distanceMode === 'vertical'
            ? Math.abs(dy)
            : Math.hypot(dx, dy);
      if (!Number.isFinite(value)) {
        return unresolved(
          data.dimensionKind,
          annotationId,
          `target expression could not be resolved (distance between ${pointOperandLabel(data.a)} and ${pointOperandLabel(data.b)}).`
        );
      }
      // Distinct points that currently coincide report a valid zero distance.
      return {
        status: 'current',
        dimensionKind: 'distance',
        value,
        ...(data.distanceMode ? { distanceMode: data.distanceMode } : {}),
        a: a.point,
        b: b.point
      };
    }
    case 'radius': {
      const objectData = objectsById.get(data.objectId);
      if (!objectData) {
        return unresolved(
          data.dimensionKind,
          annotationId,
          `target "${String(data.objectId)}" is not part of this sketch.`
        );
      }
      if (
        objectData.objectKind !== 'circle' &&
        objectData.objectKind !== 'arc'
      ) {
        return unresolved(
          data.dimensionKind,
          annotationId,
          `a radius reference applies to circles and arcs, not ${objectData.objectKind} "${String(data.objectId)}".`
        );
      }
      const centerX = finiteOrUndefined(resolve(objectData.centerX));
      const centerY = finiteOrUndefined(resolve(objectData.centerY));
      const radius = finiteOrUndefined(resolve(objectData.radius));
      if (
        centerX === undefined ||
        centerY === undefined ||
        radius === undefined
      ) {
        return unresolved(
          data.dimensionKind,
          annotationId,
          `target expression could not be resolved ("${String(data.objectId)}" center or radius).`
        );
      }
      if (!(radius > 0)) {
        return unresolved(
          data.dimensionKind,
          annotationId,
          `degenerate radius on "${String(data.objectId)}"; a reference radius must be finite and positive.`
        );
      }
      return {
        status: 'current',
        dimensionKind: 'radius',
        value: radius,
        center: { x: centerX, y: centerY },
        radius
      };
    }
    case 'angle': {
      if (sameCurveOperand(data.a, data.b)) {
        return unresolved(
          data.dimensionKind,
          annotationId,
          'an angle reference needs two distinct lines.'
        );
      }
      for (const operand of [data.a, data.b]) {
        if (operand.kind === 'id' && !objectsById.get(operand.id)) {
          return unresolved(
            data.dimensionKind,
            annotationId,
            `target "${String(operand.id)}" is not part of this sketch.`
          );
        }
      }
      // Kinds are judged before expressions, as they always were.
      for (const operand of [data.a, data.b]) {
        const objectData =
          operand.kind === 'id' ? objectsById.get(operand.id) : undefined;
        if (objectData && objectData.objectKind !== 'line') {
          return unresolved(
            data.dimensionKind,
            annotationId,
            `an angle reference applies to two lines, not ${objectData.objectKind} "${String(operand.kind === 'id' ? operand.id : '')}".`
          );
        }
      }
      const lineA = resolveCurveOperand(objectsById, data.a, resolve);
      const lineB = lineA.ok
        ? resolveCurveOperand(objectsById, data.b, resolve)
        : lineA;
      if (!lineA.ok || !lineB.ok) {
        return unresolved(
          data.dimensionKind,
          annotationId,
          (!lineA.ok ? lineA : (lineB as { reason: string })).reason
        );
      }
      const { x: ax1, y: ay1 } = lineA.start;
      const { x: ax2, y: ay2 } = lineA.end;
      const { x: bx1, y: by1 } = lineB.start;
      const { x: bx2, y: by2 } = lineB.end;
      const ux = ax2 - ax1;
      const uy = ay2 - ay1;
      const vx = bx2 - bx1;
      const vy = by2 - by1;
      const lengthA = Math.hypot(ux, uy);
      const lengthB = Math.hypot(vx, vy);
      if (
        !Number.isFinite(lengthA) ||
        !Number.isFinite(lengthB) ||
        Math.min(lengthA, lengthB) <= 1e-9
      ) {
        return unresolved(
          data.dimensionKind,
          annotationId,
          `invalid line direction on "${curveOperandName(lengthA <= 1e-9 ? data.a : data.b)}"; an angle reference needs finite non-zero direction.`
        );
      }
      const cosine = Math.max(
        -1,
        Math.min(1, (ux * vx + uy * vy) / (lengthA * lengthB))
      );
      const valueDeg = (Math.acos(cosine) * 180) / Math.PI;
      if (!Number.isFinite(valueDeg)) {
        return unresolved(
          data.dimensionKind,
          annotationId,
          'target expression could not be resolved (angle between lines).'
        );
      }
      return {
        status: 'current',
        dimensionKind: 'angle',
        valueDeg,
        a: { x: ax1, y: ay1 },
        b: { x: ax2, y: ay2 },
        c: { x: bx1, y: by1 },
        d: { x: bx2, y: by2 }
      };
    }
  }
}

/**
 * Length conversion for display only. The document, its target expressions,
 * and the stored refs never change; only the rendered figure converts.
 * Angles stay in degrees.
 */
export function convertReferenceLengthForDisplay(
  value: number,
  fromUnit: UnitSystem,
  displayUnit: UnitSystem
): number {
  if (fromUnit === displayUnit) {
    return value;
  }
  return (
    value * (referenceMillimetres(fromUnit) / referenceMillimetres(displayUnit))
  );
}

/** Millimetres per unit; an unknown unit is refused, never read as NaN. */
function referenceMillimetres(unit: UnitSystem): number {
  const millimetres = ownEntry(REFERENCE_MM_PER_UNIT, unit);
  if (millimetres === undefined)
    throw new RangeError(`Unknown units "${String(unit)}".`);
  return millimetres;
}

/** Display unit label. `inch` renders as `in`, matching the measurement dock. */
export function referenceDisplayUnitLabel(
  dimension: 'length' | 'angle',
  unit: UnitSystem
): string {
  if (dimension === 'angle') {
    return '°';
  }
  return unit === 'inch' ? 'in' : unit;
}

function referenceKindNoun(
  kind: SketchReferenceDimensionKind
): 'distance' | 'angle' | 'radius' {
  return kind;
}

/**
 * Parenthesised measured text for a reference label, e.g. `(12 mm)`.
 * The parentheses are the distinct reference visual; driving rows never use
 * them. The caller supplies the already-formatted `12 mm` figure so number
 * formatting stays with the existing annotation machinery.
 */
export function referenceDimensionLabelText(
  kind: SketchReferenceDimensionKind,
  formattedValueWithUnit: string
): string {
  void kind;
  return `(${formattedValueWithUnit})`;
}

/** Accessible name for a reference label, e.g. `Reference distance, 12 mm`. */
export function referenceDimensionAccessibleName(
  kind: SketchReferenceDimensionKind,
  formattedValueWithUnit: string
): string {
  return `Reference ${referenceKindNoun(kind)}, ${formattedValueWithUnit}`;
}

/** Compact one-line description for a reference list row. */
export function describeSketchReferenceDimension(
  data: SketchReferenceDimensionData,
  nameOf: (objectId: EntityId) => string,
  nameOfComposite: (compositeId: SketchCompositeId) => string = (id) =>
    String(id)
): string {
  const pointName = (target: SketchReferencePointTarget) =>
    isSketchOriginTarget(target)
      ? 'Sketch origin'
      : isSketchPointRef(target)
        ? `${nameOf(target.objectId)}.${target.point}`
        : isSketchShapeCornerTarget(target)
          ? `${nameOf(target.objectId)} (parametric) · Corner ${target.index + 1}`
          : isSketchShapeCenterTarget(target)
            ? `${nameOf(target.objectId)} (parametric) · Centre`
            : isSketchCompositeCenterTarget(target)
              ? `${nameOfComposite(target.compositeId)} · Centre`
              : `${nameOfComposite(target.compositeId)} · Corner ${target.index + 1}`;
  const curveName = (target: SketchReferenceCurveTarget) =>
    typeof target === 'string'
      ? nameOf(target)
      : isSketchAxisTarget(target)
        ? `Sketch ${target.axis.toUpperCase()} axis`
        : isSketchShapeSideTarget(target)
          ? `${nameOf(target.objectId)} (parametric) · Side ${target.index + 1}`
          : `${nameOfComposite(target.compositeId)} · Side ${target.index + 1}`;
  switch (data.dimensionKind) {
    case 'distance':
      return `Reference ${data.distanceMode && data.distanceMode !== 'absolute' ? `${data.distanceMode} ` : ''}distance · ${pointName(data.a)} ↔ ${pointName(data.b)}`;
    case 'radius':
      return `Reference radius · ${nameOf(data.objectId)}`;
    case 'angle':
      return `Reference angle · ${curveName(data.a)} ∠ ${curveName(data.b)}`;
  }
}

/**
 * Existing refusal path for expressions on a reference dimension. A
 * reference row carries no `ParamValue`, so any value/expression edit
 * targeting one is refused instead of stored.
 */
export function refuseReferenceDimensionValueEdit(): string {
  return (
    'A reference dimension shows a measured value; it cannot carry an expression. ' +
    'Edit the sketch geometry or a driving dimension instead.'
  );
}

/**
 * A reference annotation never becomes a driving constraint through a click,
 * a label drag, or an implicit toggle. Converting intent is an explicit
 * delete-reference plus add-constraint pair (a later S02 slice); this names
 * the refusal so the UI can route it through the existing refusal path.
 */
export function refuseReferenceDrivingConversion(): string {
  return (
    'A reference dimension cannot become a driving constraint implicitly. ' +
    'Delete the reference and add a driving dimension instead.'
  );
}

/** Guard for tests and future commands: a reference row is never a constraint. */
export function isReferenceDimensionConstraint(
  value: SketchReferenceDimension | SketchConstraint
): value is SketchConstraint {
  return (
    isRecord(value) &&
    'constraintId' in value &&
    'data' in value &&
    isRecord((value as Record<string, unknown>).data) &&
    'constraintKind' in
      ((value as Record<string, unknown>).data as Record<string, unknown>)
  );
}
