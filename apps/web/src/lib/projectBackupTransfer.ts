import {
  documentNodesWithHistory,
  importedSourceReferenceOf,
  referenceImagesWithHistory,
  type ImportedSourceReference
} from '@openzcad/shared';
import type { StoredMeasurementRecord } from './measurementRecord';
import { withoutDerivedProjection } from '@openzcad/document-core';
import { importArtifactIds } from '@openzcad/persistence';
import type { ArtifactRecord, ProjectDocument } from '@openzcad/shared';
import { api, isEncryptedProject } from './api';
import { desktopFetch } from './desktopBridge';
import { encryptedBlobSource } from './e2ee/blobReferences';
import {
  loadLastSyncedVersion,
  listLocalSaveStateCheckpoints,
  loadLocalSaveState,
  loadProjectBackupFiles,
  loadProjectMeasurements,
  loadSourceBlob
} from './localProjectStore';
import {
  MAX_PROJECT_BACKUP_BYTES,
  backupFileBytes,
  checksum,
  packBackupFile,
  parseProjectBackup,
  type ProjectBackup
} from './projectBackup';

function downloadSizeError(limit: number): Error {
  return new Error(
    limit === MAX_PROJECT_BACKUP_BYTES
      ? 'Project backup exceeds the 256 MB limit.'
      : 'Project backup exceeds the remaining download size limit.'
  );
}

