import {
  DEFAULT_BODY_COLOR,
  createId,
  deepClone,
  nowIso,
  toBodyId,
  toEntityId,
  toFeatureId,
  toProjectId,
  toRevisionId,
  toSketchId,
  type BodyId,
  type BodyNode,
  type BooleanOperation,
  type ConstraintKind,
  type DocumentNode,
  type FeatureNode,
  type PlaneId,
  type PrimitiveKind,
  type ProjectDocument,
  type RevisionRecord,
  type SketchId,
  type SketchNode,
  type SketchObjectKind,
  type UnitSystem,
  type UserId
} from '@openzcad/shared';

export interface PrimitiveInput {
  name: string;
  primitiveKind: PrimitiveKind;
  dimensions: Record<string, number>;
}

export interface SketchInput {
  name: string;
  plane: PlaneId;
  objectKind: SketchObjectKind;
  rectangle?: { width: number; height: number };
  circle?: { radius: number };
  line?: { start: { x: number; y: number }; end: { x: number; y: number } };
}

export interface ConstraintInput {
  name: string;
  sketchId: SketchId;
  constraintKind: ConstraintKind;
  targetIds: string[];
  value?: number;
}

export interface ExtrudeInput {
  name: string;
  sketchId: SketchId;
  distance: number;
}

export interface BooleanInput {
  name: string;
  operation: BooleanOperation;
  targetBodyIds: BodyId[];
}

export interface TransformInput {
  name: string;
  targetBodyId: BodyId;
  translation: { x: number; y: number; z: number };
  rotationDeg?: { x: number; y: number; z: number };
}

export interface ImportedMeshInput {
  name: string;
  artifactId: string;
  sourceName: string;
  triangleCount: number;
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

  return {
    projectId,
    ownerUserId,
    rootNodeId,
    rootAssemblyId,
    activePartId,
    name,
    units,
    version: 1,
    nodes: nodes as Record<keyof typeof nodes, DocumentNode> as Record<
      string,
      DocumentNode
    >,
    featureOrder: [],
    bodyOrder: [],
    sketchOrder: [],
    revisions: [initialRevision],
    commandLog: [],
    derived: {
      bodyRepresentations: {},
      exportableBodyIds: [],
      warnings: [],
      updatedAt: createdAt
    }
  } as ProjectDocument;
}

export function cloneDocument(document: ProjectDocument): ProjectDocument {
  return deepClone(document);
}

export function getNode<TNode extends DocumentNode>(
  document: ProjectDocument,
  nodeId: string
): TNode | undefined {
  return document.nodes[nodeId as keyof typeof document.nodes] as TNode | undefined;
}

export function listNodesByKind<TNode extends DocumentNode['kind']>(
  document: ProjectDocument,
  kind: TNode
): Extract<DocumentNode, { kind: TNode }>[] {
  return Object.values(document.nodes).filter(
    (node): node is Extract<DocumentNode, { kind: TNode }> => node.kind === kind
  );
}

export function addPrimitiveFeature(
  document: ProjectDocument,
  input: PrimitiveInput
): ProjectDocument {
  const next = cloneDocument(document);
  const featureId = toFeatureId(createId('feat'));
  const featureNodeId = toEntityId(createId('ent'));
  const bodyId = toBodyId(createId('body'));
  const bodyNodeId = toEntityId(createId('ent'));
  const part = getNode(next, next.activePartId);

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
    representationSource: 'mock',
    exportableStep: false,
    metadata: { color: DEFAULT_BODY_COLOR }
  };

  next.nodes[feature.id] = feature;
  next.nodes[body.id] = body;
  next.featureOrder.push(featureId);
  next.bodyOrder.push(bodyId);

  if (part && (part.kind === 'part' || part.kind === 'assembly')) {
    part.childIds.push(feature.id, body.id);
  }

  next.version += 1;
  return next;
}

