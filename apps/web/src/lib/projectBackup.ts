import {
  normalizeDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import type { StoredMeasurementRecord } from './measurementRecord';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toProjectId,
  toArtifactId,
  isImportedSourceReference,
  isProjectCheckpoint,
  isRevisionRecord,
  type ArtifactRecord,
  type ProjectDocument,
  type UserId
} from '@openzcad/shared';

export const MAX_PROJECT_BACKUP_BYTES = 256 * 1024 * 1024;
export interface BackupFile {
  artifact: ArtifactRecord;
  base64: string;
  sha256: string;
}
export interface ProjectBackup {
  format: 'openzcad-project';
  version: 1;
  document: ProjectDocument;
  files: BackupFile[];
  sources?: { sha256: string; base64: string; logicalBytes: number }[];
  saveStates?: { checkpointId: string; document: ProjectDocument }[];
  measurements?: StoredMeasurementRecord | null;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid project backup structure.');
  }
  return value as Record<string, unknown>;
}

function validateDocument(value: unknown): asserts value is ProjectDocument {
  const doc = record(value);
  if (
    !Number.isInteger(doc.schemaVersion) ||
    Number(doc.schemaVersion) < 4 ||
    Number(doc.schemaVersion) > PROJECT_DOCUMENT_SCHEMA_VERSION
  ) {
    throw new Error(
      'Unsupported project schema. Update OpenZCAD to open this backup.'
    );
  }
  for (const key of [
    'projectId',
    'ownerUserId',
    'rootNodeId',
    'rootAssemblyId',
    'activePartId',
    'name'
  ]) {
    if (typeof doc[key] !== 'string' || !doc[key])
      throw new Error(`Invalid project ${key}.`);
  }
  if (
    !['mm', 'cm', 'm', 'inch'].includes(String(doc.units)) ||
    !Number.isSafeInteger(doc.version) ||
    Number(doc.version) < 1
  ) {
    throw new Error('Invalid project units or version.');
  }
  const nodes = record(doc.nodes);
  for (const [id, value] of Object.entries(nodes)) {
    const node = record(value);
    if (
      node.id !== id ||
      ![
        'project',
        'assembly',
        'part',
        'parameter',
        'sketch',
        'sketch-object',
        'feature',
        'body'
      ].includes(String(node.kind)) ||
      typeof node.name !== 'string'
    )
      throw new Error('Invalid project node.');
    if (
      node.kind === 'assembly' ||
      node.kind === 'part' ||
      node.kind === 'sketch'
    ) {
      const children = node.kind === 'sketch' ? node.objectIds : node.childIds;
      if (
        !Array.isArray(children) ||
        !children.every(
          (child) => typeof child === 'string' && Object.hasOwn(nodes, child)
        )
      )
        throw new Error('Invalid project children.');
    }
    if (node.kind === 'feature') record(node.data);
    if (node.kind === 'sketch') record(node.planeRef);
  }
  for (const [key, kind] of [
    ['rootNodeId', 'project'],
    ['rootAssemblyId', 'assembly'],
    ['activePartId', 'part']
  ] as const) {
    if (record(nodes[String(doc[key])]).kind !== kind)
      throw new Error('Invalid project root.');
  }
  const nodeValues = Object.values(nodes).map(record);
  for (const key of [
    'featureOrder',
    'bodyOrder',
    'sketchOrder',
    'parameterOrder'
  ]) {
    const ids = new Set(
      nodeValues.map((node) => node[key.replace('Order', 'Id')])
    );
    if (
      !Array.isArray(doc[key]) ||
      !(doc[key] as unknown[]).every(
        (id) => typeof id === 'string' && ids.has(id)
      )
    )
      throw new Error(`Invalid project ${key}.`);
  }
  for (const key of ['revisions', 'checkpoints', 'commandLog']) {
    if (!Array.isArray(doc[key])) throw new Error(`Invalid project ${key}.`);
    for (const item of doc[key]) record(item);
    if (key === 'revisions' && !doc[key].every(isRevisionRecord))
      throw new Error('Invalid project revisions.');
    if (key === 'checkpoints' && !doc[key].every(isProjectCheckpoint))
      throw new Error('Invalid project checkpoints.');
  }
  record(doc.assets);
  const derived = record(doc.derived);
  record(derived.bodyRepresentations);
  if (
    !Array.isArray(derived.exportableBodyIds) ||
    !Array.isArray(derived.warnings) ||
    typeof derived.updatedAt !== 'string'
  )
    throw new Error('Invalid project derived state.');
}

export function backupFileBytes(file: {
  base64: string;
}): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(file.base64), (character) =>
    character.charCodeAt(0)
  );
}

export async function checksum(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

export async function packBackupFile(
  artifact: ArtifactRecord,
  body: ArrayBuffer
): Promise<BackupFile> {
  const bytes = new Uint8Array(body);
  let binary = '';
  for (let start = 0; start < bytes.length; start += 32768) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
  }
  return {
    artifact: { ...artifact, bytes: bytes.length },
    base64: btoa(binary),
    sha256: await checksum(bytes)
  };
}

