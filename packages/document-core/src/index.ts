import {
  createId,
  deepClone,
  featureColor,
  nowIso,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toArtifactId,
  toBodyId,
  toEntityId,
  toFeatureId,
  toParameterId,
  toProjectId,
  toRevisionId,
  toSketchId,
  type BodyId,
  type BodyNode,
  type BooleanOperation,
  type DocumentNode,
  type EntityId,
  type FeatureData,
  type FeatureId,
  type FeatureNode,
  type ParameterId,
  type ParameterNode,
  type ParametricVector3,
  type ParamValue,
  type PlaneId,
  type PrimitiveKind,
  type ProjectDocument,
  type ProjectCheckpoint,
  type RevisionRecord,
  type RevolveAxis,
  type SketchId,
  type SketchNode,
  type SketchObjectData,
  type UnitSystem,
  type UserId
} from '@openzcad/shared';

// Documents are treated as immutable values: every mutating operation in this
// module deep-clones the incoming document before touching it and returns the
// clone. Callers (CommandManager, UI state) may therefore hold references to
// previous documents — including sharing untouched sub-objects produced by the
// shallow-copy helpers below — without risk of aliasing bugs.

/**
 * Pre-generated identifiers for operations that create a feature plus a body.
 * Command factories assign these when the command is created so that the
 * serialized payload replays to the exact same entity graph.
 */
export interface BodyFeatureIds {
  featureId: FeatureId;
  featureNodeId: EntityId;
  bodyId: BodyId;
  bodyNodeId: EntityId;
}

export interface SketchFeatureIds {
  featureId: FeatureId;
  featureNodeId: EntityId;
  sketchId: SketchId;
  sketchNodeId: EntityId;
  objectNodeId: EntityId;
}

export interface FeatureOnlyIds {
  featureId: FeatureId;
  featureNodeId: EntityId;
}

export interface ParameterIds {
  parameterId: ParameterId;
  parameterNodeId: EntityId;
}

export function createBodyFeatureIds(): BodyFeatureIds {
  return {
    featureId: toFeatureId(createId('feat')),
    featureNodeId: toEntityId(createId('ent')),
    bodyId: toBodyId(createId('body')),
    bodyNodeId: toEntityId(createId('ent'))
  };
}

export function createSketchFeatureIds(): SketchFeatureIds {
  return {
    featureId: toFeatureId(createId('feat')),
    featureNodeId: toEntityId(createId('ent')),
    sketchId: toSketchId(createId('sketch')),
    sketchNodeId: toEntityId(createId('ent')),
    objectNodeId: toEntityId(createId('ent'))
  };
}

export function createFeatureOnlyIds(): FeatureOnlyIds {
  return {
    featureId: toFeatureId(createId('feat')),
    featureNodeId: toEntityId(createId('ent'))
  };
}

export function createParameterIds(): ParameterIds {
  return {
    parameterId: toParameterId(createId('param')),
    parameterNodeId: toEntityId(createId('ent'))
  };
}

export interface PrimitiveInput {
  name: string;
  primitiveKind: PrimitiveKind;
  dimensions: Record<string, ParamValue>;
  ids?: BodyFeatureIds;
}

export interface SketchInput {
  name: string;
  plane: PlaneId;
  offset: ParamValue;
  object: SketchObjectData;
  ids?: SketchFeatureIds;
}

export interface SketchUpdateInput {
  sketchId: SketchId;
  plane?: PlaneId;
  offset?: ParamValue;
  object?: SketchObjectData;
}

export interface ExtrudeInput {
  name: string;
  sketchId: SketchId;
  distance: ParamValue;
  ids?: BodyFeatureIds;
}

export interface RevolveInput {
  name: string;
  sketchId: SketchId;
  axis: RevolveAxis;
  ids?: BodyFeatureIds;
}

export interface BooleanInput {
  name: string;
  operation: BooleanOperation;
  targetBodyIds: BodyId[];
  ids?: BodyFeatureIds;
}

export interface TransformInput {
  name: string;
  targetBodyId: BodyId;
  translation: ParametricVector3;
  rotationDeg?: ParametricVector3;
  ids?: FeatureOnlyIds;
}

export interface ImportedMeshInput {
  name: string;
  artifactId: string;
  sourceName: string;
  triangleCount: number;
  vertices: number[];
  indices: number[];
  ids?: BodyFeatureIds;
}

export interface ImportedStepInput {
  name: string;
  artifactId: string;
  sourceName: string;
  stepText: string;
  ids?: BodyFeatureIds;
}

export interface ParameterSetInput {
  name: string;
  expression: string;
  ids?: ParameterIds;
}

export interface ParameterDeleteInput {
  name: string;
}

