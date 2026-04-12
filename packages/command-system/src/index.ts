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
  before: ProjectDocument;
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

export const commandFactories = {
  addPrimitive(payload: PrimitiveInput): CommandDefinition<PrimitiveInput> {
    return makeCommand(
      'primitive.add',
      `Add ${payload.primitiveKind}`,
      payload,
      (document) => addPrimitiveFeature(document, payload)
    );
  },
  addSketch(payload: SketchInput): CommandDefinition<SketchInput> {
    return makeCommand('sketch.add', `Add ${payload.objectKind} sketch`, payload, (document) =>
      addSketchFeature(document, payload).document
    );
  },
  addConstraint(payload: ConstraintInput): CommandDefinition<ConstraintInput> {
    return makeCommand(
      'constraint.add',
      `Add ${payload.constraintKind} constraint`,
      payload,
      (document) => addConstraint(document, payload)
    );
  },
  extrudeSketch(payload: ExtrudeInput): CommandDefinition<ExtrudeInput> {
    return makeCommand('feature.extrude', 'Extrude sketch', payload, (document) =>
      extrudeSketch(document, payload).document
    );
  },
  booleanBodies(payload: BooleanInput): CommandDefinition<BooleanInput> {
    return makeCommand('feature.boolean', `Boolean ${payload.operation}`, payload, (document) =>
      booleanBodies(document, payload).document
    );
  },
  transformBody(payload: TransformInput): CommandDefinition<TransformInput> {
    return makeCommand('feature.transform', 'Transform body', payload, (document) =>
      transformBody(document, payload).document
    );
  },
  importMesh(payload: ImportedMeshInput): CommandDefinition<ImportedMeshInput> {
    return makeCommand('import.mesh', 'Import STL mesh', payload, (document) =>
      importMeshBody(document, payload).document
    );
  }
};

export class CommandManager {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  constructor(public document: ProjectDocument) {}

  execute(command: AnyCommand): ProjectDocument {
    command.validate(this.document);
    const before = deepClone(this.document);
    let next = command.apply(this.document);
    next.commandLog.push(command.serialize());
    next = appendRevision(next, command.label);
    this.undoStack.push({ before, command: command.serialize() });
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
    this.redoStack.push({ before: deepClone(this.document), command: entry.command });
    this.document = entry.before;
    return this.document;
  }

  redo(): ProjectDocument {
    const entry = this.redoStack.pop();
    if (!entry) {
      return this.document;
    }
    this.undoStack.push({ before: deepClone(this.document), command: entry.command });
    this.document = entry.before;
    return this.document;
  }

  runTransaction(label: string, commands: AnyCommand[]): ProjectDocument {
    const before = deepClone(this.document);
    let next = this.document;
    const serialized: SerializedCommand[] = [];
    for (const command of commands) {
      command.validate(next);
      next = command.apply(next);
      serialized.push(command.serialize());
    }
    next.commandLog.push(...serialized);
    next = appendRevision(next, label);
    this.undoStack.push({
      before,
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
        continue;
    }

    next.commandLog.push(command);
  }

  return appendRevision(next, 'Replay');
}
