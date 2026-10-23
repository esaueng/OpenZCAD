import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  assertStorableDocument,
  createProjectDocument,
  importStepBody,
  UnstorableDocumentError
} from '@openzcad/document-core';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { splitProjectStorageUpload } from '@openzcad/persistence';
import {
  MAX_DOCUMENT_VALUES,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';

const owner = toUserId('user_storable');

function valid(): ProjectDocument {
  return addPrimitiveFeature(createProjectDocument('Storable', owner), {
    name: 'Box',
    primitiveKind: 'box',
    dimensions: { width: 1, height: 1, depth: 1 }
  });
}

function importedDocument(): ProjectDocument {
  return importStepBody(createProjectDocument('Imported', owner), {
    name: 'Exact import',
    artifactId: 'artifact_local_source',
    sourceName: 'part.step',
    stepSourceRef: {
      marker: 'openzcad-source-ref',
      version: 1,
      hashAlgorithm: 'sha256',
      checksumSha256: 'a'.repeat(64),
      logicalBytes: 14
    }
  }).document;
}

function refusal(value: unknown): string {
  try {
    assertStorableDocument(value);
  } catch (error) {
    expect(error).toBeInstanceOf(UnstorableDocumentError);
    return (error as Error).message;
  }
  throw new Error('The document was accepted.');
}

/**
 * ADR-024 Phase 1: the account and the room stop reading document contents,
 * so the browser runs every check they made before it writes or adopts one.
 */
describe('assertStorableDocument', () => {
  it('returns the normalized document for a valid one', () => {
    expect(() => assertStorableDocument(importedDocument())).not.toThrow();
    const document = valid();
    expect(assertStorableDocument(document)).toMatchObject({
      projectId: document.projectId,
      featureOrder: document.featureOrder
    });
  });

  it.each([
    ['a non-object', () => 'document', /must be an object/],
    [
      'a newer schema',
      () => ({
        ...valid(),
        schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION + 1
      }),
      /newer OpenZCAD/
    ],
    [
      'a malformed Objects folder section',
      () => ({ ...valid(), objectFolders: 'folders' }),
      /objectFolders/
    ],
    [
      'a malformed drawing section',
      () => ({ ...valid(), drawings: 'drawings' }),
      /drawings/
    ],
    [
      'a malformed reference-image section',
      () => ({ ...valid(), referenceImages: 'images' }),
      /referenceImages/
    ],
    [
      'invalid imported STEP source data',
      () =>
        JSON.parse(
          JSON.stringify(importedDocument()).replace(
            'a'.repeat(64),
            'not-a-checksum'
          )
        ) as unknown,
      /imported STEP source/
    ]
  ])('refuses %s', (_case, build, message) => {
    expect(refusal(build())).toMatch(message);
  });

  it('opens older documents the way loading always has', () => {
    // An undo history saved under an earlier schema, a document from before
    // schema versions existed, and stray checkpoint entries are migrated by
    // normalization rather than refused.
    const manager = new CommandManager(createProjectDocument('Older', owner));
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      })
    );
    const withHistory = manager.document;
    expect(withHistory.editHistory).toBeDefined();
    const older = { ...withHistory, schemaVersion: 30 };
    expect(assertStorableDocument(older)).toMatchObject({
      schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
      featureOrder: withHistory.featureOrder
    });
    const { schemaVersion: _schema, ...unversioned } = valid();
    expect(assertStorableDocument(unversioned).schemaVersion).toBe(
      PROJECT_DOCUMENT_SCHEMA_VERSION
    );
    expect(
      assertStorableDocument({ ...valid(), checkpoints: [null] }).checkpoints
    ).toEqual([]);
  });

  it('measures structure without the derived geometry it never stores or sends', () => {
    const document = valid();
    const dense = new Array(MAX_DOCUMENT_VALUES + 1).fill(0);
    const withMesh = {
      ...document,
      derived: {
        ...document.derived,
        bodyRepresentations: { body_dense: { vertices: dense } }
      }
    } as unknown as ProjectDocument;
    expect(() => assertStorableDocument(withMesh)).not.toThrow();
    // The same values in stored content are still refused.
    expect(refusal({ ...document, padding: dense })).toMatch(/more than/);
  });

  it('runs before every account write, so an invalid document is never uploaded', async () => {
    await expect(
      splitProjectStorageUpload({
        ...valid(),
        objectFolders: 'folders'
      } as unknown as ProjectDocument)
    ).rejects.toBeInstanceOf(UnstorableDocumentError);
    await expect(splitProjectStorageUpload(valid())).resolves.toMatchObject({
      storageAssets: []
    });
  });
});
