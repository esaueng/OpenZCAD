import type {
  EntityId,
  ParamValue,
  SketchConstraint,
  SketchDimensionIdentity,
  SketchNode,
  SketchObjectData,
  SketchPointRef,
  SketchReferenceAnnotationId,
  SketchReferenceDimension,
  SketchReferenceDimensionData,
  UnitSystem
} from './index';

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
      /** Measured Euclidean distance in sketch-local (document) units. */
      value: number;
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
        isSketchPointRef(value.a) &&
        isSketchPointRef(value.b) &&
        Object.keys(value).length === 3
      );
    case 'radius':
      return (
        typeof value.objectId === 'string' && Object.keys(value).length === 2
      );
    case 'angle':
      return (
        typeof value.a === 'string' &&
        typeof value.b === 'string' &&
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
  data: SketchReferenceDimensionData,
  annotationId?: string
): void {
  switch (data.dimensionKind) {
    case 'distance': {
      const aData = objectsById.get(data.a.objectId);
      if (!aData) {
        throw creationError(
          annotationId,
          `point target ${pointTargetLabel(data.a)} is not part of this sketch.`
        );
      }
      const bData = objectsById.get(data.b.objectId);
      if (!bData) {
        throw creationError(
          annotationId,
          `point target ${pointTargetLabel(data.b)} is not part of this sketch.`
        );
      }
      if (
        data.a.objectId === data.b.objectId &&
        data.a.point === data.b.point
      ) {
        throw creationError(
          annotationId,
          'a reference distance needs two distinct points, not the same target twice.'
        );
      }
      for (const [ref, objectData] of [
        [data.a, aData],
        [data.b, bData]
      ] as const) {
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
      const aData = objectsById.get(data.a);
      if (!aData) {
        throw creationError(
          annotationId,
          `target "${String(data.a)}" is not part of this sketch.`
        );
      }
      const bData = objectsById.get(data.b);
      if (!bData) {
        throw creationError(
          annotationId,
          `target "${String(data.b)}" is not part of this sketch.`
        );
      }
      if (data.a === data.b) {
        throw creationError(
          annotationId,
          'an angle reference needs two distinct lines.'
        );
      }
      for (const [objectId, objectData] of [
        [data.a, aData],
        [data.b, bData]
      ] as const) {
        if (objectData.objectKind !== 'line') {
          throw creationError(
            annotationId,
            `an angle reference applies to two lines, not ${objectData.objectKind} "${String(objectId)}".`
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
  resolve: ReferenceValueResolve
): SketchReferenceDimensionOutcome {
  const annotationId = String(annotation.annotationId);
  const data = annotation.data;
  switch (data.dimensionKind) {
    case 'distance': {
      if (
        data.a.objectId === data.b.objectId &&
        data.a.point === data.b.point
      ) {
        return unresolved(
          data.dimensionKind,
          annotationId,
          'a reference distance needs two distinct points, not the same target twice.'
        );
      }
      const a = resolvePoint(objectsById, data.a, resolve);
      if (!a.ok) {
        return unresolved(data.dimensionKind, annotationId, a.reason);
      }
      const b = resolvePoint(objectsById, data.b, resolve);
      if (!b.ok) {
        return unresolved(data.dimensionKind, annotationId, b.reason);
      }
      const value = Math.hypot(b.point.x - a.point.x, b.point.y - a.point.y);
      if (!Number.isFinite(value)) {
        return unresolved(
          data.dimensionKind,
          annotationId,
          `target expression could not be resolved (distance between ${pointTargetLabel(data.a)} and ${pointTargetLabel(data.b)}).`
        );
      }
      // Distinct points that currently coincide report a valid zero distance.
      return {
        status: 'current',
        dimensionKind: 'distance',
        value,
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
      if (data.a === data.b) {
        return unresolved(
          data.dimensionKind,
          annotationId,
          'an angle reference needs two distinct lines.'
        );
      }
      const aData = objectsById.get(data.a);
      const bData = objectsById.get(data.b);
      if (!aData) {
        return unresolved(
          data.dimensionKind,
          annotationId,
          `target "${String(data.a)}" is not part of this sketch.`
        );
      }
      if (!bData) {
        return unresolved(
          data.dimensionKind,
          annotationId,
          `target "${String(data.b)}" is not part of this sketch.`
        );
      }
      if (aData.objectKind !== 'line' || bData.objectKind !== 'line') {
        const badId = aData.objectKind !== 'line' ? data.a : data.b;
        const badKind =
          aData.objectKind !== 'line' ? aData.objectKind : bData.objectKind;
        return unresolved(
          data.dimensionKind,
          annotationId,
          `an angle reference applies to two lines, not ${badKind} "${String(badId)}".`
        );
      }
      const ax1 = finiteOrUndefined(resolve(aData.x1));
      const ay1 = finiteOrUndefined(resolve(aData.y1));
      const ax2 = finiteOrUndefined(resolve(aData.x2));
      const ay2 = finiteOrUndefined(resolve(aData.y2));
      const bx1 = finiteOrUndefined(resolve(bData.x1));
      const by1 = finiteOrUndefined(resolve(bData.y1));
      const bx2 = finiteOrUndefined(resolve(bData.x2));
      const by2 = finiteOrUndefined(resolve(bData.y2));
      if (
        ax1 === undefined ||
        ay1 === undefined ||
        ax2 === undefined ||
        ay2 === undefined ||
        bx1 === undefined ||
        by1 === undefined ||
        bx2 === undefined ||
        by2 === undefined
      ) {
        return unresolved(
          data.dimensionKind,
          annotationId,
          'target expression could not be resolved (angle line endpoint).'
        );
      }
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
          `invalid line direction on "${String(lengthA <= 1e-9 ? data.a : data.b)}"; an angle reference needs finite non-zero direction.`
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
    value *
    (REFERENCE_MM_PER_UNIT[fromUnit] / REFERENCE_MM_PER_UNIT[displayUnit])
  );
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
  nameOf: (objectId: EntityId) => string
): string {
  switch (data.dimensionKind) {
    case 'distance':
      return `Reference distance · ${nameOf(data.a.objectId)}.${data.a.point} ↔ ${nameOf(data.b.objectId)}.${data.b.point}`;
    case 'radius':
      return `Reference radius · ${nameOf(data.objectId)}`;
    case 'angle':
      return `Reference angle · ${nameOf(data.a)} ∠ ${nameOf(data.b)}`;
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
