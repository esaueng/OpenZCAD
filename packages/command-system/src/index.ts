import {
  createId,
  deepClone,
  nowIso,
  toEntityId,
  type BodyId,
  type ParamValue,
  type ProjectDocument,
  type SerializedCommand
} from '@openzcad/shared';
import {
  addPrimitiveFeature,
  addSketchFeature,
  addSketchObjects,
  deleteSketchObject,
  resolveSketchInput,
  updateSketchObject,
  appendRevision,
  attachDerivedState,
  booleanBodies,
  chamferEdges,
  createBodyFeatureIds,
  createFeatureOnlyIds,
  createParameterIds,
  createSketchFeatureIds,
  deleteFeature,
  directEditBody,
  deleteParameter,
  evaluateExpression,
  extrudeSketch,
  filletEdges,
  findFeature,
  findSketch,
  getParameterScope,
  isValidParameterName,
  importMeshBody,
  importStepBody,
  patternBody,
  renameNode,
  resolveParamValue,
  revolveSketch,
  setNodeMetadata,
  setParameter,
  transformBody,
  updateFeature,
  updateSketch,
  type BooleanInput,
  type DirectEditInput,
  type ExtrudeInput,
  type EdgeModifierInput,
  type FeatureDeleteInput,
  type FeatureUpdateInput,
  type ImportedMeshInput,
  type ImportedStepInput,
  type NodeMetadataInput,
  type NodeRenameInput,
  type ParameterDeleteInput,
  type ParameterSetInput,
  type PatternInput,
  type PrimitiveInput,
  type RevolveInput,
  type SketchInput,
  type SketchObjectAddInput,
  type SketchObjectDeleteInput,
  type SketchObjectUpdateInput,
  type SketchUpdateInput,
  type TransformInput
} from '@openzcad/document-core';
import {
  isLocalBodyRef,
  normalizeLocalId,
  type CadPatchProposal
} from '@openzcad/ai-contracts';

export type CommandKind =
  | 'primitive.add'
  | 'sketch.add'
  | 'sketch.update'
  | 'sketch.object.add'
  | 'sketch.object.update'
  | 'sketch.object.delete'
  | 'feature.extrude'
  | 'feature.revolve'
  | 'feature.boolean'
  | 'feature.transform'
  | 'feature.direct-edit'
  | 'feature.fillet'
  | 'feature.chamfer'
  | 'feature.pattern'
  | 'feature.update'
  | 'feature.delete'
  | 'parameter.set'
  | 'parameter.delete'
  | 'import.mesh'
  | 'import.step'
  | 'node.rename'
  | 'node.metadata.set';

export interface CommandDefinition<TPayload> {
  kind: CommandKind;
  label: string;
  replayVersion: number;
  payload: TPayload;
  validate(document: ProjectDocument): void;
  apply(document: ProjectDocument): ProjectDocument;
  serialize(): SerializedCommand<TPayload>;
}

interface HistoryEntry {
  /** Document state to restore when this entry is popped. */
  snapshot: ProjectDocument;
  command: SerializedCommand;
}

export type AnyCommand =
  | CommandDefinition<PrimitiveInput>
  | CommandDefinition<SketchInput>
  | CommandDefinition<SketchUpdateInput>
  | CommandDefinition<SketchObjectAddInput>
  | CommandDefinition<SketchObjectUpdateInput>
  | CommandDefinition<SketchObjectDeleteInput>
  | CommandDefinition<ExtrudeInput>
  | CommandDefinition<RevolveInput>
  | CommandDefinition<BooleanInput>
  | CommandDefinition<TransformInput>
  | CommandDefinition<DirectEditInput>
  | CommandDefinition<EdgeModifierInput>
  | CommandDefinition<PatternInput>
  | CommandDefinition<FeatureUpdateInput>
  | CommandDefinition<FeatureDeleteInput>
  | CommandDefinition<ParameterSetInput>
  | CommandDefinition<ParameterDeleteInput>
  | CommandDefinition<ImportedMeshInput>
  | CommandDefinition<ImportedStepInput>
  | CommandDefinition<NodeRenameInput>
  | CommandDefinition<NodeMetadataInput>;

