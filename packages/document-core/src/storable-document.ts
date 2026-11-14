import {
  MAX_PROJECT_CHECKPOINTS,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  assertDocumentHistory,
  assertDocumentTextBudget,
  documentEnvelopeError,
  documentNodesWithHistory,
  documentStructureError,
  drawingSetError,
  hasValidImportedMeshSources,
  hasValidImportedStepSources,
  isOwnRecordKey,
  isReservedRecordKey,
  isProjectCheckpoint,
  isRevisionRecord,
  objectFolderSetError,
  assemblySetError,
  referenceImageSetError,
  reservedIdentifierError,
  reservedNameError,
  sketchConstraintShapeError,
  type ProjectDocument
} from '@openzcad/shared';
import { assertDocumentContentSchema } from './document-content-schema';
import { assertSketchProvenance } from './sketch-provenance-validation';
import { assertReferenceDocumentSchema } from './sketch-reference-dimensions';
import { normalizeDocument } from './index';

/** Why a document cannot be stored or adopted; the message names the part. */
export class UnstorableDocumentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UnstorableDocumentError';
  }
}

/**
 * The document as it is stored and sent: without the derived geometry, which
 * the browser rebuilds and never uploads or relays. The structure guards
 * measure this, so a dense live mesh does not count against them.
 */
function storedProjection(value: object): object {
  const derived = (value as { derived?: unknown }).derived;
  if (typeof derived !== 'object' || derived === null) return value;
  return {
    ...value,
    derived: { ...derived, bodyRepresentations: {}, exportableBodyIds: [] }
  };
}

/**
 * Node references never name a reserved or inherited member: ids are looked
 * up as `nodes[id]`, where such a name resolves to a prototype member instead
 * of a node. The project's root, root assembly and active part must also be
 * nodes it holds. Other references (`parentId`, `childIds`) may name a node
 * that is gone, as older edits could leave them, and lookups treat that as
 * missing.
 */
function nodeReferenceError(record: Record<string, unknown>): string | null {
  const nodes = record.nodes as Record<string, unknown>;
  const own = (id: unknown) => isOwnRecordKey(nodes, id);
  const safe = (id: unknown) =>
    typeof id === 'string' && !isReservedRecordKey(id);
  for (const field of ['rootNodeId', 'rootAssemblyId', 'activePartId']) {
    if (record[field] !== undefined && !own(record[field]))
      return `"document.${field}" does not name a node in the project.`;
  }
  for (const [nodeId, node] of Object.entries(nodes)) {
    const fields = node as Record<string, unknown>;
    if (
      fields.parentId !== undefined &&
      fields.parentId !== null &&
      !safe(fields.parentId)
    )
      return `Node "${nodeId}" has an invalid parent id.`;
    if (
      fields.kind === 'project' &&
      fields.activePartId !== undefined &&
      !own(fields.activePartId)
    )
      return `Node "${nodeId}" names an active part that is not in the project.`;
    if (
      (fields.kind === 'part' || fields.kind === 'assembly') &&
      fields.childIds !== undefined &&
      (!Array.isArray(fields.childIds) || !fields.childIds.every(safe))
    )
      return `Node "${nodeId}" has an invalid child id.`;
  }
  return null;
}

/**
 * The received derived projection is never walked whole (a dense mesh is
 * typed arrays, or numbers once serialized), but its names are: body ids key
 * `bodyRepresentations` and fill `exportableBodyIds`, and a representation's
 * `bodyId` and topology references become picking ids. A forged projection
 * must not supply a reserved one before the next rebuild replaces it. The
 * mesh is skipped except for its persistent `reference`.
 */
