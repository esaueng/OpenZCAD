import {
  deepClone,
  nowIso,
  type BodyId,
  type ProjectDocument,
  type SerializedCommand
} from '@openzcad/shared';
import {
  addPrimitiveFeature,
  addSketchFeature,
  appendRevision,
  attachDerivedState,
  booleanBodies,
  chamferEdges,
  createBodyFeatureIds,
  createFeatureOnlyIds,
  createParameterIds,
  createSketchFeatureIds,
  deleteFeature,
  deleteParameter,
  extrudeSketch,
  filletEdges,
  findFeature,
  findSketch,
  importMeshBody,
  importStepBody,
  patternBody,
  renameNode,
  revolveSketch,
  setNodeMetadata,
  setParameter,
  transformBody,
  updateFeature,
  updateSketch,
  type BooleanInput,
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
  type SketchUpdateInput,
  type TransformInput
} from '@openzcad/document-core';
import type { CadPatchProposal } from '@openzcad/ai-contracts';

export type CommandKind =
  | 'primitive.add'
  | 'sketch.add'
  | 'sketch.update'
  | 'feature.extrude'
  | 'feature.revolve'
  | 'feature.boolean'
  | 'feature.transform'
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
  | CommandDefinition<ExtrudeInput>
  | CommandDefinition<RevolveInput>
  | CommandDefinition<BooleanInput>
  | CommandDefinition<TransformInput>
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
    const withIds = {
      ...payload,
      ids: payload.ids ?? createSketchFeatureIds()
    };
    return makeCommand(
      'sketch.add',
      `Add ${payload.object.objectKind} sketch`,
      withIds,
      (document) => addSketchFeature(document, withIds).document
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

/** Converts a reviewed AI proposal into normal undoable document commands. */
export function commandsForCadPatch(
  document: ProjectDocument,
  proposal: CadPatchProposal
): AnyCommand[] {
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
        return commandFactories.addPrimitive({
          name: operation.name,
          primitiveKind: operation.primitiveKind,
          dimensions
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
      case 'add_extrude':
        return commandFactories.extrudeSketch({
          name: operation.name,
          sketchId: operation.sketchId,
          distance: operation.distance
        });
      case 'add_revolve':
        return commandFactories.revolveSketch({
          name: operation.name,
          sketchId: operation.sketchId,
          axis: operation.axis
        });
      case 'add_boolean':
        return commandFactories.booleanBodies({
          name: operation.name,
          operation: operation.operation,
          targetBodyIds: operation.targetBodyIds
        });
      case 'add_transform':
        return commandFactories.transformBody({
          name: operation.name,
          targetBodyId: operation.targetBodyId,
          translation: operation.translation,
          rotationDeg: operation.rotationDeg
        });
      case 'add_edge_modifier': {
        const payload = {
          name: operation.name,
          targetBodyId: operation.targetBodyId,
          edgeHashes: operation.edgeHashes,
          size: operation.size
        };
        return operation.modifier === 'fillet'
          ? commandFactories.filletEdges(payload)
          : commandFactories.chamferEdges(payload);
      }
      case 'add_pattern':
        return commandFactories.patternBody({
          name: operation.name,
          targetBodyId: operation.targetBodyId,
          patternKind: operation.patternKind,
          count: operation.count,
          axis: operation.axis,
          spacing: operation.spacing,
          angleDeg: operation.angleDeg
        });
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
    this.redoStack.push({ snapshot: this.document, command: entry.command });
    this.document = entry.snapshot;
    return this.document;
  }

  redo(): ProjectDocument {
    const entry = this.redoStack.pop();
    if (!entry) {
      return this.document;
    }
    this.undoStack.push({ snapshot: this.document, command: entry.command });
    this.document = entry.snapshot;
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