function makeCommand<TPayload>(
  kind: CommandKind,
  label: string,
  payload: TPayload,
  apply: (document: ProjectDocument) => ProjectDocument,
  validate: (document: ProjectDocument) => void = () => {}
): CommandDefinition<TPayload> {
  return {
    kind,
    label,
    replayVersion: 1,
    payload,
    validate,
    apply,
    serialize() {
      return {
        kind,
        payload,
        replayVersion: 1,
        label,
        timestamp: nowIso()
      };
    }
  };
}

function validateBodyTarget(document: ProjectDocument, bodyId: BodyId): void {
  if (!document.bodyOrder.includes(bodyId)) {
    throw new Error(`Target body ${bodyId} not found.`);
  }
}

// Every factory resolves the IDs the operation will create *before* the
// command is serialized, so replaying a command log rebuilds the exact same
// entity graph. Without this, commands that reference earlier results
// (extrude -> sketch, boolean/transform -> bodies) would dangle on replay.
export const commandFactories = {
  addPrimitive(payload: PrimitiveInput): CommandDefinition<PrimitiveInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand(
      'primitive.add',
      `Add ${payload.primitiveKind}`,
      withIds,
      (document) => addPrimitiveFeature(document, withIds)
    );
  },
  addSketch(payload: SketchInput): CommandDefinition<SketchInput> {
    const { objects } = resolveSketchInput(payload);
    const withIds = {
      ...payload,
      ids: payload.ids ?? createSketchFeatureIds(Math.max(objects.length, 1))
    };
    const label =
      objects.length === 1
        ? `Add ${objects[0]!.objectKind} sketch`
        : 'Add sketch';
    return makeCommand(
      'sketch.add',
      label,
      withIds,
      (document) => addSketchFeature(document, withIds).document
    );
  },
  addSketchObjects(
    payload: SketchObjectAddInput,
    label = 'Add sketch geometry'
  ): CommandDefinition<SketchObjectAddInput> {
    const withIds = {
      ...payload,
      ids: payload.ids ?? {
        objectNodeIds: payload.objects.map(() => toEntityId(createId('ent')))
      }
    };
    return makeCommand(
      'sketch.object.add',
      label,
      withIds,
      (document) => addSketchObjects(document, withIds).document,
      (document) => {
        if (!findSketch(document, payload.sketchId)) {
          throw new Error(`Sketch ${payload.sketchId} not found.`);
        }
      }
    );
  },
  updateSketchObject(
    payload: SketchObjectUpdateInput,
    label = 'Edit sketch geometry'
  ): CommandDefinition<SketchObjectUpdateInput> {
    return makeCommand(
      'sketch.object.update',
      label,
      payload,
      (document) => updateSketchObject(document, payload),
      (document) => {
        if (!findSketch(document, payload.sketchId)) {
          throw new Error(`Sketch ${payload.sketchId} not found.`);
        }
      }
    );
  },
  deleteSketchObject(
    payload: SketchObjectDeleteInput,
    label = 'Delete sketch geometry'
  ): CommandDefinition<SketchObjectDeleteInput> {
    return makeCommand(
      'sketch.object.delete',
      label,
      payload,
      (document) => deleteSketchObject(document, payload),
      (document) => {
        if (!findSketch(document, payload.sketchId)) {
          throw new Error(`Sketch ${payload.sketchId} not found.`);
        }
      }
    );
  },
  updateSketch(
    payload: SketchUpdateInput,
    label = 'Edit sketch'
  ): CommandDefinition<SketchUpdateInput> {
    return makeCommand(
      'sketch.update',
      label,
      payload,
      (document) => updateSketch(document, payload),
      (document) => {
        if (!findSketch(document, payload.sketchId)) {
          throw new Error(`Sketch ${payload.sketchId} not found.`);
        }
      }
    );
  },
  extrudeSketch(payload: ExtrudeInput): CommandDefinition<ExtrudeInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand(
      'feature.extrude',
      'Extrude sketch',
      withIds,
      (document) => extrudeSketch(document, withIds).document,
      (document) => {
        if (!findSketch(document, payload.sketchId)) {
          throw new Error('Extrude requires an existing sketch.');
        }
      }
    );
  },
  revolveSketch(payload: RevolveInput): CommandDefinition<RevolveInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand(
      'feature.revolve',
      'Revolve sketch',
      withIds,
      (document) => revolveSketch(document, withIds).document,
      (document) => {
        if (!findSketch(document, payload.sketchId)) {
          throw new Error('Revolve requires an existing sketch.');
        }
      }
    );
  },
  booleanBodies(payload: BooleanInput): CommandDefinition<BooleanInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand(
      'feature.boolean',
      `Boolean ${payload.operation}`,
      withIds,
      (document) => booleanBodies(document, withIds).document,
      (document) => {
        const known = new Set(document.bodyOrder);
        for (const bodyId of payload.targetBodyIds) {
          if (!known.has(bodyId)) {
            throw new Error(`Boolean target body ${bodyId} not found.`);
          }
        }
      }
    );
  },
  transformBody(payload: TransformInput): CommandDefinition<TransformInput> {
    const withIds = { ...payload, ids: payload.ids ?? createFeatureOnlyIds() };
    return makeCommand(
      'feature.transform',
      'Transform body',
      withIds,
      (document) => transformBody(document, withIds).document,
      (document) => {
        if (!document.bodyOrder.includes(payload.targetBodyId)) {
          throw new Error(
            `Transform target body ${payload.targetBodyId} not found.`
          );
        }
      }
    );
  },
  directEditBody(payload: DirectEditInput): CommandDefinition<DirectEditInput> {
    const withIds = { ...payload, ids: payload.ids ?? createFeatureOnlyIds() };
    return makeCommand(
      'feature.direct-edit',
      payload.name,
      withIds,
      (document) => directEditBody(document, withIds).document,
      (document) => validateBodyTarget(document, payload.targetBodyId)
    );
  },
  filletEdges(
    payload: EdgeModifierInput
  ): CommandDefinition<EdgeModifierInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand(
      'feature.fillet',
      'Fillet edges',
      withIds,
      (document) => filletEdges(document, withIds).document,
      (document) => validateBodyTarget(document, payload.targetBodyId)
    );
  },
  chamferEdges(
    payload: EdgeModifierInput
  ): CommandDefinition<EdgeModifierInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand(
      'feature.chamfer',
      'Chamfer edges',
      withIds,
      (document) => chamferEdges(document, withIds).document,
      (document) => validateBodyTarget(document, payload.targetBodyId)
    );
  },
  patternBody(payload: PatternInput): CommandDefinition<PatternInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand(
      'feature.pattern',
      `${payload.patternKind === 'linear' ? 'Linear' : 'Circular'} pattern`,
      withIds,
      (document) => patternBody(document, withIds).document,
      (document) => validateBodyTarget(document, payload.targetBodyId)
    );
  },
  updateFeature(
    payload: FeatureUpdateInput,
    label = 'Edit feature'
  ): CommandDefinition<FeatureUpdateInput> {
    return makeCommand(
      'feature.update',
      label,
      payload,
      (document) => updateFeature(document, payload),
      (document) => {
        if (!findFeature(document, payload.featureId)) {
          throw new Error(`Feature ${payload.featureId} not found.`);
        }
      }
    );
  },
  deleteFeature(
    payload: FeatureDeleteInput,
    label = 'Delete feature'
  ): CommandDefinition<FeatureDeleteInput> {
    return makeCommand(
      'feature.delete',
      label,
      payload,
      (document) => deleteFeature(document, payload),
      (document) => {
        if (!findFeature(document, payload.featureId)) {
          throw new Error(`Feature ${payload.featureId} not found.`);
        }
      }
    );
  },
  setParameter(
    payload: ParameterSetInput
  ): CommandDefinition<ParameterSetInput> {
    const withIds = { ...payload, ids: payload.ids ?? createParameterIds() };
    return makeCommand(
      'parameter.set',
      `Set parameter ${payload.name}`,
      withIds,
      (document) => setParameter(document, withIds)
    );
  },
  deleteParameter(
    payload: ParameterDeleteInput
  ): CommandDefinition<ParameterDeleteInput> {
    return makeCommand(
      'parameter.delete',
      `Delete parameter ${payload.name}`,
      payload,
      (document) => deleteParameter(document, payload)
    );
  },
  importMesh(payload: ImportedMeshInput): CommandDefinition<ImportedMeshInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand(
      'import.mesh',
      'Import STL mesh',
      withIds,
      (document) => importMeshBody(document, withIds).document
    );
  },
  importStep(payload: ImportedStepInput): CommandDefinition<ImportedStepInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand(
      'import.step',
      'Import editable STEP solid',
      withIds,
      (document) => importStepBody(document, withIds).document
    );
  },
  renameNode(payload: NodeRenameInput): CommandDefinition<NodeRenameInput> {
    return makeCommand(
      'node.rename',
      `Rename to ${payload.name}`,
      payload,
      (document) => renameNode(document, payload)
    );
  },
  setNodeMetadata(
    payload: NodeMetadataInput,
    label = 'Edit properties'
  ): CommandDefinition<NodeMetadataInput> {
    return makeCommand('node.metadata.set', label, payload, (document) =>
      setNodeMetadata(document, payload)
    );
  }
};

