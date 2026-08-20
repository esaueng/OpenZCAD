import {
  createId,
  deepClone,
  featureColor,
  isProjectCheckpoint,
  isRevisionRecord,
  MAX_PROJECT_CHECKPOINTS,
  MAX_PROJECT_REVISION_RECORDS,
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
  type AxisId,
  type BooleanOperation,
  type DocumentNode,
  type DirectEditOperation,
  type EdgeTopologyReferenceV5,
  type FaceTopologyReferenceV5,
  type EntityId,
  type FeatureData,
  type ExtrudeOperation,
  type FeatureId,
  type FeatureKind,
  type FeatureNode,
  type ImportedSourceReference,
  type ParameterId,
  type ParameterNode,
  type ParametricVector3,
  type ParametricPlane,
  type ParamValue,
  type PatternKind,
  type PlaneId,
  type PrimitiveKind,
  type ProjectDocument,
  type ProjectCheckpoint,
  type RevisionRecord,
  type RevolveAxis,
  type SketchId,
  type SketchNode,
  type SketchObjectData,
  type SketchObjectNode,
  type SketchPlaneRef,
  type SketchProfileReference,
  type SketchSectionReference,
  type SketchPathReference,
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
  /** @deprecated Alias of `objectNodeIds[0]`, retained so v3 command logs replay. */
  objectNodeId: EntityId;
  objectNodeIds: EntityId[];
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

export function createSketchFeatureIds(objectCount = 1): SketchFeatureIds {
  const objectNodeIds = Array.from({ length: Math.max(objectCount, 0) }, () =>
    toEntityId(createId('ent'))
  );
  return {
    featureId: toFeatureId(createId('feat')),
    featureNodeId: toEntityId(createId('ent')),
    sketchId: toSketchId(createId('sketch')),
    sketchNodeId: toEntityId(createId('ent')),
    objectNodeId: objectNodeIds[0] ?? toEntityId(createId('ent')),
    objectNodeIds
  };
}

/** Fills gaps in ids from v3 command payloads, which predate `objectNodeIds`. */
function normalizeSketchFeatureIds(ids: SketchFeatureIds): SketchFeatureIds {
  if (ids.objectNodeIds && ids.objectNodeIds.length > 0) {
    return { ...ids, objectNodeId: ids.objectNodeId ?? ids.objectNodeIds[0]! };
  }
  return { ...ids, objectNodeIds: ids.objectNodeId ? [ids.objectNodeId] : [] };
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
  planeRef?: SketchPlaneRef;
  objects?: SketchObjectData[];
  /** @deprecated v3 payload field; still honored so old command logs replay. */
  plane?: PlaneId;
  /** @deprecated v3 payload field; still honored so old command logs replay. */
  offset?: ParamValue;
  /** @deprecated v3 payload field; still honored so old command logs replay. */
  object?: SketchObjectData;
  ids?: SketchFeatureIds;
}

/** Resolves the v4/v3 dual shape of a sketch payload to its v4 form. */
export function resolveSketchInput(input: SketchInput): {
  planeRef: SketchPlaneRef;
  objects: SketchObjectData[];
} {
  const planeRef: SketchPlaneRef = input.planeRef ?? {
    type: 'canonical',
    plane: input.plane ?? 'XY',
    offset: input.offset ?? 0
  };
  const objects = input.objects ?? (input.object ? [input.object] : []);
  return { planeRef, objects };
}

export interface SketchUpdateInput {
  sketchId: SketchId;
  planeRef?: SketchPlaneRef;
  /** @deprecated v3 payload field; rewrites the canonical planeRef on replay. */
  plane?: PlaneId;
  /** @deprecated v3 payload field; rewrites the canonical planeRef on replay. */
  offset?: ParamValue;
  /** @deprecated v3 payload field; replaces the first object, as v3 did. */
  object?: SketchObjectData;
}

export interface SketchObjectAddInput {
  sketchId: SketchId;
  objects: SketchObjectData[];
  ids?: { objectNodeIds: EntityId[] };
}

export interface SketchObjectUpdateInput {
  sketchId: SketchId;
  objectId: EntityId;
  data: SketchObjectData;
}

export interface SketchObjectDeleteInput {
  sketchId: SketchId;
  objectId: EntityId;
}

export interface ExtrudeInput {
  name: string;
  sketchId: SketchId;
  distance: ParamValue;
  /** Explicitly stored by new clients; absent reads as the legacy new body. */
  operation?: ExtrudeOperation;
  /** Existing live body consumed by an add or cut extrusion. */
  targetBodyId?: BodyId;
  /** Extrude one detected region of the sketch instead of the whole profile. */
  profile?: SketchProfileReference;
  /** Extrude one or more explicitly selected bounded cells. */
  profiles?: SketchProfileReference[];
  ids?: BodyFeatureIds;
}

export interface RevolveInput {
  name: string;
  sketchId: SketchId;
  axis: RevolveAxis;
  /** Sweep angle in degrees, `(0, 360]`. Omitted means a full turn. */
  angleDeg?: ParamValue;
  ids?: BodyFeatureIds;
}

export interface LoftInput {
  name: string;
  sections: SketchSectionReference[];
  mode: 'ruled' | 'smooth';
  ids?: BodyFeatureIds;
}

export interface SweepInput {
  name: string;
  profile: SketchSectionReference;
  path: SketchPathReference;
  mode: 'standard' | 'smooth';
  ids?: BodyFeatureIds;
}

export interface HelicalSweepInput {
  name: string;
  profile: SketchSectionReference;
  axisOrigin: ParametricVector3;
  axisDirection: ParametricVector3;
  radius: ParamValue;
  pitch: ParamValue;
  turns: ParamValue;
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
  /** Uniform scale about the world origin; omitted means 1. */
  scale?: ParamValue;
  ids?: FeatureOnlyIds;
}

export interface MirrorInput {
  name: string;
  targetBodyId: BodyId;
  plane: ParametricPlane;
  ids?: BodyFeatureIds;
}

export interface ShellInput {
  name: string;
  targetBodyId: BodyId;
  openingFaceHashes: number[];
  openingFaceReferences?: FaceTopologyReferenceV5[];
  thickness: ParamValue;
  ids?: BodyFeatureIds;
}

export interface SolidOffsetInput {
  name: string;
  targetBodyId: BodyId;
  distance: ParamValue;
  ids?: BodyFeatureIds;
}

export interface DraftInput {
  name: string;
  targetBodyId: BodyId;
  faceHashes: number[];
  faceReferences?: FaceTopologyReferenceV5[];
  pullDirection: ParametricVector3;
  neutralPoint: ParametricVector3;
  angleDeg: ParamValue;
  ids?: BodyFeatureIds;
}

export interface ThickenInput {
  name: string;
  targetBodyId: BodyId;
  faceHash: number;
  faceReference?: FaceTopologyReferenceV5;
  thickness: ParamValue;
  ids?: BodyFeatureIds;
}

export interface DirectEditInput {
  name: string;
  targetBodyId: BodyId;
  operation: DirectEditOperation;
  ids?: FeatureOnlyIds;
}

export interface EdgeModifierInput {
  name: string;
  targetBodyId: BodyId;
  edgeHashes: number[];
  edgeReferences?: EdgeTopologyReferenceV5[];
  size: ParamValue;
  ids?: BodyFeatureIds;
}

export interface PatternInput {
  name: string;
  targetBodyId: BodyId;
  patternKind: PatternKind;
  count: ParamValue;
  axis: AxisId;
  spacing?: ParamValue;
  angleDeg?: ParamValue;
  ids?: BodyFeatureIds;
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
  /**
   * Embedded form, still written when blob storage is unavailable rather than
   * only by old imports. Exactly one of `stepText`/`stepSourceRef`.
   */
  stepText?: string;
  /** Content-addressed form; the bytes live in the source blob store. */
  stepSourceRef?: ImportedSourceReference;
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
  const revisions = Array.isArray(document.revisions)
    ? document.revisions
        .filter(isRevisionRecord)
        .slice(-MAX_PROJECT_REVISION_RECORDS)
    : [];
  const fallbackRevision = revisions.at(-1);
  const checkpoints = Array.isArray(document.checkpoints)
    ? document.checkpoints
        .slice(-MAX_PROJECT_CHECKPOINTS)
        .filter(isProjectCheckpoint)
    : fallbackRevision
      ? [
          {
            checkpointId: createId('checkpoint'),
            revisionId: fallbackRevision.revisionId,
            documentVersion: document.version ?? 1,
            createdAt: fallbackRevision.createdAt,
            reason: 'Migrated save point'
          }
        ]
      : [];
  let nodes = document.nodes;
  // Schema v3 -> v4: sketches gain planeRef; the legacy plane/offset pair
  // becomes a canonical reference. Additive, so a missed migration degrades
  // (old fields linger) rather than corrupts.
  for (const [nodeId, node] of Object.entries(document.nodes)) {
    if (node.kind !== 'sketch' || node.planeRef !== undefined) {
      continue;
    }
    if (nodes === document.nodes) {
      nodes = { ...document.nodes };
    }
    nodes[nodeId] = {
      ...node,
      planeRef: {
        type: 'canonical',
        plane: node.plane ?? 'XY',
        offset: node.offset ?? 0
      }
    } satisfies SketchNode;
  }
  // Schema v4 -> v5 topology references, v5 -> v6 modeling feature kinds,
  // v6 -> v7 text sketch objects plus entity-wide profile references, and
  // v7 -> v8 advanced modeling feature kinds are all
  // additive. Existing hashes and exact source geometry remain the fail-closed
  // fallback until a feature writes a lineage reference; a v6 document has no
  // text objects and no `all: true` reference, so nothing needs rewriting.
  return {
    ...document,
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    nodes,
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
  // Derived state is a disposable projection the geometry worker rebuilds,
  // and nothing mutates it in place — `attachDerivedState` replaces the whole
  // field. It also carries every body's mesh arrays, so deep-copying it here
  // was the single largest main-thread allocation per command and multiplied
  // through all 100 undo snapshots. Share it by reference and clone the rest.
  const { derived, ...content } = document;
  return { ...deepClone(content), derived };
}

/**
 * An independent copy of `source` under a new project id. The feature tree,
 * parameters, and command log all come across intact — a duplicate is meant to
 * be a branching-off point for a variant, so it has to stay as editable and
 * replayable as the original. Node ids are document-scoped and are therefore
 * kept, which also keeps every intra-document reference valid.
 */
export function duplicateProjectDocument(
  source: ProjectDocument,
  name: string,
  ownerUserId: UserId
): ProjectDocument {
  const copy = cloneDocument(normalizeDocument(source));
  const projectId = toProjectId(createId('proj'));
  const rootNode = copy.nodes[copy.rootNodeId];
  if (rootNode?.kind === 'project') {
    copy.nodes[copy.rootNodeId] = { ...rootNode, projectId, name };
  }
  return createCheckpoint(
    appendRevision(
      {
        ...copy,
        projectId,
        ownerUserId,
        name,
        derived: { ...copy.derived, updatedAt: nowIso() }
      },
      `Duplicated from ${source.name}`
    ),
    `Duplicated from ${source.name}`
  );
}

/**
 * `source` prepared to become an account record under `ownerUserId`, keeping
 * its project id.
 *
 * This is deliberately not `duplicateProjectDocument`: a duplicate is a new
 * project that happens to start from an old one, whereas adoption is the same
 * project gaining an account home. Keeping the id is the whole point — the
 * device already has this document in IndexedDB and shelf metadata filed under
 * it, and minting a new id would strand both and leave the user looking at what
 * appears to be a second copy of their part.
 */
export function adoptProjectDocument(
  source: ProjectDocument,
  ownerUserId: UserId,
  name = source.name
): ProjectDocument {
  const copy = cloneDocument(normalizeDocument(source));
  const rootNode = copy.nodes[copy.rootNodeId];
  if (rootNode?.kind === 'project') {
    copy.nodes[copy.rootNodeId] = { ...rootNode, name };
  }
  const adopted: ProjectDocument = {
    ...copy,
    ownerUserId,
    name,
    derived: { ...copy.derived, updatedAt: nowIso() }
  };
  // A document with no revision at all cannot carry a checkpoint. That should
  // not happen, but adoption is a rescue path for documents this code has never
  // seen, so it declines to be the thing that refuses them.
  return adopted.revisions.length === 0
    ? adopted
    : createCheckpoint(adopted, 'Saved to account');
}

/**
 * `document` without its derived projection. Meshes and exportable-body lists
 * are rebuilt from canonical history on load, so storing or transmitting them
 * costs bytes that buy nothing — and for a dense import they are most of the
 * document. `updatedAt` and `warnings` stay: they are conclusions about the
 * document rather than geometry, and the shelf reads `updatedAt`.
 */
export function withoutDerivedProjection(
  document: ProjectDocument
): ProjectDocument {
  return {
    ...document,
    derived: {
      bodyRepresentations: {},
      exportableBodyIds: [],
      warnings: document.derived.warnings,
      updatedAt: document.derived.updatedAt
    }
  };
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
  const { planeRef, objects } = resolveSketchInput(input);
  const ids = normalizeSketchFeatureIds(
    input.ids ?? createSketchFeatureIds(objects.length)
  );
  const { featureId, featureNodeId, sketchId, sketchNodeId } = ids;
  const objectNodeIds = objects.map(
    (_, index) => ids.objectNodeIds[index] ?? toEntityId(createId('ent'))
  );

  const sketchNode: SketchNode = {
    id: sketchNodeId,
    kind: 'sketch',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    sketchId,
    planeRef,
    objectIds: objectNodeIds
  };

  objects.forEach((object, index) => {
    const objectNodeId = objectNodeIds[index]!;
    next.nodes[objectNodeId] = {
      id: objectNodeId,
      kind: 'sketch-object',
      name: `${object.objectKind} profile`,
      parentId: sketchNodeId,
      revisionId: null,
      objectKind: object.objectKind,
      data: object
    };
  });

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
  if (input.planeRef !== undefined) {
    sketch.planeRef = input.planeRef;
  } else if (input.plane !== undefined || input.offset !== undefined) {
    // v3 payloads patch the canonical plane fields piecemeal.
    const previous =
      sketch.planeRef.type === 'canonical'
        ? sketch.planeRef
        : { type: 'canonical' as const, plane: 'XY' as const, offset: 0 };
    sketch.planeRef = {
      type: 'canonical',
      plane: input.plane ?? previous.plane,
      offset: input.offset ?? previous.offset
    };
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

export interface SketchTranslateInput {
  sketchId: SketchId;
  /** In-plane translation along the sketch plane's U axis. */
  du: number;
  /** In-plane translation along the sketch plane's V axis. */
  dv: number;
  /**
   * Translation along the plane normal. Only a canonical-plane sketch can
   * carry it (as a plane offset change); a frame- or face-attached sketch is
   * bound to its surface, so a non-zero `dn` on one is an error rather than
   * a silently dropped component.
   */
  dn?: number;
}

/**
 * Translates every object of a sketch in plane coordinates, as one edit.
 *
 * This is the document half of dragging a sketch with the move gizmo. Object
 * coordinates may be parameter expressions; a translated axis bakes the
 * resolved number (the same contract as every other direct manipulation),
 * while a zero-delta axis leaves the stored value — expression or number —
 * untouched, so dragging along X does not destroy a `w / 2` on Y.
 *
 * Downstream extrudes survive because profile resolution falls back to
 * source-entity matching when fingerprints move, and text extrudes reference
 * their entity directly.
 */
export function translateSketch(
  document: ProjectDocument,
  input: SketchTranslateInput
): ProjectDocument {
  const { du, dv } = input;
  const dn = input.dn ?? 0;
  if (![du, dv, dn].every(Number.isFinite)) {
    throw new Error('Sketch translation must be finite.');
  }
  const next = cloneDocument(document);
  const sketch = findSketch(next, input.sketchId);
  if (!sketch) {
    throw new Error(`Sketch ${input.sketchId} not found.`);
  }
  if (dn !== 0) {
    if (sketch.planeRef.type !== 'canonical') {
      throw new Error(
        'A face-attached sketch cannot move along its normal; it is bound to its surface.'
      );
    }
    const { scope } = getParameterScope(next);
    sketch.planeRef = {
      ...sketch.planeRef,
      offset:
        resolveParamValue(sketch.planeRef.offset, scope, 'sketch offset') + dn
    };
  }
  if (du !== 0 || dv !== 0) {
    const { scope } = getParameterScope(next);
    const shift = (
      value: ParamValue,
      delta: number,
      label: string
    ): ParamValue =>
      delta === 0 ? value : resolveParamValue(value, scope, label) + delta;
    for (const objectId of sketch.objectIds) {
      const node = next.nodes[objectId];
      if (node?.kind !== 'sketch-object') {
        continue;
      }
      const data = node.data;
      switch (data.objectKind) {
        case 'line':
          node.data = {
            ...data,
            x1: shift(data.x1, du, 'line x1'),
            y1: shift(data.y1, dv, 'line y1'),
            x2: shift(data.x2, du, 'line x2'),
            y2: shift(data.y2, dv, 'line y2')
          };
          break;
        case 'rectangle':
        case 'circle':
        case 'polygon':
        case 'arc':
          node.data = {
            ...data,
            centerX: shift(data.centerX, du, 'center X'),
            centerY: shift(data.centerY, dv, 'center Y')
          };
          break;
        case 'text':
          node.data = {
            ...data,
            x: shift(data.x, du, 'text X'),
            y: shift(data.y, dv, 'text Y')
          };
          break;
      }
    }
  }
  next.version += 1;
  return next;
}

export function addSketchObjects(
  document: ProjectDocument,
  input: SketchObjectAddInput
): { document: ProjectDocument; objectNodeIds: EntityId[] } {
  const next = cloneDocument(document);
  const sketch = findSketch(next, input.sketchId);
  if (!sketch) {
    throw new Error(`Sketch ${input.sketchId} not found.`);
  }
  const objectNodeIds = input.objects.map(
    (_, index) => input.ids?.objectNodeIds[index] ?? toEntityId(createId('ent'))
  );
  input.objects.forEach((object, index) => {
    const objectNodeId = objectNodeIds[index]!;
    next.nodes[objectNodeId] = {
      id: objectNodeId,
      kind: 'sketch-object',
      name: `${object.objectKind} profile`,
      parentId: sketch.id,
      revisionId: null,
      objectKind: object.objectKind,
      data: object
    };
    sketch.objectIds.push(objectNodeId);
  });
  next.version += 1;
  return { document: next, objectNodeIds };
}

function requireSketchObject(
  document: ProjectDocument,
  sketchId: SketchId,
  objectId: EntityId
): { sketch: SketchNode; objectNode: SketchObjectNode } {
  const sketch = findSketch(document, sketchId);
  if (!sketch) {
    throw new Error(`Sketch ${sketchId} not found.`);
  }
  const objectNode = sketch.objectIds.includes(objectId)
    ? document.nodes[objectId]
    : undefined;
  if (!objectNode || objectNode.kind !== 'sketch-object') {
    throw new Error(`Sketch ${sketchId} has no object ${objectId}.`);
  }
  return { sketch, objectNode };
}

export function updateSketchObject(
  document: ProjectDocument,
  input: SketchObjectUpdateInput
): ProjectDocument {
  const next = cloneDocument(document);
  const { objectNode } = requireSketchObject(
    next,
    input.sketchId,
    input.objectId
  );
  objectNode.objectKind = input.data.objectKind;
  objectNode.data = input.data;
  objectNode.name = `${input.data.objectKind} profile`;
  next.version += 1;
  return next;
}

export function deleteSketchObject(
  document: ProjectDocument,
  input: SketchObjectDeleteInput
): ProjectDocument {
  const next = cloneDocument(document);
  const { sketch } = requireSketchObject(next, input.sketchId, input.objectId);
  sketch.objectIds = sketch.objectIds.filter((id) => id !== input.objectId);
  delete next.nodes[input.objectId];
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
      distance: input.distance,
      ...(input.operation === undefined ? {} : { operation: input.operation }),
      ...(input.targetBodyId === undefined
        ? {}
        : { targetBodyId: input.targetBodyId }),
      ...(input.profile ? { profile: input.profile } : {}),
      ...(input.profiles && input.profiles.length > 0
        ? { profiles: input.profiles }
        : {})
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
      axis: input.axis,
      // Written only when asked for. An absent field is a full turn, so a
      // full revolve stays byte-identical to one authored before partial
      // revolve existed — including its ADR-013 semantic lineage.
      ...(input.angleDeg === undefined ? {} : { angleDeg: input.angleDeg })
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

export function loftSections(
  document: ProjectDocument,
  input: LoftInput
): { document: ProjectDocument; bodyId: BodyId } {
  return addBodyResultFeature(
    document,
    input.name,
    'loft',
    {
      featureKind: 'loft',
      sections: deepClone(input.sections),
      mode: input.mode
    },
    input.ids
  );
}

export function sweepProfile(
  document: ProjectDocument,
  input: SweepInput
): { document: ProjectDocument; bodyId: BodyId } {
  return addBodyResultFeature(
    document,
    input.name,
    'sweep',
    {
      featureKind: 'sweep',
      profile: deepClone(input.profile),
      path: deepClone(input.path),
      mode: input.mode
    },
    input.ids
  );
}

export function helicalSweepProfile(
  document: ProjectDocument,
  input: HelicalSweepInput
): { document: ProjectDocument; bodyId: BodyId } {
  return addBodyResultFeature(
    document,
    input.name,
    'helical-sweep',
    {
      featureKind: 'helical-sweep',
      profile: deepClone(input.profile),
      axisOrigin: deepClone(input.axisOrigin),
      axisDirection: deepClone(input.axisDirection),
      radius: input.radius,
      pitch: input.pitch,
      turns: input.turns
    },
    input.ids
  );
}

export function booleanBodies(
  document: ProjectDocument,
  input: BooleanInput
): { document: ProjectDocument; bodyId: BodyId } {
  if (input.targetBodyIds.length < 2) {
    throw new Error('Boolean operations need at least two target bodies.');
  }
  if (new Set(input.targetBodyIds).size !== input.targetBodyIds.length) {
    throw new Error('Boolean operations cannot target the same body twice.');
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
        rotationDeg: input.rotationDeg ?? { x: 0, y: 0, z: 0 },
        ...(input.scale !== undefined ? { scale: input.scale } : {})
      }
    }
  };

  next.featureOrder.push(featureId);
  attachToPart(next, featureNodeId);
  next.version += 1;
  return { document: next, bodyId: input.targetBodyId };
}

/**
 * Append an in-place exact-topology edit. Like a transform, this keeps the
 * target BodyId stable while preserving the imported STEP source earlier in
 * history for deterministic rebuild, undo, and collaboration replay.
 */
export function directEditBody(
  document: ProjectDocument,
  input: DirectEditInput
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
    featureKind: 'direct-edit',
    data: {
      featureKind: 'direct-edit',
      targetBodyId: input.targetBodyId,
      operation: input.operation
    }
  };

  next.featureOrder.push(featureId);
  attachToPart(next, featureNodeId);
  next.version += 1;
  return { document: next, bodyId: input.targetBodyId };
}

function addBodyResultFeature(
  document: ProjectDocument,
  name: string,
  featureKind:
    | 'fillet'
    | 'chamfer'
    | 'pattern'
    | 'mirror'
    | 'shell'
    | 'solid-offset'
    | 'loft'
    | 'sweep'
    | 'helical-sweep'
    | 'draft'
    | 'thicken',
  data: Extract<
    FeatureData,
    {
      featureKind:
        | 'fillet'
        | 'chamfer'
        | 'pattern'
        | 'mirror'
        | 'shell'
        | 'solid-offset'
        | 'loft'
        | 'sweep'
        | 'helical-sweep'
        | 'draft'
        | 'thicken';
    }
  >,
  ids?: BodyFeatureIds
): { document: ProjectDocument; bodyId: BodyId } {
  const next = cloneDocument(document);
  const { featureId, featureNodeId, bodyId, bodyNodeId } =
    ids ?? createBodyFeatureIds();
  next.nodes[featureNodeId] = {
    id: featureNodeId,
    kind: 'feature',
    name,
    parentId: next.activePartId,
    revisionId: null,
    featureId,
    bodyId,
    featureKind,
    data
  };
  next.nodes[bodyNodeId] = {
    id: bodyNodeId,
    kind: 'body',
    name,
    parentId: next.activePartId,
    revisionId: null,
    bodyId,
    featureId,
    bodyType: 'solid',
    representationSource: 'brep',
    exportableStep: true,
    metadata: { color: featureColor(featureKind) }
  };
  next.featureOrder.push(featureId);
  next.bodyOrder.push(bodyId);
  attachToPart(next, featureNodeId, bodyNodeId);
  next.version += 1;
  return { document: next, bodyId };
}

/** Adds an independent mirrored copy; the source body is not consumed. */
export function mirrorBody(
  document: ProjectDocument,
  input: MirrorInput
): { document: ProjectDocument; bodyId: BodyId } {
  return addBodyResultFeature(
    document,
    input.name,
    'mirror',
    {
      featureKind: 'mirror',
      targetBodyId: input.targetBodyId,
      plane: deepClone(input.plane)
    },
    input.ids
  );
}

export function shellBody(
  document: ProjectDocument,
  input: ShellInput
): { document: ProjectDocument; bodyId: BodyId } {
  return addBodyResultFeature(
    document,
    input.name,
    'shell',
    {
      featureKind: 'shell',
      targetBodyId: input.targetBodyId,
      openingFaceHashes: [...new Set(input.openingFaceHashes)],
      ...(input.openingFaceReferences
        ? { openingFaceReferences: deepClone(input.openingFaceReferences) }
        : {}),
      thickness: input.thickness
    },
    input.ids
  );
}

export function offsetSolidBody(
  document: ProjectDocument,
  input: SolidOffsetInput
): { document: ProjectDocument; bodyId: BodyId } {
  return addBodyResultFeature(
    document,
    input.name,
    'solid-offset',
    {
      featureKind: 'solid-offset',
      targetBodyId: input.targetBodyId,
      distance: input.distance
    },
    input.ids
  );
}

export function draftBody(
  document: ProjectDocument,
  input: DraftInput
): { document: ProjectDocument; bodyId: BodyId } {
  return addBodyResultFeature(
    document,
    input.name,
    'draft',
    {
      featureKind: 'draft',
      targetBodyId: input.targetBodyId,
      faceHashes: [...new Set(input.faceHashes)],
      ...(input.faceReferences
        ? { faceReferences: deepClone(input.faceReferences) }
        : {}),
      pullDirection: deepClone(input.pullDirection),
      neutralPoint: deepClone(input.neutralPoint),
      angleDeg: input.angleDeg
    },
    input.ids
  );
}

export function thickenFace(
  document: ProjectDocument,
  input: ThickenInput
): { document: ProjectDocument; bodyId: BodyId } {
  return addBodyResultFeature(
    document,
    input.name,
    'thicken',
    {
      featureKind: 'thicken',
      targetBodyId: input.targetBodyId,
      faceHash: input.faceHash,
      ...(input.faceReference
        ? { faceReference: deepClone(input.faceReference) }
        : {}),
      thickness: input.thickness
    },
    input.ids
  );
}

export function filletEdges(
  document: ProjectDocument,
  input: EdgeModifierInput
): { document: ProjectDocument; bodyId: BodyId } {
  return addBodyResultFeature(
    document,
    input.name,
    'fillet',
    {
      featureKind: 'fillet',
      targetBodyId: input.targetBodyId,
      edgeHashes: [...new Set(input.edgeHashes)],
      ...(input.edgeReferences
        ? { edgeReferences: deepClone(input.edgeReferences) }
        : {}),
      radius: input.size
    },
    input.ids
  );
}

export function chamferEdges(
  document: ProjectDocument,
  input: EdgeModifierInput
): { document: ProjectDocument; bodyId: BodyId } {
  return addBodyResultFeature(
    document,
    input.name,
    'chamfer',
    {
      featureKind: 'chamfer',
      targetBodyId: input.targetBodyId,
      edgeHashes: [...new Set(input.edgeHashes)],
      ...(input.edgeReferences
        ? { edgeReferences: deepClone(input.edgeReferences) }
        : {}),
      distance: input.size
    },
    input.ids
  );
}

export function patternBody(
  document: ProjectDocument,
  input: PatternInput
): { document: ProjectDocument; bodyId: BodyId } {
  return addBodyResultFeature(
    document,
    input.name,
    'pattern',
    {
      featureKind: 'pattern',
      targetBodyId: input.targetBodyId,
      patternKind: input.patternKind,
      count: input.count,
      axis: input.axis,
      spacing: input.spacing ?? 10,
      angleDeg: input.angleDeg ?? 360
    },
    input.ids
  );
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
  if ((input.stepText === undefined) === (input.stepSourceRef === undefined)) {
    throw new Error(
      'A STEP import needs exactly one of stepText and stepSourceRef.'
    );
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
    featureKind: 'imported-step',
    data: {
      featureKind: 'imported-step',
      artifactId: toArtifactId(input.artifactId),
      sourceName: input.sourceName,
      ...(input.stepText !== undefined
        ? { stepText: input.stepText }
        : { stepSourceRef: input.stepSourceRef })
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
    throw new Error(label ? `${label}: ${reason}` : reason, { cause: error });
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

/**
 * Keys a data patch may write, per feature kind — exactly the fields of the
 * corresponding `FeatureData` variant. `featureKind` itself is handled (and
 * rejected on change) separately. Anything else is a payload bug: an
 * unrecognized key written here would persist in the document and replay
 * forever, so it is rejected instead.
 */
const FEATURE_DATA_KEYS: Record<FeatureKind, readonly string[]> = {
  primitive: ['primitiveKind', 'dimensions'],
  sketch: ['sketchId'],
  extrude: [
    'sketchId',
    'distance',
    'operation',
    'targetBodyId',
    'profile',
    'profiles'
  ],
  revolve: ['sketchId', 'axis', 'angleDeg'],
  loft: ['sections', 'mode'],
  sweep: ['profile', 'path', 'mode'],
  'helical-sweep': [
    'profile',
    'axisOrigin',
    'axisDirection',
    'radius',
    'pitch',
    'turns'
  ],
  boolean: ['operation', 'targetBodyIds'],
  transform: ['targetBodyId', 'transform'],
  mirror: ['targetBodyId', 'plane'],
  shell: [
    'targetBodyId',
    'openingFaceHashes',
    'openingFaceReferences',
    'thickness'
  ],
  'solid-offset': ['targetBodyId', 'distance'],
  draft: [
    'targetBodyId',
    'faceHashes',
    'faceReferences',
    'pullDirection',
    'neutralPoint',
    'angleDeg'
  ],
  thicken: ['targetBodyId', 'faceHash', 'faceReference', 'thickness'],
  fillet: ['targetBodyId', 'edgeHashes', 'edgeReferences', 'radius'],
  chamfer: ['targetBodyId', 'edgeHashes', 'edgeReferences', 'distance'],
  pattern: [
    'targetBodyId',
    'patternKind',
    'count',
    'axis',
    'spacing',
    'angleDeg'
  ],
  'direct-edit': ['targetBodyId', 'operation'],
  'imported-step': ['artifactId', 'sourceName', 'stepText', 'stepSourceRef'],
  'imported-mesh': [
    'artifactId',
    'sourceName',
    'triangleCount',
    'vertices',
    'indices'
  ]
};

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

    const allowedKeys = FEATURE_DATA_KEYS[feature.data.featureKind];
    const data = feature.data as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        continue;
      }
      if (!allowedKeys.includes(key)) {
        throw new Error(
          `Feature data key "${key}" is not valid for a ${feature.data.featureKind} feature.`
        );
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
  if (node.kind === 'project') {
    next.name = name;
  }
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
    // Trimming the oldest keeps the array bounded; consumers only read the
    // newest entries and the count, never a trimmed record.
    revisions: [
      ...document.revisions,
      {
        revisionId: toRevisionId(createId('rev')),
        createdAt: nowIso(),
        reason,
        commandCount: document.commandLog.length
      }
    ].slice(-MAX_PROJECT_REVISION_RECORDS),
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
  // Reference repairs are advice to the session that computed them; stripping
  // them here keeps stale repair lists out of saved and replayed documents.
  const { referenceRepairs: _referenceRepairs, ...persisted } = derived;
  return { ...document, derived: persisted };
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

    const numberMatch = /^(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(
      expression.slice(index)
    );
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
      return Math.pow(base, parseUnary());
    }
    return base;
  }

  function parseUnary(): number {
    const token = peek();
    if (
      token?.type === 'operator' &&
      (token.value === '-' || token.value === '+')
    ) {
      position += 1;
      const operand = parseUnary();
      return token.value === '-' ? -operand : operand;
    }
    return parsePower();
  }

  function parseMultiplicative(): number {
    let value = parseUnary();
    for (;;) {
      const token = peek();
      if (
        token?.type !== 'operator' ||
        (token.value !== '*' && token.value !== '/')
      ) {
        return value;
      }
      position += 1;
      const right = parseUnary();
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