export interface FeatureUpdateInput {
  featureId: FeatureId;
  name?: string;
  /**
   * Partial patch of the feature's data variant. `featureKind` cannot change;
   * `dimensions` patches merge key-by-key, every other field replaces.
   */
  data?: Partial<FeatureData> & { dimensions?: Record<string, ParamValue> };
}

export interface FeatureDeleteInput {
  featureId: FeatureId;
}

export interface NodeRenameInput {
  nodeId: string;
  name: string;
}

export function createProjectDocument(
  name: string,
  ownerUserId: UserId,
  units: UnitSystem = 'mm'
): ProjectDocument {
  const projectId = toProjectId(createId('proj'));
  const rootNodeId = toEntityId(createId('ent'));
  const rootAssemblyId = toEntityId(createId('ent'));
  const activePartId = toEntityId(createId('ent'));
  const createdAt = nowIso();

  const nodes: Record<string, DocumentNode> = {
    [rootNodeId]: {
      id: rootNodeId,
      kind: 'project',
      name,
      parentId: null,
      revisionId: null,
      projectId,
      units,
      activePartId
    },
    [rootAssemblyId]: {
      id: rootAssemblyId,
      kind: 'assembly',
      name: 'Root Assembly',
      parentId: rootNodeId,
      revisionId: null,
      childIds: [activePartId]
    },
    [activePartId]: {
      id: activePartId,
      kind: 'part',
      name: 'Part 1',
      parentId: rootAssemblyId,
      revisionId: null,
      childIds: []
    }
  };

  const initialRevision: RevisionRecord = {
    revisionId: toRevisionId(createId('rev')),
    createdAt,
    reason: 'Initial document',
    commandCount: 0
  };
  const initialCheckpoint: ProjectCheckpoint = {
    checkpointId: createId('checkpoint'),
    revisionId: initialRevision.revisionId,
    documentVersion: 1,
    createdAt,
    reason: 'Initial document'
  };

  return {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    projectId,
    ownerUserId,
    rootNodeId,
    rootAssemblyId,
    activePartId,
    name,
    units,
    version: 1,
    nodes,
    featureOrder: [],
    bodyOrder: [],
    sketchOrder: [],
    parameterOrder: [],
    revisions: [initialRevision],
    checkpoints: [initialCheckpoint],
    commandLog: [],
    assets: {},
    derived: {
      bodyRepresentations: {},
      exportableBodyIds: [],
      warnings: [],
      updatedAt: createdAt
    }
  };
}

/**
 * Fills in collections that older saved documents may lack, so loading a
 * pre-parametric document does not crash newer code paths.
 */
export function normalizeDocument(document: ProjectDocument): ProjectDocument {
  const revisions = document.revisions ?? [];
  const fallbackRevision = revisions.at(-1);
  const checkpoints =
    document.checkpoints ??
    (fallbackRevision
      ? [
          {
            checkpointId: createId('checkpoint'),
            revisionId: fallbackRevision.revisionId,
            documentVersion: document.version ?? 1,
            createdAt: fallbackRevision.createdAt,
            reason: 'Migrated save point'
          }
        ]
      : []);
  return {
    ...document,
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    parameterOrder: document.parameterOrder ?? [],
    featureOrder: document.featureOrder ?? [],
    bodyOrder: document.bodyOrder ?? [],
    sketchOrder: document.sketchOrder ?? [],
    revisions,
    checkpoints,
    assets: document.assets ?? {}
  };
}

export function cloneDocument(document: ProjectDocument): ProjectDocument {
  return deepClone(document);
}

export function getNode<TNode extends DocumentNode>(
  document: ProjectDocument,
  nodeId: string
): TNode | undefined {
  return document.nodes[nodeId] as TNode | undefined;
}

export function listNodesByKind<TNode extends DocumentNode['kind']>(
  document: ProjectDocument,
  kind: TNode
): Extract<DocumentNode, { kind: TNode }>[] {
  return Object.values(document.nodes).filter(
    (node): node is Extract<DocumentNode, { kind: TNode }> => node.kind === kind
  );
}

export function findFeature(
  document: ProjectDocument,
  featureId: FeatureId
): FeatureNode | undefined {
  return listNodesByKind(document, 'feature').find(
    (feature) => feature.featureId === featureId
  );
}

export function findSketch(
  document: ProjectDocument,
  sketchId: SketchId
): SketchNode | undefined {
  return listNodesByKind(document, 'sketch').find(
    (sketch) => sketch.sketchId === sketchId
  );
}

export function findBodyNode(
  document: ProjectDocument,
  bodyId: BodyId
): BodyNode | undefined {
  return listNodesByKind(document, 'body').find(
    (body) => body.bodyId === bodyId
  );
}

