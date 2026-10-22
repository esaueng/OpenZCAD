import {
  SKETCH_PROJECTION_OBJECT_KINDS,
  type SketchObjectData,
  type SketchProjectionSource
} from '@openzcad/shared';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isQuantum(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** An ADR-011 quantized point: three safe integers. */
function isQuantizedPoint(value: unknown): boolean {
  return Array.isArray(value) && value.length === 3 && value.every(isQuantum);
}

/**
 * The shape of an `EdgeWitnessV1`, checked field by field: the exact build
 * reads every one of them while resolving the reference, so a record that
 * only looks like a witness must be refused here, on load.
 */
function isEdgeWitness(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.curveType) ||
    !isQuantum(value.length) ||
    (value.length as number) < 0
  ) {
    return false;
  }
  if (value.closed === false) {
    return (
      Array.isArray(value.endpoints) &&
      value.endpoints.length === 2 &&
      value.endpoints.every(isQuantizedPoint) &&
      isQuantizedPoint(value.midpoint)
    );
  }
  return (
    value.closed === true &&
    isQuantizedPoint(value.center) &&
    (value.axis === null || isQuantizedPoint(value.axis))
  );
}

function isProjectionSource(value: unknown): value is SketchProjectionSource {
  if (!isRecord(value) || !nonEmptyString(value.bodyId)) return false;
  const reference = value.edgeReference;
  return (
    isRecord(reference) &&
    reference.kind === 'edge' &&
    nonEmptyString(reference.producingFeatureId) &&
    nonEmptyString(reference.lineageName) &&
    isQuantum(reference.currentHash) &&
    (reference.currentHash as number) >= 0 &&
    reference.witnessVersion === 1 &&
    isEdgeWitness(reference.witness)
  );
}

/**
 * I01 (schema v33): a projected object's record, checked as written. A
 * malformed one is refused by name rather than dropped, so a document never
 * silently loses the link it was saved with; nothing is ever synthesized.
 */
export function assertSketchObjectProjection(
  data: SketchObjectData,
  objectId?: string
): void {
  const projection = (data as { projection?: unknown }).projection;
  if (projection === undefined) return;
  const name = `${data.objectKind} sketch object${objectId ? ` ${objectId}` : ''}`;
  if (
    !(SKETCH_PROJECTION_OBJECT_KINDS as readonly string[]).includes(
      data.objectKind
    )
  ) {
    throw new Error(
      `The ${name} carries a projection, but only lines, arcs, circles and ellipses can be projected.`
    );
  }
  if (!isRecord(projection)) {
    throw new Error(`The ${name} has a malformed projection record.`);
  }
  if (projection.mode === 'linked') {
    if (!isProjectionSource(projection.source)) {
      throw new Error(
        `The ${name} is a linked projection without a verified source edge.`
      );
    }
    return;
  }
  if (projection.mode === 'unlinked') {
    if (
      projection.source !== undefined &&
      !isProjectionSource(projection.source)
    ) {
      throw new Error(
        `The ${name} names a malformed projection source edge.`
      );
    }
    return;
  }
  throw new Error(
    `The ${name} has projection mode "${String(projection.mode)}"; expected "linked" or "unlinked".`
  );
}
