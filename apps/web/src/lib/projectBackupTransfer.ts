import { documentNodesWithHistory } from '@openzcad/shared';
import type { StoredMeasurementRecord } from './measurementRecord';
import { withoutDerivedProjection } from '@openzcad/document-core';
import type { ArtifactRecord, ProjectDocument } from '@openzcad/shared';
import { api } from './api';
import {
  loadLastSyncedVersion,
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
        throw new Error('Project backup exceeds the 256 MB limit.');
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

export async function createProjectBackup(
  document: ProjectDocument,
  cloudProject: boolean,
  measurements?: StoredMeasurementRecord
): Promise<string> {
  const snapshot = withoutDerivedProjection(structuredClone(document));
  const files = await loadProjectBackupFiles(snapshot.projectId);
  const backup: ProjectBackup = {
    format: 'openzcad-project',
    version: 1,
    document: snapshot,
    files,
    sources: [],
    saveStates: [],
    measurements:
      measurements ?? (await loadProjectMeasurements(snapshot.projectId))
  };
  const remote =
    cloudProject || (await loadLastSyncedVersion(snapshot.projectId)) !== null;
  let bytesUsed = new Blob([JSON.stringify(backup)]).size;
  const reserve = (length: number) => {
    bytesUsed += length;
    if (bytesUsed > MAX_PROJECT_BACKUP_BYTES)
      throw new Error('Project backup exceeds the 256 MB limit.');
  };
  if (remote) {
    const archived = await api.listArtifacts(snapshot.projectId);
    for (const artifact of archived.artifacts) {
      if (
        files.some((file) => file.artifact.artifactId === artifact.artifactId)
      )
        continue;
      const body = await readBackupResponse(
        await fetch(
          `/api/artifacts/${encodeURIComponent(artifact.artifactId)}/download`
        ),
        Math.max(
          0,
          Math.floor(((MAX_PROJECT_BACKUP_BYTES - bytesUsed) * 3) / 4)
        )
      );
      const file = await packBackupFile(artifact, body.buffer);
      reserve(new Blob([JSON.stringify(file)]).size);
      files.push(file);
    }
  }
  for (const checkpoint of snapshot.checkpoints) {
    const saved =
      (await loadLocalSaveState(snapshot.projectId, checkpoint.checkpointId)) ??
      (remote
        ? await api.loadRevision(snapshot.projectId, checkpoint.revisionId)
        : null);
    if (saved) {
      const state = {
        checkpointId: checkpoint.checkpointId,
        document: withoutDerivedProjection(saved)
      };
      reserve(new Blob([JSON.stringify(state)]).size);
      backup.saveStates!.push(state);
    }
  }
  for (const candidate of [
    snapshot,
    ...backup.saveStates!.map((state) => state.document)
  ]) {
    for (const node of documentNodesWithHistory(candidate)) {
      if (
        node.kind !== 'feature' ||
        node.data.featureKind !== 'imported-step' ||
        !node.data.stepSourceRef
      )
        continue;
      const ref = node.data.stepSourceRef;
      const artifactId = node.data.artifactId;
      if (
        backup.sources!.some((source) => source.sha256 === ref.checksumSha256)
      )
        continue;
      let bytes = await loadSourceBlob(ref.checksumSha256);
      if (!bytes) {
        const archived = files.find(
          (file) => file.artifact.artifactId === artifactId
        );
        bytes = archived
          ? backupFileBytes(archived)
          : await readBackupResponse(
              await fetch(
                `/api/artifacts/${encodeURIComponent(artifactId)}/download`
              )
            );
      }
      if (
        bytes.length !== ref.logicalBytes ||
        (await checksum(bytes)) !== ref.checksumSha256
      )
        throw new Error(`Missing or damaged STEP source: ${node.name}`);
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

export async function downloadProjectArtifact(
  artifact: ArtifactRecord
): Promise<void> {
  const local = (await loadProjectBackupFiles(artifact.projectId)).find(
    (file) => file.artifact.artifactId === artifact.artifactId
  );
  const bytes = local
    ? backupFileBytes(local)
    : await readBackupResponse(
        await fetch(
          `/api/artifacts/${encodeURIComponent(artifact.artifactId)}/download`
        )
      );
  downloadBackupFile(
    artifact.name,
    new Blob([bytes], { type: artifact.contentType })
  );
}