export function listFeaturesInOrder(document: ProjectDocument): FeatureNode[] {
  const features = listNodesByKind(document, 'feature');
  const byId = new Map(features.map((feature) => [feature.featureId, feature]));
  const ordered: FeatureNode[] = [];
  const seen = new Set<FeatureId>();
  for (const featureId of document.featureOrder) {
    const feature = byId.get(featureId);
    if (feature && !seen.has(featureId)) {
      ordered.push(feature);
      seen.add(featureId);
    }
  }
  for (const feature of features) {
    if (!seen.has(feature.featureId)) {
      ordered.push(feature);
    }
  }
  return ordered;
}

function attachToPart(document: ProjectDocument, ...nodeIds: EntityId[]): void {
  const part = getNode(document, document.activePartId);
  if (part && (part.kind === 'part' || part.kind === 'assembly')) {
    part.childIds.push(...nodeIds);
  }
}

export function addPrimitiveFeature(
  document: ProjectDocument,
  input: PrimitiveInput
): ProjectDocument {
  const next = cloneDocument(document);
  const { featureId, featureNodeId, bodyId, bodyNodeId } =
    input.ids ?? createBodyFeatureIds();

  const feature: FeatureNode = {
    id: featureNodeId,
    kind: 'feature',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    featureId,
    bodyId,
    featureKind: 'primitive',
    data: {
      featureKind: 'primitive',
      primitiveKind: input.primitiveKind,
      dimensions: input.dimensions
    }
  };

  const body: BodyNode = {
    id: bodyNodeId,
    kind: 'body',
    name: `${input.name} Body`,
    parentId: next.activePartId,
    revisionId: null,
    bodyId,
    featureId,
    bodyType: 'solid',
    representationSource: 'brep',
    exportableStep: true,
    metadata: { color: featureColor('primitive') }
  };

  next.nodes[feature.id] = feature;
  next.nodes[body.id] = body;
  next.featureOrder.push(featureId);
  next.bodyOrder.push(bodyId);
  attachToPart(next, feature.id, body.id);
  next.version += 1;
  return next;
}

export function addSketchFeature(
  document: ProjectDocument,
  input: SketchInput
): { document: ProjectDocument; sketchId: SketchId } {
  const next = cloneDocument(document);
  const { featureId, featureNodeId, sketchId, sketchNodeId, objectNodeId } =
    input.ids ?? createSketchFeatureIds();

  const sketchNode: SketchNode = {
    id: sketchNodeId,
    kind: 'sketch',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    sketchId,
    plane: input.plane,
    offset: input.offset,
    objectIds: [objectNodeId]
  };

  next.nodes[objectNodeId] = {
    id: objectNodeId,
    kind: 'sketch-object',
    name: `${input.object.objectKind} profile`,
    parentId: sketchNodeId,
    revisionId: null,
    objectKind: input.object.objectKind,
    data: input.object
  };

  next.nodes[sketchNode.id] = sketchNode;
  next.nodes[featureNodeId] = {
    id: featureNodeId,
    kind: 'feature',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    featureId,
    featureKind: 'sketch',
    data: {
      featureKind: 'sketch',
      sketchId
    }
  };

  next.featureOrder.push(featureId);
  next.sketchOrder.push(sketchId);
  attachToPart(next, featureNodeId, sketchNodeId);
  next.version += 1;
  return { document: next, sketchId };
}

export function updateSketch(
  document: ProjectDocument,
  input: SketchUpdateInput
): ProjectDocument {
  const next = cloneDocument(document);
  const sketch = findSketch(next, input.sketchId);
  if (!sketch) {
    throw new Error(`Sketch ${input.sketchId} not found.`);
  }
  if (input.plane !== undefined) {
    sketch.plane = input.plane;
  }
  if (input.offset !== undefined) {
    sketch.offset = input.offset;
  }
  if (input.object !== undefined) {
    const objectId = sketch.objectIds[0];
    const objectNode = objectId ? next.nodes[objectId] : undefined;
    if (!objectNode || objectNode.kind !== 'sketch-object') {
      throw new Error(`Sketch ${input.sketchId} has no profile object.`);
    }
    objectNode.objectKind = input.object.objectKind;
    objectNode.data = input.object;
    objectNode.name = `${input.object.objectKind} profile`;
  }
  next.version += 1;
  return next;
}

export function extrudeSketch(
  document: ProjectDocument,
  input: ExtrudeInput
): { document: ProjectDocument; bodyId: BodyId } {
  const next = cloneDocument(document);
  const { featureId, featureNodeId, bodyId, bodyNodeId } =
    input.ids ?? createBodyFeatureIds();

  next.nodes[featureNodeId] = {
    id: featureNodeId,
    kind: 'feature',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    featureId,
    bodyId,
    featureKind: 'extrude',
    data: {
      featureKind: 'extrude',
      sketchId: input.sketchId,
      distance: input.distance
    }
  };

  next.nodes[bodyNodeId] = {
    id: bodyNodeId,
    kind: 'body',
    name: `${input.name} Body`,
    parentId: next.activePartId,
    revisionId: null,
    bodyId,
    featureId,
    bodyType: 'solid',
    representationSource: 'brep',
    exportableStep: true,
    metadata: { color: featureColor('extrude') }
  };

  next.featureOrder.push(featureId);
  next.bodyOrder.push(bodyId);
  attachToPart(next, featureNodeId, bodyNodeId);
  next.version += 1;
  return { document: next, bodyId };
}

