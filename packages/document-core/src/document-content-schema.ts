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
 * F06 configurations (schema v72): `configurations` and its commands. An
 * older reader would show and export the bodies the active row hides.
 */
export const CONFIGURATION_SCHEMA_VERSION = 72;

export function assertConfigurationSchema(version: unknown): void {
  assertMinimumProjectSchema(
    version,
    CONFIGURATION_SCHEMA_VERSION,
    'Configurations'
  );
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
 * M02 feature patterns and skipped copies (schema v62): a pattern carrying
 * either needs a document that declares it, or an older reader would copy
 * the whole body, or build every copy, in its place.
 */
export function assertPatternContentSchema(
  data: unknown,
  version: unknown
): void {
  if (!record(data)) return;
  if (
    data.sourceFeatureIds !== undefined ||
    data.skippedInstances !== undefined
  )
    assertMinimumProjectSchema(
      version,
      62,
      'Feature patterns and skipped pattern copies'
    );
  if (data.patternKind === 'points' || data.points !== undefined)
    assertMinimumProjectSchema(version, 63, 'Patterns on sketch points');
}

/**
 * M01 holes on sketch points (schema v64) and standard hole sizes (v65): a
 * hole carrying either needs a document that declares it, or an older
 * reader would drill one hole at the stored position, or drop the size, in
 * their place.
 */
export function assertHoleContentSchema(data: unknown, version: unknown): void {
  if (!record(data)) return;
  if (data.points !== undefined)
    assertMinimumProjectSchema(version, 64, 'Holes on sketch points');
  if (data.standard !== undefined)
    assertMinimumProjectSchema(version, 65, 'Standard hole sizes');
  if (data.tapped !== undefined)
    assertMinimumProjectSchema(version, 66, 'Tapped holes');
  if (record(data.tapped) && data.tapped.cosmetic !== undefined)
    assertMinimumProjectSchema(version, 67, 'Cosmetic threads');
}

/**
 * M16 sheet-metal features (schema v58): an older reader has no builder for
 * the kind and would drop the body, so the document must declare the schema.
 */
export function assertSheetMetalSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 58, 'Sheet-metal features');
}

/**
 * D02 dimension tolerances, prefixes and suffixes (schema v68): a drawing
 * annotation carrying any needs a document that declares it, or an older
 * reader would print the bare value and drop them on its next save.
 */
export function assertDrawingDimensionFormatSchema(version: unknown): void {
  assertMinimumProjectSchema(
    version,
    68,
    'Dimension tolerances, prefixes and suffixes'
  );
}

/**
 * Whether `value` (a drawing set, a sheet, an annotation or a drawing
 * command's payload) holds an annotation with a v68 field. Walks records and
 * arrays only, once each.
 */
export function hasDrawingDimensionFormat(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const next = pending.pop();
    if (typeof next !== 'object' || next === null || seen.has(next)) continue;
    seen.add(next);
    if (Array.isArray(next)) {
      pending.push(...(next as unknown[]));
      continue;
    }
    const entry = next as Record<string, unknown>;
    if (
      typeof entry.annotationId === 'string' &&
      (entry.tolerance !== undefined ||
        entry.prefix !== undefined ||
        entry.suffix !== undefined)
    )
      return true;
    pending.push(...Object.values(entry));
  }
  return false;
}

/**
 * M17 standard parts (schema v69): an older reader has no builder for the
 * kind and would drop the body, so the document must declare the schema.
 */
export function assertStandardPartSchema(
  version: unknown,
  data?: unknown
): void {
  assertMinimumProjectSchema(version, 69, 'Standard parts');
  if (record(data) && data.hole !== undefined)
    assertMinimumProjectSchema(version, 77, 'Parts inserted into holes');
  if (record(data) && data.thread !== undefined)
    assertMinimumProjectSchema(version, 83, 'Simplified threads');
}

/**
 * D02 drawing properties (schema v70): a sheet carrying `format` needs a
 * document that declares it, or an older reader would print its dimensions
 * in the document's units and drop the properties on its next save.
 */
export function assertDrawingFormatSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 70, 'Drawing properties');
}