function assertParameterName(name: string): void {
  // document-core also rejects the built-in identifiers (pi, min, round, ...),
  // which setParameter would otherwise throw on mid-transaction.
  if (!isValidParameterName(name)) {
    throw new Error(
      `Parameter name "${name}" is not usable: use letters, digits, and underscores, and avoid the built-in names.`
    );
  }
}

/**
 * Resolves the parameter values this proposal will produce, so the rest of the
 * patch can be checked against real numbers.
 *
 * `setParameter` stores any string verbatim, and a broken expression only
 * surfaces later as a non-fatal build warning whose body silently goes missing.
 * A proposal is machine-authored, so reject it at conversion time instead.
 *
 * Parameters may reference each other in any order, so this mirrors
 * getParameterScope's fixed-point pass over the proposal's own parameters
 * layered on the document's. Anything still unresolved afterwards is a genuine
 * fault — an unknown identifier, a non-finite result, or a reference cycle —
 * and re-evaluating it surfaces the real reason.
 */
function projectedParameterScope(
  document: ProjectDocument,
  proposal: CadPatchProposal
): Record<string, number> {
  const scope: Record<string, number> = {
    ...getParameterScope(document).scope
  };
  const pending = new Map<string, string>();
  for (const operation of proposal.operations) {
    if (operation.kind === 'set_parameter') {
      assertParameterName(operation.name);
      pending.set(operation.name, operation.expression);
    }
  }

  let progressed = true;
  while (progressed && pending.size > 0) {
    progressed = false;
    for (const [name, expression] of [...pending]) {
      try {
        scope[name] = evaluateExpression(expression, scope);
        pending.delete(name);
        progressed = true;
      } catch {
        // May depend on a parameter this proposal has not resolved yet.
      }
    }
  }

  for (const [name, expression] of pending) {
    let reason = 'evaluation failed.';
    try {
      evaluateExpression(expression, scope);
    } catch (error) {
      reason = error instanceof Error ? error.message : reason;
    }
    // An identifier that is unresolved only because it is another stuck
    // parameter means the proposal's parameters reference each other in a loop,
    // which reads very differently from a name that simply does not exist.
    const cyclic = [...pending.keys()].some((other) =>
      reason.includes(`"${other}"`)
    );
    throw new Error(
      cyclic
        ? `Parameter "${name}" cannot be resolved: its expression "${expression}" depends on itself through another parameter.`
        : `Parameter "${name}" has an invalid expression "${expression}": ${reason}`
    );
  }
  return scope;
}