export function revolveSketch(
  document: ProjectDocument,
  input: RevolveInput
): { document: ProjectDocument; bodyId: BodyId } {
  const next = cloneDocument(document);
  const { featureId, featureNodeId, bodyId, bodyNodeId } =
    input.ids ?? createBodyFeatureIds();

  next.nodes[featureNodeId] = {
    id: featureNodeId,
    kind: 'feature',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    featureId,
    bodyId,
    featureKind: 'revolve',
    data: {
      featureKind: 'revolve',
      sketchId: input.sketchId,
      axis: input.axis
    }
  };

  next.nodes[bodyNodeId] = {
    id: bodyNodeId,
    kind: 'body',
    name: `${input.name} Body`,
    parentId: next.activePartId,
    revisionId: null,
    bodyId,
    featureId,
    bodyType: 'solid',
    representationSource: 'brep',
    exportableStep: true,
    metadata: { color: featureColor('revolve') }
  };

  next.featureOrder.push(featureId);
  next.bodyOrder.push(bodyId);
  attachToPart(next, featureNodeId, bodyNodeId);
  next.version += 1;
  return { document: next, bodyId };
}

export function booleanBodies(
  document: ProjectDocument,
  input: BooleanInput
): { document: ProjectDocument; bodyId: BodyId } {
  if (input.targetBodyIds.length < 2) {
    throw new Error('Boolean operations need at least two target bodies.');
  }
  const next = cloneDocument(document);
  const { featureId, featureNodeId, bodyId, bodyNodeId } =
    input.ids ?? createBodyFeatureIds();

  next.nodes[featureNodeId] = {
    id: featureNodeId,
    kind: 'feature',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    featureId,
    bodyId,
    featureKind: 'boolean',
    data: {
      featureKind: 'boolean',
      operation: input.operation,
      targetBodyIds: input.targetBodyIds
    }
  };

  next.nodes[bodyNodeId] = {
    id: bodyNodeId,
    kind: 'body',
    name: `${input.name} Body`,
    parentId: next.activePartId,
    revisionId: null,
    bodyId,
    featureId,
    bodyType: 'solid',
    representationSource: 'brep',
    exportableStep: true,
    metadata: { color: featureColor('boolean') }
  };

  next.featureOrder.push(featureId);
  next.bodyOrder.push(bodyId);
  attachToPart(next, featureNodeId, bodyNodeId);
  next.version += 1;
  return { document: next, bodyId };
}

export function transformBody(
  document: ProjectDocument,
  input: TransformInput
): { document: ProjectDocument; bodyId: BodyId } {
  const next = cloneDocument(document);
  const { featureId, featureNodeId } = input.ids ?? createFeatureOnlyIds();

  next.nodes[featureNodeId] = {
    id: featureNodeId,
    kind: 'feature',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    featureId,
    featureKind: 'transform',
    data: {
      featureKind: 'transform',
      targetBodyId: input.targetBodyId,
      transform: {
        translation: input.translation,
        rotationDeg: input.rotationDeg ?? { x: 0, y: 0, z: 0 }
      }
    }
  };

  next.featureOrder.push(featureId);
  attachToPart(next, featureNodeId);
  next.version += 1;
  return { document: next, bodyId: input.targetBodyId };
}

export function importMeshBody(
  document: ProjectDocument,
  input: ImportedMeshInput
): { document: ProjectDocument; bodyId: BodyId } {
  const next = cloneDocument(document);
  const { featureId, featureNodeId, bodyId, bodyNodeId } =
    input.ids ?? createBodyFeatureIds();

  next.nodes[featureNodeId] = {
    id: featureNodeId,
    kind: 'feature',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    featureId,
    bodyId,
    featureKind: 'imported-mesh',
    data: {
      featureKind: 'imported-mesh',
      artifactId: toArtifactId(input.artifactId),
      sourceName: input.sourceName,
      triangleCount: input.triangleCount,
      vertices: input.vertices,
      indices: input.indices
    }
  };

  next.nodes[bodyNodeId] = {
    id: bodyNodeId,
    kind: 'body',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    bodyId,
    featureId,
    bodyType: 'mesh-reference',
    representationSource: 'mesh-import',
    exportableStep: true,
    metadata: { color: featureColor('imported-mesh') }
  };

  next.featureOrder.push(featureId);
  next.bodyOrder.push(bodyId);
  attachToPart(next, featureNodeId, bodyNodeId);
  next.version += 1;
  return { document: next, bodyId };
}

