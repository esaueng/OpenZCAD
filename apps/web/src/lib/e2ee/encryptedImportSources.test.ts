import { describe, expect, it } from 'vitest';
import type { ContentBlobReference } from '@openzcad/crypto';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import {
  toArtifactId,
  toUserId,
  type ArtifactRecord,
  type ProjectDocument
} from '@openzcad/shared';
import { createBlobReferenceRegistry } from './blobReferences';
import {
  encryptedImportSourceArtifacts,
  withEncryptedImportSources
} from './encryptedImportSources';

function reference(
  blobId: string,
  kind: ContentBlobReference['kind'],
  plaintextLength: number
): ContentBlobReference {
  return {
    blobId,
    kind,
    key: new Uint8Array(32),
    ciphertextHash: new Uint8Array(32),
    plaintextLength
  };
}

function withImports(
  imports: readonly { artifactId: string; sourceName: string }[]
): ProjectDocument {
  let document = createProjectDocument('Encrypted', toUserId('user_e2ee'));
  for (const [index, entry] of imports.entries()) {
    document = importStepBody(document, {
      name: `Imported ${index + 1}`,
      artifactId: entry.artifactId,
      sourceName: entry.sourceName,
      stepText: 'ISO-10303-21;END-ISO-10303-21;'
    }).document;
  }
  return document;
}

describe("an encrypted project's archived STEP sources (#1649)", () => {
  it('lists each source blob the document names and this page can open', () => {
    const document = withImports([
      { artifactId: 'blob_box', sourceName: 'box.step' },
      // Imported again: the dedupe hit names the same blob.
      { artifactId: 'blob_box', sourceName: 'box.step' },
      { artifactId: 'blob_bracket', sourceName: 'bracket.stp' },
      // An archive that has not run yet: nothing stored to list.
      { artifactId: 'artifact_local_1', sourceName: 'pending.step' },
      // A blob this page holds no key for.
      { artifactId: 'blob_unknown', sourceName: 'elsewhere.step' }
    ]);
    const registry = createBlobReferenceRegistry();
    registry.remember(
      document.projectId,
      reference('blob_box', 'import-source', 7656)
    );
    registry.remember(
      document.projectId,
      reference('blob_bracket', 'import-source', 1200)
    );
    // Held, but for another project: not this project's source.
    registry.remember(
      'project_other',
      reference('blob_unknown', 'import-source', 9)
    );

    const sources = encryptedImportSourceArtifacts(document, registry);
    expect(
      sources.map(({ artifactId, name, kind, bytes, contentType }) => ({
        artifactId,
        name,
        kind,
        bytes,
        contentType
      }))
    ).toEqual([
      {
        artifactId: 'blob_box',
        name: 'box.step',
        kind: 'step-import',
        bytes: 7656,
        contentType: 'model/step'
      },
      {
        artifactId: 'blob_bracket',
        name: 'bracket.stp',
        kind: 'step-import',
        bytes: 1200,
        contentType: 'model/step'
      }
    ]);
    expect(
      sources.every((source) => source.projectId === document.projectId)
    ).toBe(true);
  });

  it('lists no blob of another kind under an import', () => {
    const document = withImports([
      { artifactId: 'blob_mesh', sourceName: 'odd.step' }
    ]);
    const registry = createBlobReferenceRegistry();
    registry.remember(
      document.projectId,
      reference('blob_mesh', 'mesh-payload', 64)
    );
    expect(encryptedImportSourceArtifacts(document, registry)).toEqual([]);
  });

  it('adds sources after the listed files, newest first, each blob once', () => {
    const exported = {
      artifactId: toArtifactId('blob_export'),
      kind: 'step-export',
      name: 'part.step'
    } as ArtifactRecord;
    const source = (artifactId: string) =>
      ({
        artifactId: toArtifactId(artifactId),
        kind: 'step-import'
      }) as ArtifactRecord;
    expect(
      withEncryptedImportSources(
        [exported, source('blob_a')],
        [source('blob_a'), source('blob_b'), source('blob_c')]
      ).map((artifact) => artifact.artifactId)
    ).toEqual(['blob_export', 'blob_a', 'blob_c', 'blob_b']);
    const listed = [exported];
    expect(withEncryptedImportSources(listed, [])).toEqual(listed);
  });
});
