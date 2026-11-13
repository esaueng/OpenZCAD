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

export function assertObjectFolderSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 34, 'Objects folders');
}

export function assertAssemblySchema(version: unknown): void {
  assertMinimumProjectSchema(version, 54, 'Assemblies');
}

/** AS02 joint couplings: `assembly.couplings` and its commands. */
export function assertAssemblyCouplingSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 56, 'Joint couplings');
}

/**
 * M15 thread runouts and pipe threads (schema v57): a thread carrying either
 * needs a document that declares it, or an older reader would build a plain
 * end or a cylindrical thread in its place.
 */
export function assertThreadContentSchema(
  data: unknown,
  version: unknown
): void {
  if (!record(data)) return;
  if (
    data.runoutStart !== undefined ||
    data.runoutEnd !== undefined ||
    data.pipeSize !== undefined ||
    data.profile === 'npt' ||
    data.profile === 'bspt'
  )
    assertMinimumProjectSchema(version, 57, 'Thread runouts and pipe threads');
}

function hasCouplings(assembly: unknown): boolean {
  return record(assembly) && assembly.couplings !== undefined;
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
    if (
      command.kind === 'objectFolder.create' ||
      command.kind === 'objectFolder.rename' ||
      command.kind === 'objectFolder.delete' ||
      command.kind === 'objectFolder.move'
    )
      assertObjectFolderSchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('assembly.')
    )
      assertAssemblySchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('assembly.coupling.')
    )
      assertAssemblyCouplingSchema(document.schemaVersion);
    if (!record(command.payload)) continue;
    if (command.kind === 'feature.thread')
      assertThreadContentSchema(command.payload, document.schemaVersion);
    if (
      record(command.payload.data) &&
      command.payload.data.featureKind === 'thread'
    )
      assertThreadContentSchema(command.payload.data, document.schemaVersion);
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
  if (document.objectFolders !== undefined)
    assertObjectFolderSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'objectFolders' &&
        (change.before !== undefined || change.after !== undefined)
      )
        assertObjectFolderSchema(document.schemaVersion);
  if (document.assembly !== undefined)
    assertAssemblySchema(document.schemaVersion);
  if (hasCouplings(document.assembly))
    assertAssemblyCouplingSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (change.field === 'assembly') {
        if (change.before !== undefined || change.after !== undefined)
          assertAssemblySchema(document.schemaVersion);
        if (hasCouplings(change.before) || hasCouplings(change.after))
          assertAssemblyCouplingSchema(document.schemaVersion);
      }
  for (const node of documentNodesWithHistory(document)) {
    if (node.kind === 'sketch-object')
      assertSketchObjectContentSchema(
        node.data,
        document.schemaVersion,
        node.id
      );
    if (node.kind === 'feature' && node.data.featureKind === 'thread')
      assertThreadContentSchema(node.data, document.schemaVersion);
  }
  assertDocumentContentCommandSchema(document);
}