export function importStepBody(
  document: ProjectDocument,
  input: ImportedStepInput
): { document: ProjectDocument; bodyId: BodyId } {
  const next = cloneDocument(document);
  const { featureId, featureNodeId, bodyId, bodyNodeId } =
    input.ids ?? createBodyFeatureIds();

  next.nodes[featureNodeId] = {
    id: featureNodeId,
    kind: 'feature',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    featureId,
    bodyId,
    featureKind: 'imported-step',
    data: {
      featureKind: 'imported-step',
      artifactId: toArtifactId(input.artifactId),
      sourceName: input.sourceName,
      stepText: input.stepText
    }
  };

  next.nodes[bodyNodeId] = {
    id: bodyNodeId,
    kind: 'body',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    bodyId,
    featureId,
    bodyType: 'solid',
    representationSource: 'step-import',
    exportableStep: true,
    metadata: { color: featureColor('imported-step') }
  };

  next.featureOrder.push(featureId);
  next.bodyOrder.push(bodyId);
  attachToPart(next, featureNodeId, bodyNodeId);
  next.version += 1;
  return { document: next, bodyId };
}

// ---------------------------------------------------------------------------
// Parameters.
// ---------------------------------------------------------------------------

export const PARAMETER_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function isValidParameterName(name: string): boolean {
  return PARAMETER_NAME_PATTERN.test(name) && !RESERVED_IDENTIFIERS.has(name);
}

export function listParameters(document: ProjectDocument): ParameterNode[] {
  const parameters = listNodesByKind(document, 'parameter');
  const byId = new Map(
    parameters.map((parameter) => [parameter.parameterId, parameter])
  );
  const ordered: ParameterNode[] = [];
  const seen = new Set<ParameterId>();
  for (const parameterId of document.parameterOrder) {
    const parameter = byId.get(parameterId);
    if (parameter && !seen.has(parameterId)) {
      ordered.push(parameter);
      seen.add(parameterId);
    }
  }
  for (const parameter of parameters) {
    if (!seen.has(parameter.parameterId)) {
      ordered.push(parameter);
    }
  }
  return ordered;
}

export function setParameter(
  document: ProjectDocument,
  input: ParameterSetInput
): ProjectDocument {
  const name = input.name.trim();
  if (!isValidParameterName(name)) {
    throw new Error(
      `"${name}" is not a valid parameter name (letters, digits, underscore; must not be a built-in).`
    );
  }
  if (input.expression.trim().length === 0) {
    throw new Error('Parameter expression must not be empty.');
  }
  const next = cloneDocument(document);
  const existing = listParameters(next).find(
    (parameter) => parameter.name === name
  );
  if (existing) {
    existing.expression = input.expression;
  } else {
    const { parameterId, parameterNodeId } = input.ids ?? createParameterIds();
    next.nodes[parameterNodeId] = {
      id: parameterNodeId,
      kind: 'parameter',
      name,
      parentId: next.rootNodeId,
      revisionId: null,
      parameterId,
      expression: input.expression,
      value: 0
    };
    next.parameterOrder.push(parameterId);
  }
  refreshParameterValues(next);
  next.version += 1;
  return next;
}

export function deleteParameter(
  document: ProjectDocument,
  input: ParameterDeleteInput
): ProjectDocument {
  const next = cloneDocument(document);
  const parameter = listParameters(next).find(
    (entry) => entry.name === input.name
  );
  if (!parameter) {
    throw new Error(`Parameter "${input.name}" not found.`);
  }
  delete next.nodes[parameter.id];
  next.parameterOrder = next.parameterOrder.filter(
    (id) => id !== parameter.parameterId
  );
  refreshParameterValues(next);
  next.version += 1;
  return next;
}

export interface ParameterScopeResult {
  /** Successfully evaluated parameter values by name. */
  scope: Record<string, number>;
  /** Human-readable evaluation failures, one per broken parameter. */
  errors: string[];
}

/**
 * Evaluates the whole parameter table. Parameters may reference each other in
 * any declaration order; evaluation iterates until a fixed point, so cycles
 * and unknown identifiers surface as per-parameter errors instead of crashes.
 */
export function getParameterScope(
  document: ProjectDocument
): ParameterScopeResult {
  const parameters = listParameters(document);
  const scope: Record<string, number> = {};
  const pending = new Map(
    parameters.map((parameter) => [parameter.name, parameter])
  );
  const errors: string[] = [];

  let progressed = true;
  while (progressed && pending.size > 0) {
    progressed = false;
    for (const [name, parameter] of [...pending]) {
      try {
        scope[name] = evaluateExpression(parameter.expression, scope);
        pending.delete(name);
        progressed = true;
      } catch {
        // Possibly depends on a parameter not yet evaluated; retry next pass.
      }
    }
  }

  for (const [name, parameter] of pending) {
    try {
      evaluateExpression(parameter.expression, scope);
    } catch (error) {
      errors.push(
        `Parameter "${name}": ${error instanceof Error ? error.message : 'evaluation failed.'}`
      );
    }
  }
  return { scope, errors };
}