/**
 * Uses the same resolver the kernel uses, so the boundary check accepts exactly
 * what the build will accept — `evaluateExpression` alone would let a non-finite
 * result through and fail later with the body silently missing.
 */
function assertEvaluableExpression(
  scope: Record<string, number>,
  label: string,
  value: ParamValue
): void {
  try {
    resolveParamValue(value, scope, label);
  } catch (error) {
    throw new Error(
      `${label} has an invalid expression "${String(value)}": ${
        error instanceof Error ? error.message : 'evaluation failed.'
      }`,
      { cause: error }
    );
  }
}

/**
 * Every ParamValue an operation carries may be an expression string, and an
 * unreadable one is accepted verbatim by document-core — the body then silently
 * fails to build and leaves only a warning. Check them all up front.
 */
function assertOperationExpressions(
  operation: CadPatchProposal['operations'][number],
  scope: Record<string, number>
): void {
  const vector = (
    label: string,
    value: { x: ParamValue; y: ParamValue; z: ParamValue }
  ) => {
    assertEvaluableExpression(scope, `${label}.x`, value.x);
    assertEvaluableExpression(scope, `${label}.y`, value.y);
    assertEvaluableExpression(scope, `${label}.z`, value.z);
  };

  switch (operation.kind) {
    // set_parameter is already resolved and checked by projectedParameterScope.
    case 'set_feature_dimension':
      assertEvaluableExpression(
        scope,
        `${operation.field} on ${operation.featureId}`,
        operation.value
      );
      break;
    case 'add_primitive':
      for (const [field, value] of Object.entries(operation.dimensions)) {
        if (value !== null) {
          assertEvaluableExpression(scope, `${operation.name} ${field}`, value);
        }
      }
      break;
    case 'add_extrude':
      assertEvaluableExpression(
        scope,
        `${operation.name} distance`,
        operation.distance
      );
      break;
    case 'add_transform':
      vector(`${operation.name} translation`, operation.translation);
      vector(`${operation.name} rotationDeg`, operation.rotationDeg);
      break;
    case 'add_edge_modifier':
      assertEvaluableExpression(
        scope,
        `${operation.name} size`,
        operation.size
      );
      break;
    case 'add_pattern':
      assertEvaluableExpression(
        scope,
        `${operation.name} count`,
        operation.count
      );
      assertEvaluableExpression(
        scope,
        `${operation.name} spacing`,
        operation.spacing
      );
      assertEvaluableExpression(
        scope,
        `${operation.name} angleDeg`,
        operation.angleDeg
      );
      break;
    default:
      break;
  }
}

