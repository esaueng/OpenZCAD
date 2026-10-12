import {
  createSketchReferenceAnnotationId,
  isSketchReferenceDimension,
  isSketchReferenceDimensionData,
  resolveSketchReferenceDimension,
  type EntityId,
  type ProjectDocument,
  type SketchDimensionLabelPosition,
  type SketchId,
  type SketchNode,
  type SketchReferenceAnnotationId,
  type SketchReferenceDimensionData
} from '@openzcad/shared';
import {
  cloneDocument,
  findSketch,
  getParameterScope,
  resolveParamValue
} from './index';

export interface SketchReferenceDimensionAddInput {
  sketchId: SketchId;
  data: SketchReferenceDimensionData;
  ids?: { annotationId: SketchReferenceAnnotationId };
}
export interface SketchReferenceDimensionDeleteInput {
  sketchId: SketchId;
  annotationId: SketchReferenceAnnotationId;
}
export interface SketchReferenceLabelPositionInput extends SketchReferenceDimensionDeleteInput {
  position: SketchDimensionLabelPosition;
}

function requireSketch(document: ProjectDocument, sketchId: SketchId) {
  const sketch = findSketch(document, sketchId);
  if (!sketch) throw new Error(`Sketch ${sketchId} not found.`);
  return sketch;
}

export function referenceDimensionObjectIds(
  data: SketchReferenceDimensionData
): EntityId[] {
  switch (data.dimensionKind) {
    case 'distance':
      return [data.a.objectId, data.b.objectId];
    case 'radius':
      return [data.objectId];
    case 'angle':
      return [data.a, data.b];
  }
}

/** Invalid targets remain repairable; malformed/driving payloads never become annotations. */
export function assertSketchReferenceDimensions(sketch: SketchNode) {
  if (sketch.referenceDimensions === undefined) return;
  if (!Array.isArray(sketch.referenceDimensions))
    throw new Error('Reference dimensions must be a list.');
  const seen = new Set<string>();
  for (const reference of sketch.referenceDimensions) {
    if (
      !isSketchReferenceDimension(reference) ||
      !reference.annotationId.startsWith('sref_') ||
      seen.has(reference.annotationId) ||
      sketch.constraints?.some(
        (c) => String(c.constraintId) === String(reference.annotationId)
      )
    ) {
      throw new Error(
        'Reference dimensions need unique annotation identities and measured targets, without driving values.'
      );
    }
    seen.add(reference.annotationId);
  }
}

export function addSketchReferenceDimension(
  document: ProjectDocument,
  input: SketchReferenceDimensionAddInput
) {
  const sketch = requireSketch(document, input.sketchId);
  if (!isSketchReferenceDimensionData(input.data))
    throw new Error(
      'A reference dimension stores measured targets, not a driving value.'
    );
  const annotationId =
    input.ids?.annotationId ?? createSketchReferenceAnnotationId();
  const reference = { annotationId, data: input.data };
  assertSketchReferenceDimensions({
    ...sketch,
    referenceDimensions: [...(sketch.referenceDimensions ?? []), reference]
  });
  const objects = new Map(
    sketch.objectIds.flatMap((id) => {
      const node = document.nodes[id];
      return node?.kind === 'sketch-object' ? [[id, node.data] as const] : [];
    })
  );
  const scope = getParameterScope(document).scope;
  const outcome = resolveSketchReferenceDimension(
    objects,
    reference,
    (value) => {
      try {
        return resolveParamValue(value, scope, undefined, document.units);
      } catch {
        return undefined;
      }
    }
  );
  if (outcome.status === 'unresolved') throw new Error(outcome.reason);
  const next = cloneDocument(document);
  requireSketch(next, input.sketchId).referenceDimensions = [
    ...(sketch.referenceDimensions ?? []),
    reference
  ];
  next.version += 1;
  return { document: next, annotationId };
}

export function deleteSketchReferenceDimension(
  document: ProjectDocument,
  input: SketchReferenceDimensionDeleteInput
): ProjectDocument {
  const sketch = requireSketch(document, input.sketchId);
  if (
    !sketch.referenceDimensions?.some(
      (r) => r.annotationId === input.annotationId
    )
  )
    throw new Error(`Reference dimension ${input.annotationId} not found.`);
  const next = cloneDocument(document);
  const updated = requireSketch(next, input.sketchId);
  updated.referenceDimensions = updated.referenceDimensions!.filter(
    (r) => r.annotationId !== input.annotationId
  );
  if (updated.dimensionLabelPositions)
    delete updated.dimensionLabelPositions[input.annotationId];
  next.version += 1;
  return next;
}

export function setSketchReferenceLabelPosition(
  document: ProjectDocument,
  input: SketchReferenceLabelPositionInput
): ProjectDocument {
  const sketch = requireSketch(document, input.sketchId);
  if (
    !sketch.referenceDimensions?.some(
      (r) => r.annotationId === input.annotationId
    )
  )
    throw new Error(`Reference dimension ${input.annotationId} not found.`);
  const { x, y } = input.position;
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    Math.max(Math.abs(x), Math.abs(y)) > 1e6
  )
    throw new Error(
      'Reference label position must be finite and within the supported range.'
    );
  const next = cloneDocument(document);
  const updated = requireSketch(next, input.sketchId);
  const positions = { ...(updated.dimensionLabelPositions ?? {}) };
  if (Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12)
    delete positions[input.annotationId];
  else positions[input.annotationId] = { x, y };
  updated.dimensionLabelPositions = Object.keys(positions).length
    ? positions
    : undefined;
  next.version += 1;
  return next;
}

export function assertNoReferenceDimensionDependents(
  sketch: SketchNode,
  objectId: EntityId
) {
  const dependents =
    sketch.referenceDimensions?.filter((r) =>
      referenceDimensionObjectIds(r.data).includes(objectId)
    ) ?? [];
  if (dependents.length)
    throw new Error(
      `Delete the reference dimensions first: ${dependents.map((r) => `${r.data.dimensionKind} (${r.annotationId})`).join(', ')}. The geometry was kept.`
    );
}