/** Recomputes the cached `value` field of every parameter node. */
function refreshParameterValues(document: ProjectDocument): void {
  const { scope } = getParameterScope(document);
  for (const parameter of listParameters(document)) {
    const value = scope[parameter.name];
    if (value !== undefined) {
      parameter.value = value;
    }
  }
}

/**
 * Resolves a parametric scalar to a number: literals pass through, strings
 * are evaluated against the parameter scope. Throws with a labelled message
 * on failure so the kernel can attribute errors to a feature input.
 */
export function resolveParamValue(
  value: ParamValue,
  scope: Record<string, number>,
  label?: string
): number {
  try {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new Error('value is not finite.');
      }
      return value;
    }
    return evaluateExpression(value, scope);
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : 'evaluation failed.';
    throw new Error(label ? `${label}: ${reason}` : reason);
  }
}

/** Normalizes raw form input: plain numerics become numbers, otherwise the expression string is kept. */
export function coerceParamValue(raw: string): ParamValue {
  const trimmed = raw.trim();
  const numeric = Number(trimmed);
  return trimmed.length > 0 && Number.isFinite(numeric) ? numeric : trimmed;
}

// ---------------------------------------------------------------------------
// Feature editing.
// ---------------------------------------------------------------------------

export function updateFeature(
  document: ProjectDocument,
  input: FeatureUpdateInput
): ProjectDocument {
  const next = cloneDocument(document);
  const feature = findFeature(next, input.featureId);
  if (!feature) {
    throw new Error(`Feature ${input.featureId} not found.`);
  }
  if (input.name !== undefined && input.name.trim().length > 0) {
    feature.name = input.name.trim();
  }
  if (input.data) {
    const patch = { ...input.data } as Record<string, unknown>;
    if (
      'featureKind' in patch &&
      patch.featureKind !== undefined &&
      patch.featureKind !== feature.featureKind
    ) {
      throw new Error(
        'A feature cannot change kind; delete and recreate it instead.'
      );
    }
    delete patch.featureKind;

    const data = feature.data as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        continue;
      }
      if (key === 'dimensions' && feature.data.featureKind === 'primitive') {
        feature.data.dimensions = {
          ...feature.data.dimensions,
          ...(value as Record<string, ParamValue>)
        };
      } else {
        data[key] = value;
      }
    }
  }
  next.version += 1;
  return next;
}

export function deleteFeature(
  document: ProjectDocument,
  input: FeatureDeleteInput
): ProjectDocument {
  const next = cloneDocument(document);
  const feature = findFeature(next, input.featureId);
  if (!feature) {
    throw new Error(`Feature ${input.featureId} not found.`);
  }

  const removedNodeIds = new Set<string>([feature.id]);

  for (const body of listNodesByKind(next, 'body')) {
    if (body.featureId === feature.featureId) {
      removedNodeIds.add(body.id);
      next.bodyOrder = next.bodyOrder.filter(
        (bodyId) => bodyId !== body.bodyId
      );
    }
  }

  if (feature.data.featureKind === 'sketch') {
    const sketchId = feature.data.sketchId;
    const sketch = findSketch(next, sketchId);
    if (sketch) {
      removedNodeIds.add(sketch.id);
      for (const objectId of sketch.objectIds) {
        removedNodeIds.add(objectId);
      }
    }
    next.sketchOrder = next.sketchOrder.filter((id) => id !== sketchId);
  }

  next.featureOrder = next.featureOrder.filter(
    (id) => id !== feature.featureId
  );
  for (const nodeId of removedNodeIds) {
    delete next.nodes[nodeId];
  }
  for (const node of Object.values(next.nodes)) {
    if (node.kind === 'part' || node.kind === 'assembly') {
      node.childIds = node.childIds.filter(
        (childId) => !removedNodeIds.has(childId)
      );
    }
  }
  next.version += 1;
  return next;
}

export function renameNode(
  document: ProjectDocument,
  input: NodeRenameInput
): ProjectDocument {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new Error('Name must not be empty.');
  }
  const next = cloneDocument(document);
  const node = next.nodes[input.nodeId];
  if (!node) {
    throw new Error(`Node ${input.nodeId} not found.`);
  }
  node.name = name;
  next.version += 1;
  return next;
}

export interface NodeMetadataInput {
  nodeId: string;
  /** Keys set to `null` are removed; other keys are merged into the node. */
  metadata: Record<string, string | number | boolean | null>;
}

