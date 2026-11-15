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

/** I01 (schema v59): slot composites, wherever a document or command holds one. */
export function assertSlotSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 59, 'Sketch slots');
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
 * L09 document print clearance (schema v60): `printClearance` and its
 * command. An older reader would build threads and gears without it.
 */
export function assertPrintClearanceSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 60, 'A print clearance');
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

/**
 * M16 sheet-metal features (schema v58): an older reader has no builder for
 * the kind and would drop the body, so the document must declare the schema.
 */
export function assertSheetMetalSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 58, 'Sheet-metal features');
}

function hasCouplings(assembly: unknown): boolean {
  return record(assembly) && assembly.couplings !== undefined;
}

/** AS03 exploded view: `assembly.explode` and its command. */
export function assertAssemblyExplodeSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 61, 'Exploded views');
}

function hasExplode(assembly: unknown): boolean {
  return record(assembly) && assembly.explode !== undefined;
}

export function assertSketchObjectContentSchema(
  data: SketchObjectData,
  version: unknown,
  objectId?: string
): void {
  if (data.projection !== undefined)
    assertMinimumProjectSchema(version, 33, 'Sketch projections');
  if (data.objectKind === 'point')
    assertMinimumProjectSchema(version, 59, 'Sketch points');
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
  // Objects whose kind or fields need a newer schema: a projection (v33)
  // or a point (v59), wherever a saved command carries one.
  const object = (value: unknown) => {
    if (
      record(value) &&
      (value.projection !== undefined || value.objectKind === 'point')
    )
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
    if (command.kind === 'assembly.explode.set')
      assertAssemblyExplodeSchema(document.schemaVersion);
    if (command.kind === 'feature.sheet-metal')
      assertSheetMetalSchema(document.schemaVersion);
    if (command.kind === 'printClearance.set')
      assertPrintClearanceSchema(document.schemaVersion);
    if (!record(command.payload)) continue;
    if (
      command.kind === 'sketch.composite.add' &&
      record(command.payload.composite) &&
      command.payload.composite.compositeKind === 'slot'
    )
      assertSlotSchema(document.schemaVersion);
    if (command.kind === 'feature.thread')
      assertThreadContentSchema(command.payload, document.schemaVersion);
    // A feature patch (`feature.update`) need not name its kind, so a
    // partial `{ runoutEnd: true }` is gated by its fields: they are
    // thread-only, so any patch that is not another kind's carries them
    // only as a thread.
    if (
      record(command.payload.data) &&
      (command.payload.data.featureKind === undefined ||
        command.payload.data.featureKind === 'thread')
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
  if (document.printClearance !== undefined)
    assertPrintClearanceSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'printClearance' &&
        (change.before !== undefined || change.after !== undefined)
      )
        assertPrintClearanceSchema(document.schemaVersion);
  if (document.assembly !== undefined)
    assertAssemblySchema(document.schemaVersion);
  if (hasCouplings(document.assembly))
    assertAssemblyCouplingSchema(document.schemaVersion);
  if (hasExplode(document.assembly))
    assertAssemblyExplodeSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (change.field === 'assembly') {
        if (change.before !== undefined || change.after !== undefined)
          assertAssemblySchema(document.schemaVersion);
        if (hasCouplings(change.before) || hasCouplings(change.after))
          assertAssemblyCouplingSchema(document.schemaVersion);
        if (hasExplode(change.before) || hasExplode(change.after))
          assertAssemblyExplodeSchema(document.schemaVersion);
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
    if (node.kind === 'feature' && node.data.featureKind === 'sheet-metal')
      assertSheetMetalSchema(document.schemaVersion);
    if (
      node.kind === 'sketch' &&
      Array.isArray(node.composites) &&
      node.composites.some(
        (composite) => record(composite) && composite.compositeKind === 'slot'
      )
    )
      assertSlotSchema(document.schemaVersion);
  }
  assertDocumentContentCommandSchema(document);
}
