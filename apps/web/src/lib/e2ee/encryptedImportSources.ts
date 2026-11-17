/**
 * The archived STEP sources of an end-to-end encrypted project, as the File
 * menu's Stored files lists them.
 *
 * An encrypted project archives a STEP import's source as an `import-source`
 * content blob (ADR-024 Phase 4), and its `imported-step` feature names that
 * blob by id. The verified project info lists only exports, so the source
 * an import reported as archived never reached Stored files (#1649). The
 * document already names every such blob, and this page holds a reference
 * (and so the key) for each one it opened or uploaded. Listing them from the
 * document needs no new record and no format change: the entry downloads
 * through the same decrypting reader an encrypted export does.
 *
 * Loads no crypto, like the registry it reads.
 */
import type { ArtifactRecord, ProjectDocument } from '@openzcad/shared';
import { listFeaturesInOrder } from '@openzcad/document-core';
import {
  pageBlobReferences,
  type BlobReferenceRegistry
} from './blobReferences';

export function encryptedImportSourceArtifacts(
  document: ProjectDocument,
  registry: Pick<BlobReferenceRegistry, 'get'> = pageBlobReferences
): ArtifactRecord[] {
  const listed = new Set<string>();
  const sources: ArtifactRecord[] = [];
  for (const feature of listFeaturesInOrder(document)) {
    const data = feature.data;
    if (data.featureKind !== 'imported-step') continue;
    // One blob per plaintext: importing the same file twice names it twice.
    if (listed.has(data.artifactId)) continue;
    // Only a blob this page can open. A local id (an archive that has not
    // run) or a blob of another kind is not a stored source.
    const held = registry.get(document.projectId, data.artifactId);
    if (held?.reference.kind !== 'import-source') continue;
    listed.add(data.artifactId);
    sources.push({
      artifactId: data.artifactId,
      projectId: document.projectId,
      kind: 'step-import',
      name: data.sourceName,
      // Encrypted blobs have no object key a client may name.
      objectKey: '',
      contentType: 'model/step',
      bytes: held.reference.plaintextLength,
      createdAt: '',
      metadata: {}
    });
  }
  return sources;
}

/**
 * The File menu's stored files with the document's archived sources added,
 * newest import first after the listed files, each blob once.
 */
export function withEncryptedImportSources(
  artifacts: readonly ArtifactRecord[],
  sources: readonly ArtifactRecord[]
): ArtifactRecord[] {
  if (sources.length === 0) return [...artifacts];
  const listed = new Set(artifacts.map((artifact) => artifact.artifactId));
  return [
    ...artifacts,
    ...[...sources].reverse().filter((source) => !listed.has(source.artifactId))
  ];
}