/**
 * Resolves the `$localId` aliases an AI proposal uses to reference bodies it
 * creates within that same proposal.
 *
 * Body-creating factories accept pre-assigned ids, so the real `BodyId` is
 * known at command-construction time and can be handed to later operations.
 * Aliases are resolved here and never reach a serialized payload, which keeps
 * the command log, replay, and undo free of AI-only concepts.
 */
class LocalBodyScope {
  private readonly aliases = new Map<string, BodyId>();
  private readonly consumed = new Map<BodyId, string>();

  constructor(private readonly document: ProjectDocument) {
    // Consumption is not limited to this proposal: a body an earlier turn's
    // boolean absorbed is still listed in bodyOrder and would otherwise pass
    // every check here.
    for (const [bodyId, body] of Object.entries(
      document.derived.bodyRepresentations
    )) {
      if (body.consumed) {
        this.consumed.set(bodyId as BodyId, 'feature');
      }
    }
  }

  declare(localId: string | null | undefined, bodyId: BodyId): void {
    if (typeof localId !== 'string') {
      return;
    }
    const alias = normalizeLocalId(localId);
    // The contract validator rejects duplicates too, but this function is also
    // called directly, and a silent last-writer-wins rebind would retarget an
    // already-resolved reference at the wrong body.
    if (this.aliases.has(alias)) {
      throw new Error(`Duplicate localId "${alias}" in proposal.`);
    }
    this.aliases.set(alias, bodyId);
  }

  /** Accepts an existing digest bodyId or a `$alias` declared earlier. */
  resolve(reference: string): BodyId {
    if (!isLocalBodyRef(reference)) {
      return reference as BodyId;
    }
    const alias = normalizeLocalId(reference);
    const bodyId = this.aliases.get(alias);
    if (!bodyId) {
      throw new Error(
        `Proposal references "${reference}" but no earlier operation creates that body.`
      );
    }
    return bodyId;
  }

  /**
   * Booleans, edge modifiers, and patterns all consume their target: the body
   * is gone from the result, so re-targeting it afterwards silently models the
   * wrong thing. Reject it up front and name the operation that consumed it.
   */
  assertLive(bodyId: BodyId, reference: string): void {
    const consumedBy = this.consumed.get(bodyId);
    if (consumedBy) {
      throw new Error(
        `Body "${reference}" was already consumed by an earlier ${consumedBy} in this proposal.`
      );
    }
  }

  consume(bodyIds: BodyId[], operationKind: string): void {
    bodyIds.forEach((bodyId) => this.consumed.set(bodyId, operationKind));
  }