function derivedProjectionError(value: object): string | null {
  const derived = (value as { derived?: unknown }).derived;
  if (derived === undefined) return null;
  if (typeof derived !== 'object' || derived === null || Array.isArray(derived))
    return '"document.derived" must be an object.';
  const { bodyRepresentations, exportableBodyIds } = derived as Record<
    string,
    unknown
  >;
  if (bodyRepresentations !== undefined) {
    if (
      typeof bodyRepresentations !== 'object' ||
      bodyRepresentations === null ||
      Array.isArray(bodyRepresentations)
    )
      return '"document.derived.bodyRepresentations" must be an object.';
    for (const [bodyId, representation] of Object.entries(
      bodyRepresentations
    )) {
      if (isReservedRecordKey(bodyId))
        return `"document.derived.bodyRepresentations" uses the reserved key "${bodyId}".`;
      if (
        typeof representation !== 'object' ||
        representation === null ||
        Array.isArray(representation)
      )
        return `"document.derived.bodyRepresentations.${bodyId}" must be an object.`;
      const { mesh, ...rest } = representation as Record<string, unknown>;
      const reference =
        typeof mesh === 'object' && mesh !== null
          ? (mesh as { reference?: unknown }).reference
          : undefined;
      const error = reservedNameError({ ...rest, mesh: { reference } });
      if (error)
        return `"document.derived.bodyRepresentations.${bodyId}": ${error}`;
    }
  }
  if (
    exportableBodyIds !== undefined &&
    (!Array.isArray(exportableBodyIds) ||
      !exportableBodyIds.every(
        (id) => typeof id === 'string' && !isReservedRecordKey(id)
      ))
  )
    return '"document.derived.exportableBodyIds" holds an invalid body id.';
  return null;
}

/**
 * No reserved name as a key, id or selector, and no enum value outside its
 * union, anywhere in the document: its maps, nodes, history, stored commands
 * (see `reservedIdentifierError`; freeform metadata values are text) and
 * the names its derived projection carries ({@link derivedProjectionError}).
 * Unlike {@link documentIdentifierError} it does not require node references
 * to resolve, so a device copy or backup with an ordinary dangling reference
 * still opens. Returns the refusal, or null.
 */
export function reservedDocumentIdentifierError(value: object): string | null {
  return (
    reservedIdentifierError(storedProjection(value)) ??
    derivedProjectionError(value)
  );
}

/**
 * Throws `UnstorableDocumentError` unless the document passes
 * {@link reservedDocumentIdentifierError}. Run on every document read from
 * outside the running app (a backup, a device copy, a save state) before it
 * is normalized or published.
 */
export function assertSafeDocumentIdentifiers(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new UnstorableDocumentError(
      'The project document must be an object.'
    );
  const error = reservedDocumentIdentifierError(value);
  if (error) throw new UnstorableDocumentError(error);
}

/**
 * The key and reference checks a document must pass wherever it is published:
 * no reserved name as a key, id or selector anywhere in it
 * ({@link reservedDocumentIdentifierError}), node references that name
 * nodes as {@link nodeReferenceError} requires, and the document's `units`,
 * which every length is read through. Returns the refusal, or null.
 */
export function documentIdentifierError(value: object): string | null {
  return (
    nodeReferenceError(value as Record<string, unknown>) ??
    ((value as { units?: unknown }).units === undefined
      ? '"document" is missing its "units".'
      : null) ??
    reservedDocumentIdentifierError(value)
  );
}

/** Every stored sketch constraint, live or in undo history, has a valid shape. */
function assertSketchConstraintShapes(document: ProjectDocument): void {
  for (const node of documentNodesWithHistory(document)) {
    if (node.kind !== 'sketch') continue;
    const constraints: unknown = node.constraints;
    if (constraints === undefined) continue;
    if (!Array.isArray(constraints))
      throw new Error(`Sketch "${node.id}" has invalid constraints.`);
    for (const constraint of constraints) {
      const data =
        typeof constraint === 'object' && constraint !== null
          ? (constraint as { data?: unknown }).data
          : undefined;
      const error = sketchConstraintShapeError(data);
      if (error) throw new Error(`Sketch "${node.id}": ${error}`);
    }
  }
}

