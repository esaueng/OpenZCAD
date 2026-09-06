import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toProjectId,
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
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid project backup structure.');
  }
  return value as Record<string, unknown>;
}

function validateDocument(value: unknown): asserts value is ProjectDocument {
  const doc = record(value);
  if (doc.schemaVersion !== PROJECT_DOCUMENT_SCHEMA_VERSION) {
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

export function backupFileBytes(file: BackupFile): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(file.base64), (character) =>
    character.charCodeAt(0)
  );
}

async function checksum(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
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
  for (const value of Object.values(parsed.document.assets)) {
    if (!value.artifactId || !ids.has(value.artifactId))
      throw new Error(`Project backup is missing asset: ${value.name}`);
  }
  return parsed as unknown as ProjectBackup;
}

export function importProjectCopy(
  backup: ProjectBackup,
  ownerUserId: UserId
): ProjectBackup {
  const copy = structuredClone(backup);
  const projectId = toProjectId(`proj_${crypto.randomUUID()}`);
  copy.document.projectId = projectId;
  copy.document.ownerUserId = ownerUserId;
  const root = copy.document.nodes[copy.document.rootNodeId];
  if (root?.kind === 'project') root.projectId = projectId;
  for (const file of copy.files) {
    file.artifact.projectId = projectId;
    file.artifact.objectKey = '';
  }
  for (const asset of Object.values(copy.document.assets))
    asset.storage = 'local';
  return copy;
}
