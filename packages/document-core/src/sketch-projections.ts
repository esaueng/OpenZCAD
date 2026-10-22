import {
  SKETCH_PROJECTION_OBJECT_KINDS,
  isCanonicalEdgeTopologyReference,
  type SketchObjectData,
  type SketchProjectionSource
} from '@openzcad/shared';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isProjectionSource(value: unknown): value is SketchProjectionSource {
  return (
    isRecord(value) &&
    nonEmptyString(value.bodyId) &&
    isCanonicalEdgeTopologyReference(value.edgeReference)
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
      throw new Error(`The ${name} names a malformed projection source edge.`);
    }
    return;
  }
  throw new Error(
    `The ${name} has projection mode "${String(projection.mode)}"; expected "linked" or "unlinked".`
  );
}
