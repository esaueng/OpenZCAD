import {
  deepClone,
  nowIso,
  type ProjectDocument,
  type SerializedCommand
} from '@openzcad/shared';
import {
  addConstraint,
  addPrimitiveFeature,
  addSketchFeature,
  appendRevision,
  attachDerivedState,
  booleanBodies,
  createBodyFeatureIds,
  createConstraintIds,
  createFeatureOnlyIds,
  createSketchFeatureIds,
  extrudeSketch,
  importMeshBody,
  transformBody,
  type BooleanInput,
  type ConstraintInput,
  type ExtrudeInput,
  type ImportedMeshInput,
  type PrimitiveInput,
  type SketchInput,
  type TransformInput
} from '@openzcad/document-core';

export interface CommandDefinition<TPayload> {
  kind:
    | 'primitive.add'
    | 'sketch.add'
    | 'constraint.add'
    | 'feature.extrude'
    | 'feature.boolean'
    | 'feature.transform'
    | 'import.mesh';
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
  | CommandDefinition<ConstraintInput>
  | CommandDefinition<ExtrudeInput>
  | CommandDefinition<BooleanInput>
  | CommandDefinition<TransformInput>
  | CommandDefinition<ImportedMeshInput>;

function makeCommand<TPayload>(
  kind: AnyCommand['kind'],
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
    const withIds = { ...payload, ids: payload.ids ?? createSketchFeatureIds() };
    return makeCommand('sketch.add', `Add ${payload.objectKind} sketch`, withIds, (document) =>
      addSketchFeature(document, withIds).document
    );
  },
  addConstraint(payload: ConstraintInput): CommandDefinition<ConstraintInput> {
    const withIds = { ...payload, ids: payload.ids ?? createConstraintIds() };
    return makeCommand(
      'constraint.add',
      `Add ${payload.constraintKind} constraint`,
      withIds,
      (document) => addConstraint(document, withIds)
    );
  },
  extrudeSketch(payload: ExtrudeInput): CommandDefinition<ExtrudeInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand('feature.extrude', 'Extrude sketch', withIds, (document) =>
      extrudeSketch(document, withIds).document
    );
  },
  booleanBodies(payload: BooleanInput): CommandDefinition<BooleanInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand('feature.boolean', `Boolean ${payload.operation}`, withIds, (document) =>
      booleanBodies(document, withIds).document
    );
  },
  transformBody(payload: TransformInput): CommandDefinition<TransformInput> {
    const withIds = { ...payload, ids: payload.ids ?? createFeatureOnlyIds() };
    return makeCommand('feature.transform', 'Transform body', withIds, (document) =>
      transformBody(document, withIds).document
    );
  },
  importMesh(payload: ImportedMeshInput): CommandDefinition<ImportedMeshInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand('import.mesh', 'Import STL mesh', withIds, (document) =>
      importMeshBody(document, withIds).document
    );
  }
};

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
      case 'constraint.add':
        next = addConstraint(next, command.payload as ConstraintInput);
        break;
      case 'feature.extrude':
        next = extrudeSketch(next, command.payload as ExtrudeInput).document;
        break;
      case 'feature.boolean':
        next = booleanBodies(next, command.payload as BooleanInput).document;
        break;
      case 'feature.transform':
        next = transformBody(next, command.payload as TransformInput).document;
        break;
      case 'import.mesh':
        next = importMeshBody(next, command.payload as ImportedMeshInput).document;
        break;
      default:
        // Unknown kinds are skipped (not fatal) so documents written by newer
        // clients still load; the skip is surfaced for debuggability.
        console.warn(`replayCommands: skipping unknown command kind "${command.kind}".`);
        continue;
    }

    next.commandLog.push(command);
  }

  return appendRevision(next, 'Replay');
}