export async function readBackupResponse(
  response: Response,
  limit = MAX_PROJECT_BACKUP_BYTES
): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.ok)
    throw new Error(`Could not fetch project file (${response.status}).`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Project file response was empty.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) {
        await reader.cancel();
        throw downloadSizeError(limit);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/**
 * An archived file's bytes: an encrypted project's blob is downloaded and
 * decrypted in the decode worker against the reference this page holds
 * (ADR-024 Phase 4); anything else is the plaintext download.
 */
async function archivedBytes(
  artifactId: string,
  limit?: number
): Promise<Uint8Array<ArrayBuffer>> {
  const encrypted = encryptedBlobSource(artifactId);
  if (encrypted) {
    const bytes = await encrypted.read();
    if (limit !== undefined && bytes.byteLength > limit)
      throw downloadSizeError(limit);
    return new Uint8Array(bytes);
  }
  return readBackupResponse(
    await desktopFetch(
      `/api/artifacts/${encodeURIComponent(artifactId)}/download`
    ),
    limit
  );
}

export async function createProjectBackup(
  document: ProjectDocument,
  cloudProject: boolean,
  measurements?: StoredMeasurementRecord | null,
  options: {
    localOnly?: boolean;
    includeEncryptedFiles?: boolean;
    /** A bulk export can impose a smaller remaining staging budget. */
    maxBytes?: number;
  } = {}
): Promise<string> {
  const maxBytes = Math.min(
    MAX_PROJECT_BACKUP_BYTES,
    Math.max(0, options.maxBytes ?? MAX_PROJECT_BACKUP_BYTES)
  );
  const capacityError = () =>
    new Error(
      maxBytes < MAX_PROJECT_BACKUP_BYTES
        ? 'Project backup exceeds the remaining bulk-download memory budget. Download this project separately.'
        : 'Project backup exceeds the 256 MB limit.'
    );
  const snapshot = withoutDerivedProjection(structuredClone(document));
  const storedFiles = await loadProjectBackupFiles(snapshot.projectId);
  // Internal mesh payloads belong in sources, where their content key makes
  // one copy serve the current document, undo history and saved states.
  // Keep older backups' file bytes available as a source-resolution fallback.
  // Reference-image pictures (I05) are sources in the same way.
  const files = storedFiles.filter(
    (file) =>
      file.artifact.kind !== 'mesh-payload' &&
      file.artifact.kind !== 'reference-image'
  );
  const backup: ProjectBackup = {
    format: 'openzcad-project',
    version: 1,
    document: snapshot,
    files,
    sources: [],
    saveStates: [],
    measurements:
      measurements === undefined
        ? await loadProjectMeasurements(snapshot.projectId)
        : measurements
  };
  const remote =
    !options.localOnly &&
    (cloudProject ||
      (await loadLastSyncedVersion(snapshot.projectId)) !== null);
  let bytesUsed = new Blob([JSON.stringify(backup)]).size;
  const ensureSpace = (length: number) => {
    if (bytesUsed + length > maxBytes) throw capacityError();
  };
  const reserve = (length: number) => {
    ensureSpace(length);
    bytesUsed += length;
  };
  ensureSpace(0);
  // Bulk data downloads also carry exports from encrypted project info.
  // Their bytes are opened through the same verified blob reader as sources.
  if (
    remote &&
    (!isEncryptedProject(snapshot.projectId) || options.includeEncryptedFiles)
  ) {
    const archived = await api.listArtifacts(snapshot.projectId);
    for (const artifact of archived.artifacts) {
      if (
        artifact.kind === 'mesh-payload' ||
        artifact.kind === 'reference-image' ||
        files.some((file) => file.artifact.artifactId === artifact.artifactId)
      )
        continue;
      if (artifact.bytes !== undefined)
        ensureSpace(4 * Math.ceil(artifact.bytes / 3));
      const body = await archivedBytes(
        artifact.artifactId,
        Math.max(0, Math.floor(((maxBytes - bytesUsed) * 3) / 4))
      );
      const file = await packBackupFile(artifact, body.buffer);
      reserve(new Blob([JSON.stringify(file)]).size);
      files.push(file);
    }
  }
  const canonicalIds = new Set(
    snapshot.checkpoints.map((checkpoint) => checkpoint.checkpointId)
  );
  const deviceOnly = (
    await listLocalSaveStateCheckpoints(snapshot.projectId)
  ).filter((checkpoint) => !canonicalIds.has(checkpoint.checkpointId));
  for (const checkpoint of [...snapshot.checkpoints, ...deviceOnly]) {
    const privatePoint = !canonicalIds.has(checkpoint.checkpointId);
    const local = await loadLocalSaveState(
      snapshot.projectId,
      checkpoint.checkpointId
    );
    // A migration can retain the checkpoint under a new signed version.
    // A cached plaintext snapshot still has its original version and files;
    // use the canonical remote snapshot rather than exporting that stale copy.
    const stale =
      remote &&
      !privatePoint &&
      local &&
      (local.version !== checkpoint.documentVersion ||
        (isEncryptedProject(snapshot.projectId) &&
          importArtifactIds(local).some((id) => id.startsWith('artifact_'))));
    const saved =
      (stale ? null : local) ??
      (remote && !privatePoint
        ? await api.loadRevision(snapshot.projectId, checkpoint.revisionId)
        : null);
    if (saved) {
      const state = {
        checkpointId: checkpoint.checkpointId,
        document: withoutDerivedProjection(saved),
        ...(privatePoint ? { deviceOnly: true as const } : {})
      };
      reserve(new Blob([JSON.stringify(state)]).size);
      backup.saveStates!.push(state);
    }
  }
  for (const candidate of [
    snapshot,
    ...backup.saveStates!.map((state) => state.document)
  ]) {
    // STEP sources and mesh payloads: a restored project must rebuild
    // without the account, so it carries the bytes its references name. A
    // reference image's picture travels the same way.
    const needed: {
      ref: ImportedSourceReference;
      artifactId: string;
      what: string;
    }[] = [];
    for (const node of documentNodesWithHistory(candidate)) {
      if (node.kind !== 'feature') continue;
      const ref = importedSourceReferenceOf(node.data);
      if (!ref) continue;
      needed.push({
        ref,
        artifactId: (node.data as { artifactId: string }).artifactId,
        what: `${node.data.featureKind === 'imported-mesh' ? 'mesh data' : 'STEP source'}: ${node.name}`
      });
    }
    for (const image of referenceImagesWithHistory(candidate)) {
      needed.push({
        ref: image.source,
        artifactId: image.artifactId,
        what: `image: ${image.name}`
      });
    }
    for (const { ref, artifactId, what } of needed) {
      if (
        backup.sources!.some((source) => source.sha256 === ref.checksumSha256)
      )
        continue;
      // Reject a source that cannot fit before reading or base64-encoding it.
      ensureSpace(4 * Math.ceil(ref.logicalBytes / 3));
      let bytes = await loadSourceBlob(ref.checksumSha256);
      if (!bytes) {
        const archived =
          storedFiles.find((file) => file.artifact.artifactId === artifactId) ??
          files.find((file) => file.artifact.artifactId === artifactId);
        bytes = archived
          ? backupFileBytes(archived)
          : options.localOnly
            ? null
            : await archivedBytes(
                artifactId,
                Math.max(0, Math.floor(((maxBytes - bytesUsed) * 3) / 4))
              );
      }
      if (
        !bytes ||
        bytes.length !== ref.logicalBytes ||
        (await checksum(bytes)) !== ref.checksumSha256
      )
        throw new Error(`Missing or damaged ${what}`);
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768)
        binary += String.fromCharCode(
          ...bytes.subarray(offset, offset + 32768)
        );
      const source = {
        sha256: ref.checksumSha256,
        logicalBytes: bytes.length,
        base64: btoa(binary)
      };
      reserve(new Blob([JSON.stringify(source)]).size);
      backup.sources!.push(source);
    }
  }
  const text = JSON.stringify(backup);
  if (new Blob([text]).size > maxBytes) throw capacityError();
  await parseProjectBackup(text);
  return text;
}

export function downloadBackupFile(name: string, contents: Blob): void {
  const url = URL.createObjectURL(contents);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Saves a stored file. An encrypted project's archived export is decrypted
 * in the decode worker and saved from a blob URL (ADR-024 Phase 4, slice
 * 4-7); anything else is this device's backup or the plaintext download.
 */
export async function downloadProjectArtifact(
  artifact: ArtifactRecord
): Promise<void> {
  const local = (await loadProjectBackupFiles(artifact.projectId)).find(
    (file) => file.artifact.artifactId === artifact.artifactId
  );
  const bytes = local
    ? backupFileBytes(local)
    : await archivedBytes(artifact.artifactId);
  downloadBackupFile(
    artifact.name,
    new Blob([bytes], { type: artifact.contentType })
  );
}