export function addSketchFeature(
  document: ProjectDocument,
  input: SketchInput
): { document: ProjectDocument; sketchId: SketchId } {
  const next = cloneDocument(document);
  const featureId = toFeatureId(createId('feat'));
  const featureNodeId = toEntityId(createId('ent'));
  const sketchId = toSketchId(createId('sketch'));
  const sketchNodeId = toEntityId(createId('ent'));
  const objectNodeId = toEntityId(createId('ent'));
  const part = getNode(next, next.activePartId);

  const sketchNode: SketchNode = {
    id: sketchNodeId,
    kind: 'sketch',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    sketchId,
    plane: input.plane,
    objectIds: [objectNodeId],
    constraintIds: []
  };

  next.nodes[objectNodeId] = {
    id: objectNodeId,
    kind: 'sketch-object',
    name: `${input.objectKind} profile`,
    parentId: sketchNodeId,
    revisionId: null,
    objectKind: input.objectKind,
    data:
      input.objectKind === 'rectangle'
        ? {
            objectKind: 'rectangle',
            width: input.rectangle?.width ?? 20,
            height: input.rectangle?.height ?? 20
          }
        : input.objectKind === 'circle'
          ? {
              objectKind: 'circle',
              radius: input.circle?.radius ?? 10
            }
          : {
              objectKind: 'line',
              start: input.line?.start ?? { x: 0, y: 0 },
              end: input.line?.end ?? { x: 30, y: 0 }
            }
  };

  next.nodes[sketchNode.id] = sketchNode;
  next.nodes[featureNodeId] = {
    id: featureNodeId,
    kind: 'feature',
    name: `${input.name} Feature`,
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

  if (part && (part.kind === 'part' || part.kind === 'assembly')) {
    part.childIds.push(featureNodeId, sketchNodeId);
  }

  next.version += 1;
  return { document: next, sketchId };
}

export function addConstraint(
  document: ProjectDocument,
  input: ConstraintInput
): ProjectDocument {
  const next = cloneDocument(document);
  const sketch = listNodesByKind(next, 'sketch').find(
    (candidate) => candidate.sketchId === input.sketchId
  );

  if (!sketch) {
    throw new Error(`Sketch ${input.sketchId} not found.`);
  }

  const constraintId = toEntityId(createId('ent'));
  next.nodes[constraintId] = {
    id: constraintId,
    kind: 'constraint',
    name: input.name,
    parentId: sketch.id,
    revisionId: null,
    constraintKind: input.constraintKind,
    targetIds: input.targetIds.map((id) => toEntityId(id)),
    value: input.value
  };
  sketch.constraintIds.push(constraintId);
  next.version += 1;
  return next;
}

export function extrudeSketch(
  document: ProjectDocument,
  input: ExtrudeInput
): { document: ProjectDocument; bodyId: BodyId } {
  const next = cloneDocument(document);
  const featureId = toFeatureId(createId('feat'));
  const featureNodeId = toEntityId(createId('ent'));
  const bodyId = toBodyId(createId('body'));
  const bodyNodeId = toEntityId(createId('ent'));
  const part = getNode(next, next.activePartId);

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
    representationSource: 'mock',
    exportableStep: false,
    metadata: { color: '#4bb7a7' }
  };

  next.featureOrder.push(featureId);
  next.bodyOrder.push(bodyId);
  if (part && (part.kind === 'part' || part.kind === 'assembly')) {
    part.childIds.push(featureNodeId, bodyNodeId);
  }
  next.version += 1;
  return { document: next, bodyId };
}

export function booleanBodies(
  document: ProjectDocument,
  input: BooleanInput
): { document: ProjectDocument; bodyId: BodyId } {
  const next = cloneDocument(document);
  const featureId = toFeatureId(createId('feat'));
  const featureNodeId = toEntityId(createId('ent'));
  const bodyId = toBodyId(createId('body'));
  const bodyNodeId = toEntityId(createId('ent'));
  const part = getNode(next, next.activePartId);

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
    name: `${input.name} Result`,
    parentId: next.activePartId,
    revisionId: null,
    bodyId,
    featureId,
    bodyType: 'solid',
    representationSource: 'composite',
    exportableStep: false,
    metadata: { color: '#ff7452' }
  };

  next.featureOrder.push(featureId);
  next.bodyOrder.push(bodyId);
  if (part && (part.kind === 'part' || part.kind === 'assembly')) {
    part.childIds.push(featureNodeId, bodyNodeId);
  }
  next.version += 1;
  return { document: next, bodyId };
}

export function transformBody(
  document: ProjectDocument,
  input: TransformInput
): { document: ProjectDocument; bodyId: BodyId } {
  const next = cloneDocument(document);
  const featureId = toFeatureId(createId('feat'));
  const featureNodeId = toEntityId(createId('ent'));
  const part = getNode(next, next.activePartId);

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
  if (part && (part.kind === 'part' || part.kind === 'assembly')) {
    part.childIds.push(featureNodeId);
  }
  next.version += 1;
  return { document: next, bodyId: input.targetBodyId };
}

export function importMeshBody(
  document: ProjectDocument,
  input: ImportedMeshInput
): { document: ProjectDocument; bodyId: BodyId } {
  const next = cloneDocument(document);
  const featureId = toFeatureId(createId('feat'));
  const featureNodeId = toEntityId(createId('ent'));
  const bodyId = toBodyId(createId('body'));
  const bodyNodeId = toEntityId(createId('ent'));
  const part = getNode(next, next.activePartId);

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
      artifactId: input.artifactId as never,
      sourceName: input.sourceName,
      triangleCount: input.triangleCount
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
    representationSource: 'mesh-reference',
    exportableStep: false,
    metadata: { color: '#7aa3ff' }
  };

  next.featureOrder.push(featureId);
  next.bodyOrder.push(bodyId);
  if (part && (part.kind === 'part' || part.kind === 'assembly')) {
    part.childIds.push(featureNodeId, bodyNodeId);
  }
  next.version += 1;
  return { document: next, bodyId };
}

export function appendRevision(
  document: ProjectDocument,
  reason: string
): ProjectDocument {
  const next = cloneDocument(document);
  next.revisions.push({
    revisionId: toRevisionId(createId('rev')),
    createdAt: nowIso(),
    reason,
    commandCount: next.commandLog.length
  });
  next.version += 1;
  return next;
}

export function attachDerivedState(
  document: ProjectDocument,
  derived: ProjectDocument['derived']
): ProjectDocument {
  const next = cloneDocument(document);
  next.derived = derived;
  return next;
}

export function getLatestSketchId(document: ProjectDocument): SketchId | undefined {
  return document.sketchOrder.at(-1);
}

export function getLatestBodyId(document: ProjectDocument): BodyId | undefined {
  return document.bodyOrder.at(-1);
}

export function evaluateExpression(
  expression: string,
  scope: Record<string, number>
): number {
  const normalized = expression.replace(/[^0-9+\-*/()._ a-zA-Z]/g, '');
  const argNames = Object.keys(scope);
  const argValues = Object.values(scope);
  return Function(...argNames, `return (${normalized});`)(...argValues) as number;
}