export async function parseProjectBackup(text: string): Promise<ProjectBackup> {
  if (new Blob([text]).size > MAX_PROJECT_BACKUP_BYTES)
    throw new Error('Project backup exceeds the 256 MB limit.');
  const parsed = record(JSON.parse(text));
  if (parsed.format !== 'openzcad-project' || parsed.version !== 1)
    throw new Error('Not a supported OpenZCAD project backup.');
  validateDocument(parsed.document);
  if (!Array.isArray(parsed.files))
    throw new Error('Project backup is missing its files.');
  const ids = new Set<string>();
  for (const value of parsed.files) {
    const file = record(value);
    const artifact = record(file.artifact);
    if (
      typeof artifact.artifactId !== 'string' ||
      ids.has(artifact.artifactId) ||
      artifact.projectId !== parsed.document.projectId ||
      typeof artifact.name !== 'string' ||
      typeof artifact.contentType !== 'string' ||
      typeof file.base64 !== 'string' ||
      typeof file.sha256 !== 'string'
    )
      throw new Error('Invalid archived file.');
    ids.add(artifact.artifactId);
    const bytes = backupFileBytes(value as BackupFile);
    if (
      bytes.length !== artifact.bytes ||
      (await checksum(bytes)) !== file.sha256
    )
      throw new Error(`Archived file is damaged: ${artifact.name}`);
  }
  const sourceIds = new Set<string>();
  if (parsed.sources !== undefined && !Array.isArray(parsed.sources))
    throw new Error('Invalid source collection.');
  for (const value of (parsed.sources ?? []) as unknown[]) {
    const source = record(value);
    if (
      typeof source.sha256 !== 'string' ||
      typeof source.base64 !== 'string' ||
      sourceIds.has(source.sha256)
    )
      throw new Error('Invalid source blob.');
    const bytes = backupFileBytes(source as { base64: string });
    if (
      bytes.length !== source.logicalBytes ||
      (await checksum(bytes)) !== source.sha256
    )
      throw new Error('Damaged source blob.');
    sourceIds.add(source.sha256);
  }
  const documents = [parsed.document];
  if (parsed.saveStates !== undefined && !Array.isArray(parsed.saveStates))
    throw new Error('Invalid save states.');
  const checkpoints = new Set<string>();
  for (const value of (parsed.saveStates ?? []) as unknown[]) {
    const state = record(value);
    validateDocument(state.document);
    const checkpoint = parsed.document.checkpoints.find(
      (entry) => entry.checkpointId === state.checkpointId
    );
    if (
      !checkpoint ||
      checkpoints.has(checkpoint.checkpointId) ||
      state.document.projectId !== parsed.document.projectId ||
      checkpoint.documentVersion !== state.document.version
    )
      throw new Error('Invalid save state identity.');
    checkpoints.add(checkpoint.checkpointId);
    documents.push(state.document);
  }
  for (const document of documents) {
    for (const node of Object.values(document.nodes)) {
      if (
        node.kind === 'feature' &&
        node.data.featureKind === 'imported-step' &&
        node.data.stepSourceRef !== undefined
      ) {
        if (
          !isImportedSourceReference(node.data.stepSourceRef) ||
          !sourceIds.has(node.data.stepSourceRef.checksumSha256)
        )
          throw new Error(`Missing STEP source: ${node.name}`);
        const sourceRef = node.data.stepSourceRef;
        const source = (
          parsed.sources as NonNullable<ProjectBackup['sources']>
        ).find((entry) => entry.sha256 === sourceRef.checksumSha256);
        if (source?.logicalBytes !== node.data.stepSourceRef.logicalBytes)
          throw new Error('Invalid STEP source length.');
      }
    }
    for (const asset of Object.values(document.assets)) {
      if (
        (!asset.artifactId || !ids.has(asset.artifactId)) &&
        (!asset.checksum || !sourceIds.has(asset.checksum))
      )
        throw new Error(`Project backup is missing asset: ${asset.name}`);
    }
  }
  if (parsed.measurements !== undefined && parsed.measurements !== null) {
    const { parseStoredMeasurements } = await import('./measurementStore');
    const measurements = parseStoredMeasurements(parsed.measurements);
    if (!measurements || measurements.projectId !== parsed.document.projectId)
      throw new Error('Invalid measurements.');
    const original = record(parsed.measurements);
    if (
      !Array.isArray(original.measurements) ||
      measurements.measurements.length !== original.measurements.length
    )
      throw new Error('Invalid measurements.');
  }
  return parsed as unknown as ProjectBackup;
}

export function importProjectCopy(
  backup: ProjectBackup,
  ownerUserId: UserId
): ProjectBackup {
  const copy = structuredClone(backup);
  const projectId = toProjectId(`proj_${crypto.randomUUID()}`);
  for (const document of [
    copy.document,
    ...(copy.saveStates ?? []).map((state) => state.document)
  ]) {
    const normalized = withoutDerivedProjection(normalizeDocument(document));
    Object.assign(document, normalized, { projectId, ownerUserId });
    const root = document.nodes[document.rootNodeId];
    if (root?.kind === 'project') root.projectId = projectId;
    for (const asset of Object.values(document.assets)) asset.storage = 'local';
  }
  for (const file of copy.files) {
    file.artifact.projectId = projectId;
    file.artifact.objectKey = '';
  }
  // A copy must archive its own sources when saved to another account. Keeping
  // the old remote IDs would make that path mistake foreign files for its own.
  const artifactIds = new Map<string, string>();
  const pending: unknown[] = [copy];
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (
        key === 'artifactId' &&
        typeof child === 'string' &&
        !child.startsWith('artifact_local_')
      ) {
        let id = artifactIds.get(child);
        if (!id) {
          id = toArtifactId(`artifact_local_${crypto.randomUUID()}`);
          artifactIds.set(child, id);
        }
        (value as Record<string, unknown>)[key] = id;
      } else if (child && typeof child === 'object') pending.push(child);
    }
  }
  if (copy.measurements) copy.measurements.projectId = projectId;
  return copy;
}
