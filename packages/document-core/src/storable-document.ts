import {
  MAX_PROJECT_CHECKPOINTS,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  assertDocumentHistory,
  assertDocumentTextBudget,
  documentEnvelopeError,
  documentStructureError,
  drawingSetError,
  hasValidImportedMeshSources,
  hasValidImportedStepSources,
  isProjectCheckpoint,
  isRevisionRecord,
  objectFolderSetError,
  referenceImageSetError,
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