  /** Guards against a reference to a body that is not in the document either. */
  assertKnown(bodyId: BodyId, reference: string): void {
    if (isLocalBodyRef(reference)) {
      return;
    }
    if (!this.document.bodyOrder.includes(bodyId)) {
      throw new Error(`Target body ${reference} not found in the document.`);
    }
  }
}

/** Converts a reviewed AI proposal into normal undoable document commands. */
export function commandsForCadPatch(
  document: ProjectDocument,
  proposal: CadPatchProposal
): AnyCommand[] {
  const scope = new LocalBodyScope(document);
  const parameterScope = projectedParameterScope(document, proposal);
  proposal.operations.forEach((operation) =>
    assertOperationExpressions(operation, parameterScope)
  );

  const resolveBody = (reference: string): BodyId => {
    const bodyId = scope.resolve(reference);
    scope.assertKnown(bodyId, reference);
    scope.assertLive(bodyId, reference);
    return bodyId;
  };

  return proposal.operations.map((operation) => {
    switch (operation.kind) {
      case 'set_parameter':
        return commandFactories.setParameter({
          name: operation.name,
          expression: operation.expression
        });
      case 'add_primitive': {
        const dimensions = Object.fromEntries(
          Object.entries(operation.dimensions).filter(
            (entry) => entry[1] !== null
          )
        ) as Record<string, string | number>;
        const ids = createBodyFeatureIds();
        scope.declare(operation.localId, ids.bodyId);
        return commandFactories.addPrimitive({
          name: operation.name,
          primitiveKind: operation.primitiveKind,
          dimensions,
          ids
        });
      }
      case 'delete_feature':
        return commandFactories.deleteFeature({
          featureId: operation.featureId
        });
      case 'rename_feature': {
        const feature = findFeature(document, operation.featureId);
        if (!feature) {
          throw new Error(`Feature ${operation.featureId} not found.`);
        }
        return commandFactories.renameNode({
          nodeId: feature.id,
          name: operation.name
        });
      }
      case 'add_extrude': {
        const ids = createBodyFeatureIds();
        scope.declare(operation.localId, ids.bodyId);
        return commandFactories.extrudeSketch({
          name: operation.name,
          sketchId: operation.sketchId,
          distance: operation.distance,
          ids
        });
      }
      case 'add_revolve': {
        const ids = createBodyFeatureIds();
        scope.declare(operation.localId, ids.bodyId);
        return commandFactories.revolveSketch({
          name: operation.name,
          sketchId: operation.sketchId,
          axis: operation.axis,
          ids
        });
      }
      case 'add_boolean': {
        const targetBodyIds = operation.targetBodyIds.map(resolveBody);
        const ids = createBodyFeatureIds();
        // Operands are resolved before the result is declared, so a boolean can
        // never reference itself, and they are marked consumed afterwards.
        scope.declare(operation.localId, ids.bodyId);
        scope.consume(targetBodyIds, 'boolean');
        return commandFactories.booleanBodies({
          name: operation.name,
          operation: operation.operation,
          targetBodyIds,
          ids
        });
      }
      case 'add_transform':
        // transformBody mutates the target in place and returns the same body,
        // so the alias (if any) keeps pointing at the same BodyId.
        return commandFactories.transformBody({
          name: operation.name,
          targetBodyId: resolveBody(operation.targetBodyId),
          translation: operation.translation,
          rotationDeg: operation.rotationDeg
        });
      case 'add_edge_modifier': {
        const ids = createBodyFeatureIds();
        const targetBodyId = resolveBody(operation.targetBodyId);
        scope.declare(operation.localId, ids.bodyId);
        scope.consume([targetBodyId], operation.modifier);
        const payload = {
          name: operation.name,
          targetBodyId,
          edgeHashes: operation.edgeHashes,
          size: operation.size,
          ids
        };
        return operation.modifier === 'fillet'
          ? commandFactories.filletEdges(payload)
          : commandFactories.chamferEdges(payload);
      }
      case 'add_pattern': {
        const ids = createBodyFeatureIds();
        const targetBodyId = resolveBody(operation.targetBodyId);
        scope.declare(operation.localId, ids.bodyId);
        scope.consume([targetBodyId], 'pattern');
        return commandFactories.patternBody({
          name: operation.name,
          targetBodyId,
          patternKind: operation.patternKind,
          count: operation.count,
          axis: operation.axis,
          spacing: operation.spacing,
          angleDeg: operation.angleDeg,
          ids
        });
      }
      case 'set_feature_dimension': {
        const feature = findFeature(document, operation.featureId);
        if (!feature) {
          throw new Error(`Feature ${operation.featureId} not found.`);
        }
        if (feature.data.featureKind === 'primitive') {
          return commandFactories.updateFeature({
            featureId: feature.featureId,
            data: { dimensions: { [operation.field]: operation.value } }
          });
        }
        if (
          feature.data.featureKind === 'extrude' &&
          operation.field === 'distance'
        ) {
          return commandFactories.updateFeature({
            featureId: feature.featureId,
            data: { distance: operation.value }
          });
        }
        if (
          feature.data.featureKind === 'fillet' &&
          operation.field === 'radius'
        ) {
          return commandFactories.updateFeature({
            featureId: feature.featureId,
            data: { radius: operation.value }
          });
        }
        if (
          feature.data.featureKind === 'chamfer' &&
          operation.field === 'distance'
        ) {
          return commandFactories.updateFeature({
            featureId: feature.featureId,
            data: { distance: operation.value }
          });
        }
        if (
          feature.data.featureKind === 'pattern' &&
          ['count', 'spacing', 'angleDeg'].includes(operation.field)
        ) {
          return commandFactories.updateFeature({
            featureId: feature.featureId,
            data: { [operation.field]: operation.value }
          });
        }
        if (feature.data.featureKind === 'transform') {
          const [group, axis] = operation.field.split('.');
          if (
            (group === 'translation' || group === 'rotationDeg') &&
            (axis === 'x' || axis === 'y' || axis === 'z')
          ) {
            return commandFactories.updateFeature({
              featureId: feature.featureId,
              data: {
                transform: {
                  ...feature.data.transform,
                  [group]: {
                    ...feature.data.transform[group],
                    [axis]: operation.value
                  }
                }
              }
            });
          }
        }
        throw new Error(
          `Feature ${feature.name} does not expose an editable ${operation.field} dimension.`
        );
      }
    }
  });
}

