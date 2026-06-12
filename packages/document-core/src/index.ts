import {
  createId,
  deepClone,
  featureColor,
  nowIso,
  toArtifactId,
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
  type EntityId,
  type FeatureId,
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

export interface ConstraintIds {
  constraintNodeId: EntityId;
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

export function createConstraintIds(): ConstraintIds {
  return {
    constraintNodeId: toEntityId(createId('ent'))
  };
}

export interface PrimitiveInput {
  name: string;
  primitiveKind: PrimitiveKind;
  dimensions: Record<string, number>;
  ids?: BodyFeatureIds;
}

export interface SketchInput {
  name: string;
  plane: PlaneId;
  objectKind: SketchObjectKind;
  rectangle?: { width: number; height: number };
  circle?: { radius: number };
  line?: { start: { x: number; y: number }; end: { x: number; y: number } };
  ids?: SketchFeatureIds;
}

export interface ConstraintInput {
  name: string;
  sketchId: SketchId;
  constraintKind: ConstraintKind;
  targetIds: string[];
  value?: number;
  ids?: ConstraintIds;
}

export interface ExtrudeInput {
  name: string;
  sketchId: SketchId;
  distance: number;
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
  translation: { x: number; y: number; z: number };
  rotationDeg?: { x: number; y: number; z: number };
  ids?: FeatureOnlyIds;
}

export interface ImportedMeshInput {
  name: string;
  artifactId: string;
  sourceName: string;
  triangleCount: number;
  ids?: BodyFeatureIds;
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
    nodes,
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
  };
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
  const { featureId, featureNodeId, bodyId, bodyNodeId } =
    input.ids ?? createBodyFeatureIds();
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
    metadata: { color: featureColor('primitive') }
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
  const { featureId, featureNodeId, sketchId, sketchNodeId, objectNodeId } =
    input.ids ?? createSketchFeatureIds();
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

  const { constraintNodeId: constraintId } = input.ids ?? createConstraintIds();
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
  const { featureId, featureNodeId, bodyId, bodyNodeId } =
    input.ids ?? createBodyFeatureIds();
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
    metadata: { color: featureColor('extrude') }
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
  const { featureId, featureNodeId, bodyId, bodyNodeId } =
    input.ids ?? createBodyFeatureIds();
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
    metadata: { color: featureColor('boolean') }
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
  const { featureId, featureNodeId } = input.ids ?? createFeatureOnlyIds();
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
  const { featureId, featureNodeId, bodyId, bodyNodeId } =
    input.ids ?? createBodyFeatureIds();
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
      artifactId: toArtifactId(input.artifactId),
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
    metadata: { color: featureColor('imported-mesh') }
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

export function attachDerivedState(
  document: ProjectDocument,
  derived: ProjectDocument['derived']
): ProjectDocument {
  // Derived state is a disposable projection; attaching it intentionally does
  // not bump `version`, so consumers can tell model edits from re-derivation.
  return { ...document, derived };
}

export function getLatestSketchId(document: ProjectDocument): SketchId | undefined {
  return document.sketchOrder.at(-1);
}

export function getLatestBodyId(document: ProjectDocument): BodyId | undefined {
  return document.bodyOrder.at(-1);
}

type ExpressionToken =
  | { type: 'number'; value: number }
  | { type: 'identifier'; name: string }
  | { type: 'operator'; value: '+' | '-' | '*' | '/' }
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

    if (char === '+' || char === '-' || char === '*' || char === '/') {
      tokens.push({ type: 'operator', value: char });
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

    const identifierMatch = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(expression.slice(index));
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
 * Evaluates a parameter expression supporting numbers, scope variables,
 * `+ - * /`, unary minus, and parentheses. Implemented as a small
 * recursive-descent parser so untrusted expressions are never executed as
 * JavaScript. Throws on syntax errors and unknown identifiers.
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

  function parsePrimary(): number {
    const token = next();
    if (token.type === 'number') {
      return token.value;
    }
    if (token.type === 'identifier') {
      const value = scope[token.name];
      if (value === undefined) {
        throw new Error(`Unknown identifier "${token.name}" in expression.`);
      }
      return value;
    }
    if (token.type === 'operator' && (token.value === '-' || token.value === '+')) {
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

  function parseMultiplicative(): number {
    let value = parsePrimary();
    for (;;) {
      const token = peek();
      if (token?.type !== 'operator' || (token.value !== '*' && token.value !== '/')) {
        return value;
      }
      position += 1;
      const right = parsePrimary();
      value = token.value === '*' ? value * right : value / right;
    }
  }

  function parseAdditive(): number {
    let value = parseMultiplicative();
    for (;;) {
      const token = peek();
      if (token?.type !== 'operator' || (token.value !== '+' && token.value !== '-')) {
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