/** Merges metadata keys into an existing node (e.g. display color). */
export function setNodeMetadata(
  document: ProjectDocument,
  input: NodeMetadataInput
): ProjectDocument {
  const next = cloneDocument(document);
  const node = next.nodes[input.nodeId];
  if (!node) {
    throw new Error(`Node ${input.nodeId} not found.`);
  }
  const metadata: Record<string, string | number | boolean> = {
    ...node.metadata
  };
  for (const [key, value] of Object.entries(input.metadata)) {
    if (value === null) {
      delete metadata[key];
    } else {
      metadata[key] = value;
    }
  }
  node.metadata = metadata;
  next.version += 1;
  return next;
}

export function appendRevision(
  document: ProjectDocument,
  reason: string
): ProjectDocument {
  // Shallow copy is sufficient: only `revisions` and `version` change, and the
  // shared sub-objects are never mutated in place (see module invariant).
  return {
    ...document,
    revisions: [
      ...document.revisions,
      {
        revisionId: toRevisionId(createId('rev')),
        createdAt: nowIso(),
        reason,
        commandCount: document.commandLog.length
      }
    ],
    version: document.version + 1
  };
}

/** Records a durable save point without changing model or undo semantics. */
export function createCheckpoint(
  document: ProjectDocument,
  reason: string
): ProjectDocument {
  const latestRevision = document.revisions.at(-1);
  if (!latestRevision) {
    throw new Error('Cannot create a checkpoint without a revision.');
  }
  const normalizedReason = reason.trim() || 'Saved';
  const previous = document.checkpoints.at(-1);
  if (
    previous?.documentVersion === document.version &&
    previous.reason === normalizedReason
  ) {
    return document;
  }
  return {
    ...document,
    checkpoints: [
      ...document.checkpoints,
      {
        checkpointId: createId('checkpoint'),
        revisionId: latestRevision.revisionId,
        documentVersion: document.version,
        createdAt: nowIso(),
        reason: normalizedReason
      }
    ]
  };
}

export function attachDerivedState(
  document: ProjectDocument,
  derived: ProjectDocument['derived']
): ProjectDocument {
  // Derived state is a disposable projection; attaching it intentionally does
  // not bump `version`, so consumers can tell model edits from re-derivation.
  return { ...document, derived };
}

export function getLatestSketchId(
  document: ProjectDocument
): SketchId | undefined {
  return document.sketchOrder.at(-1);
}

export function getLatestBodyId(document: ProjectDocument): BodyId | undefined {
  return document.bodyOrder.at(-1);
}

// ---------------------------------------------------------------------------
// Expression evaluation.
// ---------------------------------------------------------------------------

const DEG_TO_RAD = Math.PI / 180;

/** Trigonometry takes degrees — the conventional unit in CAD parameter tables. */
const EXPRESSION_FUNCTIONS: Record<
  string,
  { arity: 'unary' | 'variadic'; apply: (args: number[]) => number }
> = {
  abs: { arity: 'unary', apply: ([a]) => Math.abs(a!) },
  sqrt: { arity: 'unary', apply: ([a]) => Math.sqrt(a!) },
  floor: { arity: 'unary', apply: ([a]) => Math.floor(a!) },
  ceil: { arity: 'unary', apply: ([a]) => Math.ceil(a!) },
  round: { arity: 'unary', apply: ([a]) => Math.round(a!) },
  sin: { arity: 'unary', apply: ([a]) => Math.sin(a! * DEG_TO_RAD) },
  cos: { arity: 'unary', apply: ([a]) => Math.cos(a! * DEG_TO_RAD) },
  tan: { arity: 'unary', apply: ([a]) => Math.tan(a! * DEG_TO_RAD) },
  min: { arity: 'variadic', apply: (args) => Math.min(...args) },
  max: { arity: 'variadic', apply: (args) => Math.max(...args) }
};

const EXPRESSION_CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  PI: Math.PI
};

export const RESERVED_IDENTIFIERS: ReadonlySet<string> = new Set([
  ...Object.keys(EXPRESSION_FUNCTIONS),
  ...Object.keys(EXPRESSION_CONSTANTS)
]);

type ExpressionToken =
  | { type: 'number'; value: number }
  | { type: 'identifier'; name: string }
  | { type: 'operator'; value: '+' | '-' | '*' | '/' | '^' }
  | { type: 'comma' }
  | { type: 'paren'; value: '(' | ')' };

