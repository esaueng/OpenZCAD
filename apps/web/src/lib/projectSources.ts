import {
  documentAssetsWithHistory,
  documentNodesWithHistory,
  encodeImportedMeshPayload,
  referenceImagesWithHistory,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  isImportedMeshSourceData,
  isImportedStepSourceData,
  toArtifactId,
  type ImportedSourceReference,
  type ProjectDocument
} from '@openzcad/shared';
import {
  UnstorableDocumentError,
  withoutDerivedProjection
} from '@openzcad/document-core';
import { checksum } from './projectBackup';
import { meshPayloadArchive } from './importArchival';

export interface ProjectSource {
  artifactId: string;
  name: string;
  kind: 'step-import' | 'mesh-payload' | 'reference-image';
  contentType: string;
  ref: ImportedSourceReference;
  /** Legacy imports already carry their rebuild data in the document. */
  bytes?: Uint8Array<ArrayBuffer>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Turn legacy embedded imports into the existing content-addressed form,
 * including commands and undo/redo fragments. Callers archive the source bytes
 * before publishing the returned copy. The input is untouched. Original mesh
 * interchange files are never substituted for the canonical triangles.
 */
export async function prepareProjectSources(
  document: ProjectDocument,
  archive: (source: ProjectSource) => Promise<string>
): Promise<ProjectDocument> {
  const copy = structuredClone(withoutDerivedProjection(document));
  const byArtifact = new Map<string, ProjectSource & { blobId: string }>();
  const embeddedSteps = new Map<string, ImportedSourceReference>();
  const visited = new Set<object>();
  let externalized = false;

  async function prepare(
    payload: Record<string, unknown>,
    kind: 'step-import' | 'mesh-payload'
  ) {
    if (visited.has(payload)) return;
    visited.add(payload);
    const artifactId = payload.artifactId as string;
    const sourceName = payload.sourceName as string;
    const data = {
      ...payload,
      featureKind: kind === 'step-import' ? 'imported-step' : 'imported-mesh'
    };
    if (
      !(kind === 'step-import'
        ? isImportedStepSourceData(data)
        : isImportedMeshSourceData(data))
    )
      throw new UnstorableDocumentError(
        `Invalid rebuild data for "${sourceName}".`
      );
    const key = kind === 'step-import' ? 'stepSourceRef' : 'meshPayloadRef';
    let ref = payload[key] as ImportedSourceReference | undefined;
    let bytes: Uint8Array<ArrayBuffer> | undefined;
    if (kind === 'step-import' && typeof payload.stepText === 'string') {
      externalized = true;
      ref = embeddedSteps.get(payload.stepText);
      if (!ref) {
        bytes = new TextEncoder().encode(payload.stepText);
        ref = await reference(bytes);
        embeddedSteps.set(payload.stepText, ref);
      }
    } else if (
      kind === 'mesh-payload' &&
      Array.isArray(payload.vertices) &&
      Array.isArray(payload.indices)
    ) {
      externalized = true;
      bytes = encodeImportedMeshPayload({
        vertices: payload.vertices,
        indices: payload.indices
      });
      ref = await reference(bytes);
    }
    if (!ref)
      throw new UnstorableDocumentError(
        `Missing rebuild data for "${sourceName}".`
      );
    const source: ProjectSource = {
      artifactId,
      name: sourceName,
      kind,
      contentType:
        kind === 'step-import'
          ? 'model/step'
          : meshPayloadArchive(sourceName).contentType,
      ref,
      ...(bytes ? { bytes } : {})
    };
    const previous = byArtifact.get(artifactId);
    if (
      previous &&
      (previous.kind !== kind ||
        previous.ref.checksumSha256 !== ref.checksumSha256 ||
        previous.ref.logicalBytes !== ref.logicalBytes)
    )
      throw new UnstorableDocumentError(
        `Conflicting rebuild data for "${sourceName}".`
      );
    const blobId = previous?.blobId ?? (await archive(source));
    byArtifact.set(artifactId, { ...source, blobId });
    payload.artifactId = blobId;
    payload[key] = ref;
    delete payload.stepText;
    delete payload.vertices;
    delete payload.indices;
  }

  async function walk(value: unknown): Promise<void> {
    if (!record(value) && !Array.isArray(value)) return;
    if (record(value) && record(value.payload)) {
      const payload =
        value.kind === 'import.shapr-guided' && record(value.payload.step)
          ? value.payload.step
          : value.payload;
      // A command log can outlive both an imported feature and its undo
      // entries. It must not turn an obsolete archive into a new dependency.
      if (
        typeof payload.artifactId === 'string' &&
        byArtifact.has(payload.artifactId)
      ) {
        if (
          value.kind === 'import.step' ||
          value.kind === 'import.shapr-guided'
        )
          await prepare(payload, 'step-import');
        else if (value.kind === 'import.mesh')
          await prepare(payload, 'mesh-payload');
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (!['derived', 'stepText', 'vertices', 'indices'].includes(key))
        await walk(child);
    }
  }
  for (const node of documentNodesWithHistory(copy)) {
    if (node.kind !== 'feature') continue;
    if (node.data.featureKind === 'imported-step')
      await prepare(node.data, 'step-import');
    else if (node.data.featureKind === 'imported-mesh')
      await prepare(node.data, 'mesh-payload');
  }
  await walk(copy);
  // Older clients must refuse a snapshot whose new source form they cannot
  // rebuild. This uses the existing schema; no version is introduced here.
  if (externalized && copy.schemaVersion < PROJECT_DOCUMENT_SCHEMA_VERSION)
    copy.schemaVersion = PROJECT_DOCUMENT_SCHEMA_VERSION;
  for (const image of referenceImagesWithHistory(copy)) {
    image.artifactId = toArtifactId(
      await archive({
        artifactId: image.artifactId,
        name: image.name,
        kind: 'reference-image',
        contentType: image.contentType,
        ref: image.source
      })
    );
  }
  // Legacy asset entries describe the same source as the import. Point them
  // at the retained canonical data, rather than requiring its original too.
  for (const asset of documentAssetsWithHistory(copy)) {
    const source = asset.artifactId && byArtifact.get(asset.artifactId);
    if (!source) continue;
    asset.artifactId = source.blobId as typeof asset.artifactId;
    asset.checksum = source.ref.checksumSha256;
    asset.bytes = source.ref.logicalBytes;
    asset.contentType = source.contentType;
    if (source.kind === 'mesh-payload') {
      asset.kind = 'mesh-cache';
      asset.name = meshPayloadArchive(source.name).fileName;
    }
  }
  return copy;
}

async function reference(
  bytes: Uint8Array<ArrayBuffer>
): Promise<ImportedSourceReference> {
  return {
    marker: 'openzcad-source-ref',
    version: 1,
    hashAlgorithm: 'sha256',
    checksumSha256: await checksum(bytes),
    logicalBytes: bytes.byteLength
  };
}
