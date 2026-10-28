import { documentAssetsWithHistory } from '@openzcad/shared';
import type { StoredMeasurementRecord } from './measurementRecord';
import { withoutDerivedProjection } from '@openzcad/document-core';
import { importArtifactIds } from '@openzcad/persistence';
import type { ArtifactRecord, ProjectDocument } from '@openzcad/shared';
import { api, isEncryptedProject } from './api';
import { desktopFetch } from './desktopBridge';
import { prepareProjectSources, type ProjectSource } from './projectSources';
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
    /** Original interchange files are optional; rebuild sources always travel. */
    includeOriginalImports?: boolean;
    /** Reuse one project-scoped catalog throughout a bulk download. */
    artifacts?: readonly ArtifactRecord[];
    /** Complete cloud retention catalog, when a bulk export already read it. */
    retainedRevisionIds?: ReadonlySet<string>;
    /** Avoid parsing the finished backup again just to discover its coverage. */
    onSaveState?(revisionId: string): void;
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
  const snapshot = withoutDerivedProjection(document);
  const storedFiles = await loadProjectBackupFiles(snapshot.projectId);
  // Internal mesh payloads belong in sources, where their content key makes
  // one copy serve the current document, undo history and saved states.
  // Keep older backups' file bytes available as a source-resolution fallback.
  // Reference-image pictures (I05) are sources in the same way.
  const files: ProjectBackup['files'] = [];
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
  let bytesUsed = new Blob([JSON.stringify({ ...backup, document: null })])
    .size;
  const ensureSpace = (length: number) => {
    if (bytesUsed + length > maxBytes) throw capacityError();
  };
  const reserve = (length: number) => {
    ensureSpace(length);
    bytesUsed += length;
  };
  ensureSpace(0);
  const artifacts =
    remote &&
    (!isEncryptedProject(snapshot.projectId) || options.includeEncryptedFiles)
      ? (options.artifacts ??
        (await api.listArtifacts(snapshot.projectId)).artifacts)
      : [];
  const sourceChecksums = new Set<string>();
  async function archiveSource(source: ProjectSource): Promise<string> {
    const { ref, artifactId } = source;
    if (sourceChecksums.has(ref.checksumSha256)) return artifactId;
    ensureSpace(4 * Math.ceil(ref.logicalBytes / 3));
    let bytes = source.bytes ?? (await loadSourceBlob(ref.checksumSha256));
    if (!bytes) {
      const archived = storedFiles.find(
        (file) => file.artifact.artifactId === artifactId
      );
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
      throw new Error(
        `Missing or damaged ${source.kind === 'mesh-payload' ? 'mesh data' : source.kind === 'reference-image' ? 'image' : 'STEP source'}: ${source.name}`
      );
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    const packed = {
      sha256: ref.checksumSha256,
      logicalBytes: bytes.length,
      base64: btoa(binary)
    };
    reserve(new Blob([JSON.stringify(packed)]).size);
    backup.sources!.push(packed);
    sourceChecksums.add(ref.checksumSha256);
    return artifactId;
  }
  backup.document = await prepareProjectSources(snapshot, archiveSource);
  reserve(new Blob([JSON.stringify(backup.document)]).size - 4);
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
      (remote &&
      !privatePoint &&
      (options.retainedRevisionIds === undefined ||
        options.retainedRevisionIds.has(checkpoint.revisionId))
        ? await api.loadRevision(snapshot.projectId, checkpoint.revisionId)
        : null);
    if (saved) {
      const state = {
        checkpointId: checkpoint.checkpointId,
        document: await prepareProjectSources(saved, archiveSource),
        ...(privatePoint ? { deviceOnly: true as const } : {})
      };
      reserve(new Blob([JSON.stringify(state)]).size);
      backup.saveStates!.push(state);
      const revisionId = state.document.revisions.at(-1)?.revisionId;
      if (revisionId) options.onSaveState?.(revisionId);
    }
  }
  // Assets not satisfied by canonical sources still need their file contents.
  const requiredFiles = new Set<string>();
  for (const candidate of [
    backup.document,
    ...backup.saveStates!.map((state) => state.document)
  ]) {
    for (const asset of documentAssetsWithHistory(candidate)) {
      if (
        asset.artifactId &&
        (!asset.checksum || !sourceChecksums.has(asset.checksum))
      )
        requiredFiles.add(asset.artifactId);
    }
  }
  const originalImport = (kind: string) =>
    ['step-import', 'stl-import', 'mesh-import'].includes(kind);
  const wantFile = (artifact: ArtifactRecord) =>
    artifact.kind !== 'mesh-payload' &&
    artifact.kind !== 'reference-image' &&
    (!originalImport(artifact.kind) ||
      options.includeOriginalImports ||
      requiredFiles.has(artifact.artifactId));
  const addFile = (file: ProjectBackup['files'][number]) => {
    if (
      file.artifact.kind === 'step-import' &&
      sourceChecksums.has(file.sha256)
    ) {
      // Even an opt-in original under a different archive ID need not repeat
      // identical STEP bytes. Its metadata can resolve the canonical source.
      for (const candidate of [
        backup.document,
        ...backup.saveStates!.map((state) => state.document)
      ]) {
        for (const asset of documentAssetsWithHistory(candidate)) {
          if (asset.artifactId === file.artifact.artifactId)
            asset.checksum = file.sha256;
        }
      }
      return;
    }
    reserve(new Blob([JSON.stringify(file)]).size);
    files.push(file);
  };
  for (const file of storedFiles) {
    if (wantFile(file.artifact)) addFile(file);
  }
  // Bulk exports keep archived exports too, using the verified blob reader.
  if (
    remote &&
    (!isEncryptedProject(snapshot.projectId) || options.includeEncryptedFiles)
  ) {
    for (const artifact of artifacts) {
      if (
        !wantFile(artifact) ||
        files.some((file) => file.artifact.artifactId === artifact.artifactId)
      )
        continue;
      if (artifact.bytes !== undefined)
        ensureSpace(4 * Math.ceil(artifact.bytes / 3));
      const body = await archivedBytes(
        artifact.artifactId,
        Math.max(0, Math.floor(((maxBytes - bytesUsed) * 3) / 4))
      );
      addFile(await packBackupFile(artifact, body.buffer));
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