function check(condition: unknown, message: string): void {
  if (!condition) throw new UnstorableDocumentError(message);
}

function attempt(run: () => void, fallback: string): void {
  try {
    run();
  } catch (cause) {
    throw new UnstorableDocumentError(
      cause instanceof Error && cause.message ? cause.message : fallback,
      { cause }
    );
  }
}

/**
 * Every content check the account and the collaboration room made before
 * storing a document, in one place the browser runs (ADR-024 Phase 1).
 *
 * The browser checks each document before it writes one and before it adopts
 * one, so a bad version is refused and the last good one kept. Once projects
 * are encrypted the server cannot read contents at all, and this is the only
 * defense against a document other members cannot open.
 *
 * Normalization comes first: it is how an older document is migrated (its
 * schema stamped current, an unreadable undo history dropped, checkpoints
 * trimmed to the cap), and it refuses content an older schema cannot carry.
 * The checks after it apply to the document as this build would store it.
 * Only the structure guards, which keep the recursive walks safe, and the
 * newer-schema refusal look at the document as received.
 * Returns the normalized document, or throws `UnstorableDocumentError`.
 */
export function assertStorableDocument(value: unknown): ProjectDocument {
  check(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'The project document must be an object.'
  );
  const stored = storedProjection(value as object);
  const structure = documentStructureError(stored);
  if (structure) throw new UnstorableDocumentError(structure);
  const envelope = documentEnvelopeError(stored);
  if (envelope) throw new UnstorableDocumentError(envelope);
  const record = value as Record<string, unknown>;
  const identifiers = documentIdentifierError(record);
  if (identifiers) throw new UnstorableDocumentError(identifiers);
  check(
    typeof record.schemaVersion !== 'number' ||
      record.schemaVersion <= PROJECT_DOCUMENT_SCHEMA_VERSION,
    `The project was saved by a newer OpenZCAD (schema ${String(record.schemaVersion)}). Update to open it.`
  );
  for (const [section, error] of [
    [
      'drawings',
      record.drawings === undefined ? null : drawingSetError(record.drawings)
    ],
    [
      'objectFolders',
      record.objectFolders === undefined
        ? null
        : objectFolderSetError(record.objectFolders)
    ],
    [
      'referenceImages',
      record.referenceImages === undefined
        ? null
        : referenceImageSetError(record.referenceImages)
    ],
    [
      'assembly',
      record.assembly === undefined ? null : assemblySetError(record.assembly)
    ]
  ] as const) {
    if (error)
      throw new UnstorableDocumentError(`"document.${section}": ${error}`);
  }
  let document!: ProjectDocument;
  attempt(() => {
    document = normalizeDocument(value as ProjectDocument);
  }, 'The project document cannot be opened.');
  check(
    document.revisions.every(isRevisionRecord) &&
      document.checkpoints.length <= MAX_PROJECT_CHECKPOINTS &&
      document.checkpoints.every(isProjectCheckpoint),
    'The project has invalid revision or checkpoint history.'
  );
  attempt(
    () => assertDocumentHistory(document),
    'The project has invalid or unsupported undo history.'
  );
  attempt(
    () => assertSketchProvenance(document),
    'The project has invalid sketch provenance.'
  );
  attempt(
    () => assertSketchConstraintShapes(document),
    'The project has an invalid sketch constraint.'
  );
  attempt(
    () => assertReferenceDocumentSchema(document),
    'The project has an invalid reference dimension schema.'
  );
  attempt(
    () => assertDocumentTextBudget(document),
    'The project exceeds its text budget.'
  );
  attempt(
    () => assertDocumentContentSchema(document),
    'The project has an invalid content schema.'
  );
  // Undo and redo can restore imports that are absent from current nodes.
  check(
    hasValidImportedStepSources(document),
    'The project has invalid imported STEP source data.'
  );
  check(
    hasValidImportedMeshSources(document),
    'The project has invalid imported mesh data.'
  );
  return document;
}