function tokenizeExpression(expression: string): ExpressionToken[] {
  const tokens: ExpressionToken[] = [];
  let index = 0;

  while (index < expression.length) {
    const char = expression[index]!;

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (
      char === '+' ||
      char === '-' ||
      char === '*' ||
      char === '/' ||
      char === '^'
    ) {
      tokens.push({ type: 'operator', value: char });
      index += 1;
      continue;
    }

    if (char === ',') {
      tokens.push({ type: 'comma' });
      index += 1;
      continue;
    }

    if (char === '(' || char === ')') {
      tokens.push({ type: 'paren', value: char });
      index += 1;
      continue;
    }

    const numberMatch = /^(?:\d+\.?\d*|\.\d+)/.exec(expression.slice(index));
    if (numberMatch) {
      tokens.push({ type: 'number', value: Number(numberMatch[0]) });
      index += numberMatch[0].length;
      continue;
    }

    const identifierMatch = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(
      expression.slice(index)
    );
    if (identifierMatch) {
      tokens.push({ type: 'identifier', name: identifierMatch[0] });
      index += identifierMatch[0].length;
      continue;
    }

    throw new Error(`Unexpected character "${char}" in expression.`);
  }

  return tokens;
}

/**
 * Evaluates a parameter expression supporting numbers, scope variables, the
 * `pi` constant, function calls (abs, sqrt, floor, ceil, round, min, max,
 * and degree-based sin/cos/tan), `+ - * / ^`, unary minus, and parentheses.
 * Implemented as a small recursive-descent parser so untrusted expressions
 * are never executed as JavaScript. Throws on syntax errors and unknown
 * identifiers.
 */
export function evaluateExpression(
  expression: string,
  scope: Record<string, number>
): number {
  const tokens = tokenizeExpression(expression);
  let position = 0;

  const peek = (): ExpressionToken | undefined => tokens[position];
  const next = (): ExpressionToken => {
    const token = tokens[position];
    if (!token) {
      throw new Error('Unexpected end of expression.');
    }
    position += 1;
    return token;
  };

  function parseCall(name: string): number {
    const fn = EXPRESSION_FUNCTIONS[name];
    if (!fn) {
      throw new Error(`Unknown function "${name}" in expression.`);
    }
    const args: number[] = [parseAdditive()];
    for (;;) {
      const token = peek();
      if (token?.type === 'comma') {
        position += 1;
        args.push(parseAdditive());
        continue;
      }
      break;
    }
    const closing = next();
    if (closing.type !== 'paren' || closing.value !== ')') {
      throw new Error(`Expected ")" after arguments to ${name}().`);
    }
    if (fn.arity === 'unary' && args.length !== 1) {
      throw new Error(`${name}() expects exactly one argument.`);
    }
    return fn.apply(args);
  }

  function parsePrimary(): number {
    const token = next();
    if (token.type === 'number') {
      return token.value;
    }
    if (token.type === 'identifier') {
      const following = peek();
      if (following?.type === 'paren' && following.value === '(') {
        position += 1;
        return parseCall(token.name);
      }
      const constant = EXPRESSION_CONSTANTS[token.name];
      if (constant !== undefined) {
        return constant;
      }
      const value = scope[token.name];
      if (value === undefined) {
        throw new Error(`Unknown identifier "${token.name}" in expression.`);
      }
      return value;
    }
    if (
      token.type === 'operator' &&
      (token.value === '-' || token.value === '+')
    ) {
      const operand = parsePrimary();
      return token.value === '-' ? -operand : operand;
    }
    if (token.type === 'paren' && token.value === '(') {
      const value = parseAdditive();
      const closing = next();
      if (closing.type !== 'paren' || closing.value !== ')') {
        throw new Error('Expected closing parenthesis in expression.');
      }
      return value;
    }
    throw new Error('Unexpected token in expression.');
  }

  function parsePower(): number {
    const base = parsePrimary();
    const token = peek();
    if (token?.type === 'operator' && token.value === '^') {
      position += 1;
      // Right-associative: 2^3^2 = 2^(3^2).
      return Math.pow(base, parsePower());
    }
    return base;
  }

  function parseMultiplicative(): number {
    let value = parsePower();
    for (;;) {
      const token = peek();
      if (
        token?.type !== 'operator' ||
        (token.value !== '*' && token.value !== '/')
      ) {
        return value;
      }
      position += 1;
      const right = parsePower();
      value = token.value === '*' ? value * right : value / right;
    }
  }

  function parseAdditive(): number {
    let value = parseMultiplicative();
    for (;;) {
      const token = peek();
      if (
        token?.type !== 'operator' ||
        (token.value !== '+' && token.value !== '-')
      ) {
        return value;
      }
      position += 1;
      const right = parseMultiplicative();
      value = token.value === '+' ? value + right : value - right;
    }
  }

  const result = parseAdditive();
  if (position < tokens.length) {
    throw new Error('Unexpected trailing tokens in expression.');
  }
  if (!Number.isFinite(result)) {
    throw new Error('Expression did not evaluate to a finite number.');
  }
  return result;
}