/** Whether `value` holds a sheet, or a sheet update, that sets a format. */
export function hasDrawingFormat(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const next = pending.pop();
    if (typeof next !== 'object' || next === null || seen.has(next)) continue;
    seen.add(next);
    if (Array.isArray(next)) {
      pending.push(...(next as unknown[]));
      continue;
    }
    const entry = next as Record<string, unknown>;
    // A sheet, or a sheet update command's payload, which names its sheet
    // beside the properties it sets (null clears them).
    if (
      typeof entry.sheetId === 'string' &&
      entry.format !== undefined &&
      entry.format !== null
    )
      return true;
    pending.push(...Object.values(entry));
  }
  return false;
}

/**
 * D02 geometry annotations (schema v73): centre and intersection marks,
 * centrelines and mark points need a document that declares them.
 */
export function assertDrawingGeometrySchema(version: unknown): void {
  assertMinimumProjectSchema(
    version,
    73,
    'Centre marks, intersection marks and centrelines'
  );
}

const GEOMETRY_KINDS: readonly unknown[] = [
  'center-mark',
  'intersection-mark',
  'centerline'
];

/** Whether `value` holds a v73 geometry annotation or mark point. */
export function hasDrawingGeometry(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const next = pending.pop();
    if (typeof next !== 'object' || next === null || seen.has(next)) continue;
    seen.add(next);
    if (Array.isArray(next)) {
      pending.push(...(next as unknown[]));
      continue;
    }
    const entry = next as Record<string, unknown>;
    if (
      (typeof entry.annotationId === 'string' &&
        GEOMETRY_KINDS.includes(entry.kind)) ||
      entry.anchor === 'mark'
    )
      return true;
    pending.push(...Object.values(entry));
  }
  return false;
}

/** D02 distance dimensions (schema v75). */
export function assertDrawingDistanceSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 75, 'Distance dimensions');
}

/** Whether `value` holds a v75 distance dimension. */
export function hasDrawingDistance(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const next = pending.pop();
    if (typeof next !== 'object' || next === null || seen.has(next)) continue;
    seen.add(next);
    if (Array.isArray(next)) {
      pending.push(...(next as unknown[]));
      continue;
    }
    const entry = next as Record<string, unknown>;
    if (typeof entry.annotationId === 'string' && entry.kind === 'distance')
      return true;
    pending.push(...Object.values(entry));
  }
  return false;
}

/** D03 detail views (schema v78). */
export function assertDrawingDetailSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 78, 'Detail views');
}

