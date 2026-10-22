import {
  createSketchReferenceAnnotationId,
  documentNodesWithHistory,
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

const REFERENCE_DISTANCE_MODE_SCHEMA_VERSION = 35;

function assertReferenceDataSchema(
  data: SketchReferenceDimensionData,
  schemaVersion: number | undefined
): void {
  if (
    data.dimensionKind === 'distance' &&
    data.distanceMode !== undefined &&
    (typeof schemaVersion !== 'number' ||
      !Number.isSafeInteger(schemaVersion) ||
      schemaVersion < REFERENCE_DISTANCE_MODE_SCHEMA_VERSION)
  )
    throw new Error(
      'Reference distance modes require project schema v35 or newer.'
    );
}

/** Validate replay targets, including log copies retained only by readable history. */
export function assertReferenceCommandSchema(
  document: Pick<
    ProjectDocument,
    'schemaVersion' | 'commandLog' | 'editHistory'
  >
): void {
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const pending: unknown[] = [document.commandLog];
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (change.field === 'commandLog')
        pending.push(change.before, change.after);
  const seen = new Set<object>();
  while (pending.length) {
    const command = pending.pop();
    if (Array.isArray(command)) {
      if (seen.has(command)) continue;
      seen.add(command);
      for (const child of command) pending.push(child);
      continue;
    }
    if (!record(command) || seen.has(command)) continue;
    seen.add(command);
    if (command.kind === 'transaction') pending.push(command.payload);
    if (command.kind !== 'reference-dimension.add') continue;
    if (
      !record(command.payload) ||
      !isSketchReferenceDimensionData(command.payload.data)
    )
      throw new Error('Reference dimension replay targets are malformed.');
    assertReferenceDataSchema(command.payload.data, document.schemaVersion);
  }
}

/** Call only after validating or dropping unreadable history at the entry boundary. */
export function assertReferenceDocumentSchema(document: ProjectDocument): void {
  assertReferenceCommandSchema(document);
  for (const node of documentNodesWithHistory(document))
    if (node.kind === 'sketch')
      assertSketchReferenceDimensions(node, document.schemaVersion);
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
export function assertSketchReferenceDimensions(
  sketch: SketchNode,
  schemaVersion?: number
) {
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
    assertReferenceDataSchema(reference.data, schemaVersion);
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
  assertSketchReferenceDimensions(
    {
      ...sketch,
      referenceDimensions: [...(sketch.referenceDimensions ?? []), reference]
    },
    document.schemaVersion
  );
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