/** Bound on stored undo/redo entries so long sessions cannot exhaust memory. */
const MAX_HISTORY_DEPTH = 100;

/**
 * Owns the current document and its undo/redo history.
 *
 * Documents are immutable values (every document-core operation clones before
 * mutating), so history entries hold plain references instead of deep copies.
 */
export class CommandManager {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  constructor(public document: ProjectDocument) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  execute(command: AnyCommand): ProjectDocument {
    command.validate(this.document);
    const previous = this.document;
    let next = command.apply(this.document);
    next.commandLog.push(command.serialize());
    next = appendRevision(next, command.label);
    this.pushUndo({ snapshot: previous, command: command.serialize() });
    this.redoStack = [];
    this.document = next;
    return this.document;
  }

  commitDerivedState(derived: ProjectDocument['derived']): ProjectDocument {
    this.document = attachDerivedState(this.document, derived);
    return this.document;
  }

  undo(): ProjectDocument {
    const entry = this.undoStack.pop();
    if (!entry) {
      return this.document;
    }
    const current = this.document;
    this.redoStack.push({ snapshot: current, command: entry.command });
    this.document = restoreHistorySnapshot(
      current,
      entry.snapshot,
      `Undo ${entry.command.label}`
    );
    return this.document;
  }

  redo(): ProjectDocument {
    const entry = this.redoStack.pop();
    if (!entry) {
      return this.document;
    }
    const current = this.document;
    this.undoStack.push({ snapshot: current, command: entry.command });
    this.document = restoreHistorySnapshot(
      current,
      entry.snapshot,
      `Redo ${entry.command.label}`
    );
    return this.document;
  }

  runTransaction(label: string, commands: AnyCommand[]): ProjectDocument {
    const previous = this.document;
    let next = this.document;
    const serialized: SerializedCommand[] = [];
    for (const command of commands) {
      command.validate(next);
      next = command.apply(next);
      serialized.push(command.serialize());
    }
    if (next === this.document) {
      return this.document;
    }
    next.commandLog.push(...serialized);
    next = appendRevision(next, label);
    this.pushUndo({
      snapshot: previous,
      command: {
        kind: 'transaction',
        label,
        payload: serialized,
        replayVersion: 1,
        timestamp: nowIso()
      }
    });
    this.redoStack = [];
    this.document = next;
    return this.document;
  }

