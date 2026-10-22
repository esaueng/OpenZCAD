import {
  documentNodesWithHistory,
  type ProjectDocument,
  type SketchObjectData
} from '@openzcad/shared';
import { assertSketchObjectProjection } from './sketch-projections';

/** New content needs a declared schema; coercion or a missing version is no proof. */
export function assertMinimumProjectSchema(
  version: unknown,
  minimum: number,
  content: string
): void {
  if (
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < minimum
  )
    throw new Error(`${content} require project schema v${minimum} or newer.`);
}

export function assertSketchObjectContentSchema(
  data: SketchObjectData,
  version: unknown,
  objectId?: string
): void {
  if (data.projection !== undefined)
    assertMinimumProjectSchema(version, 33, 'Sketch projections');
  assertSketchObjectProjection(data, objectId);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Inspect only known command carriers, including saved undo/redo log copies. */
export function assertDocumentContentCommandSchema(
  document: Pick<
    ProjectDocument,
    'schemaVersion' | 'commandLog' | 'editHistory'
  >
): void {
  const pending: unknown[] = [document.commandLog];
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (change.field === 'commandLog')
        pending.push(change.before, change.after);
  const seen = new Set<object>();
  const object = (value: unknown) => {
    if (record(value) && value.projection !== undefined)
      assertSketchObjectContentSchema(
        value as unknown as SketchObjectData,
        document.schemaVersion
      );
  };
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
    if (!record(command.payload)) continue;
    switch (command.kind) {
      case 'sketch.add':
      case 'sketch.object.add':
        if (Array.isArray(command.payload.objects))
          command.payload.objects.forEach(object);
        if (command.kind === 'sketch.add') object(command.payload.object);
        break;
      case 'sketch.update':
        object(command.payload.object);
        break;
      case 'sketch.object.update':
        object(command.payload.data);
        break;
    }
  }
}

/** Call after validating or dropping unreadable history at the entry boundary. */
export function assertDocumentContentSchema(document: ProjectDocument): void {
  for (const node of documentNodesWithHistory(document))
    if (node.kind === 'sketch-object')
      assertSketchObjectContentSchema(
        node.data,
        document.schemaVersion,
        node.id
      );
  assertDocumentContentCommandSchema(document);
}