/** Whether `value` holds a v78 detail view. */
export function hasDrawingDetail(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const next = pending.pop();
    if (typeof next !== 'object' || next === null || seen.has(next)) continue;
    seen.add(next);
    if (Array.isArray(next)) {
      pending.push(...(next as unknown[]));
      continue;
    }
    const entry = next as Record<string, unknown>;
    if (typeof entry.viewId === 'string' && entry.detail !== undefined)
      return true;
    pending.push(...Object.values(entry));
  }
  return false;
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
    if (command.kind === 'feature.standard-part')
      assertStandardPartSchema(document.schemaVersion, command.payload);
    if (command.kind === 'printClearance.set')
      assertPrintClearanceSchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('configuration.')
    )
      assertConfigurationSchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('drawing.') &&
      hasDrawingDimensionFormat(command.payload)
    )
      assertDrawingDimensionFormatSchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('drawing.') &&
      hasDrawingFormat(command.payload)
    )
      assertDrawingFormatSchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('drawing.') &&
      hasDrawingGeometry(command.payload)
    )
      assertDrawingGeometrySchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('drawing.') &&
      hasDrawingDistance(command.payload)
    )
      assertDrawingDistanceSchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('drawing.') &&
      hasDrawingDetail(command.payload)
    )
      assertDrawingDetailSchema(document.schemaVersion);
    if (!record(command.payload)) continue;
    if (
      command.kind === 'sketch.composite.add' &&
      record(command.payload.composite) &&
      command.payload.composite.compositeKind === 'slot'
    )
      assertSlotSchema(document.schemaVersion);
    if (command.kind === 'feature.thread')
      assertThreadContentSchema(command.payload, document.schemaVersion);
    if (command.kind === 'feature.pattern')
      assertPatternContentSchema(command.payload, document.schemaVersion);
    if (command.kind === 'feature.hole')
      assertHoleContentSchema(command.payload, document.schemaVersion);
    // A hole patch names its kind (the History edit sends the whole data).
    if (
      record(command.payload.data) &&
      command.payload.data.featureKind === 'hole'
    )
      assertHoleContentSchema(command.payload.data, document.schemaVersion);
    // Pattern-only fields, gated however the patch names its kind.
    if (
      record(command.payload.data) &&
      (command.payload.data.featureKind === undefined ||
        command.payload.data.featureKind === 'pattern')
    )
      assertPatternContentSchema(command.payload.data, document.schemaVersion);
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
    // M17 (schema v77): `hole` is a standard part's only, so a patch that
    // carries one and is not another kind's inserts the part into a hole.
    if (
      record(command.payload.data) &&
      command.payload.data.hole !== undefined &&
      (command.payload.data.featureKind === undefined ||
        command.payload.data.featureKind === 'standard-part')
    )
      assertMinimumProjectSchema(
        document.schemaVersion,
        77,
        'Parts inserted into holes'
      );
    // M17 (schema v83): `thread` is a standard part's only, as `hole` is.
    if (
      record(command.payload.data) &&
      command.payload.data.thread !== undefined &&
      (command.payload.data.featureKind === undefined ||
        command.payload.data.featureKind === 'standard-part')
    )
      assertMinimumProjectSchema(
        document.schemaVersion,
        83,
        'Simplified threads'
      );
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
  if (document.configurations !== undefined)
    assertConfigurationSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'configurations' &&
        (change.before !== undefined || change.after !== undefined)
      )
        assertConfigurationSchema(document.schemaVersion);
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
  if (hasDrawingDimensionFormat(document.drawings))
    assertDrawingDimensionFormatSchema(document.schemaVersion);
  if (hasDrawingFormat(document.drawings))
    assertDrawingFormatSchema(document.schemaVersion);
  if (hasDrawingGeometry(document.drawings))
    assertDrawingGeometrySchema(document.schemaVersion);
  if (hasDrawingDistance(document.drawings))
    assertDrawingDistanceSchema(document.schemaVersion);
  if (hasDrawingDetail(document.drawings))
    assertDrawingDetailSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'drawings' &&
        (hasDrawingDetail(change.before) || hasDrawingDetail(change.after))
      )
        assertDrawingDetailSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'drawings' &&
        (hasDrawingDistance(change.before) || hasDrawingDistance(change.after))
      )
        assertDrawingDistanceSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'drawings' &&
        (hasDrawingGeometry(change.before) || hasDrawingGeometry(change.after))
      )
        assertDrawingGeometrySchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'drawings' &&
        (hasDrawingDimensionFormat(change.before) ||
          hasDrawingDimensionFormat(change.after))
      )
        assertDrawingDimensionFormatSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'drawings' &&
        (hasDrawingFormat(change.before) || hasDrawingFormat(change.after))
      )
        assertDrawingFormatSchema(document.schemaVersion);
  for (const node of documentNodesWithHistory(document)) {
    if (node.kind === 'sketch-object')
      assertSketchObjectContentSchema(
        node.data,
        document.schemaVersion,
        node.id
      );
    if (node.kind === 'feature' && node.data.featureKind === 'thread')
      assertThreadContentSchema(node.data, document.schemaVersion);
    if (node.kind === 'feature' && node.data.featureKind === 'pattern')
      assertPatternContentSchema(node.data, document.schemaVersion);
    if (node.kind === 'feature' && node.data.featureKind === 'hole')
      assertHoleContentSchema(node.data, document.schemaVersion);
    if (node.kind === 'feature' && node.data.featureKind === 'sheet-metal')
      assertSheetMetalSchema(document.schemaVersion);
    if (node.kind === 'feature' && node.data.featureKind === 'standard-part')
      assertStandardPartSchema(document.schemaVersion, node.data);
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