  private pushUndo(entry: HistoryEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > MAX_HISTORY_DEPTH) {
      this.undoStack.shift();
    }
  }
}

/**
 * Restores a model snapshot without rewinding the document's durable timeline.
 * Collaboration treats `version` as a monotonic room clock, while checkpoints
 * are save points rather than undoable model state. Preserve both collections
 * and record Undo/Redo as new forward revisions.
 */
function restoreHistorySnapshot(
  current: ProjectDocument,
  snapshot: ProjectDocument,
  reason: string
): ProjectDocument {
  return appendRevision(
    {
      ...snapshot,
      version: current.version,
      revisions: current.revisions,
      checkpoints: current.checkpoints
    },
    reason
  );
}

export function replayCommands(
  initialDocument: ProjectDocument,
  serializedCommands: SerializedCommand[]
): ProjectDocument {
  let next = deepClone(initialDocument);
  next.commandLog = [];
  next.revisions = initialDocument.revisions.slice(0, 1);

  for (const command of serializedCommands) {
    switch (command.kind) {
      case 'primitive.add':
        next = addPrimitiveFeature(next, command.payload as PrimitiveInput);
        break;
      case 'sketch.add':
        next = addSketchFeature(next, command.payload as SketchInput).document;
        break;
      case 'sketch.update':
        next = updateSketch(next, command.payload as SketchUpdateInput);
        break;
      case 'sketch.object.add':
        next = addSketchObjects(
          next,
          command.payload as SketchObjectAddInput
        ).document;
        break;
      case 'sketch.object.update':
        next = updateSketchObject(
          next,
          command.payload as SketchObjectUpdateInput
        );
        break;
      case 'sketch.object.delete':
        next = deleteSketchObject(
          next,
          command.payload as SketchObjectDeleteInput
        );
        break;
      case 'feature.extrude':
        next = extrudeSketch(next, command.payload as ExtrudeInput).document;
        break;
      case 'feature.revolve':
        next = revolveSketch(next, command.payload as RevolveInput).document;
        break;
      case 'feature.boolean':
        next = booleanBodies(next, command.payload as BooleanInput).document;
        break;
      case 'feature.transform':
        next = transformBody(next, command.payload as TransformInput).document;
        break;
      case 'feature.direct-edit':
        next = directEditBody(
          next,
          command.payload as DirectEditInput
        ).document;
        break;
      case 'feature.fillet':
        next = filletEdges(next, command.payload as EdgeModifierInput).document;
        break;
      case 'feature.chamfer':
        next = chamferEdges(
          next,
          command.payload as EdgeModifierInput
        ).document;
        break;
      case 'feature.pattern':
        next = patternBody(next, command.payload as PatternInput).document;
        break;
      case 'feature.update':
        next = updateFeature(next, command.payload as FeatureUpdateInput);
        break;
      case 'feature.delete':
        next = deleteFeature(next, command.payload as FeatureDeleteInput);
        break;
      case 'parameter.set':
        next = setParameter(next, command.payload as ParameterSetInput);
        break;
      case 'parameter.delete':
        next = deleteParameter(next, command.payload as ParameterDeleteInput);
        break;
      case 'import.mesh':
        next = importMeshBody(
          next,
          command.payload as ImportedMeshInput
        ).document;
        break;
      case 'import.step':
        next = importStepBody(
          next,
          command.payload as ImportedStepInput
        ).document;
        break;
      case 'node.rename':
        next = renameNode(next, command.payload as NodeRenameInput);
        break;
      case 'node.metadata.set':
        next = setNodeMetadata(next, command.payload as NodeMetadataInput);
        break;
      default:
        // Unknown kinds are skipped (not fatal) so documents written by newer
        // clients still load; the skip is surfaced for debuggability.
        console.warn(
          `replayCommands: skipping unknown command kind "${command.kind}".`
        );
        continue;
    }

    next.commandLog.push(command);
  }

  return appendRevision(next, 'Replay');
}
