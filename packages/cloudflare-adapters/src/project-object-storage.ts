import type { ProjectDocument } from '@openzcad/shared';

export const PROJECT_OBJECT_STORAGE_FORMAT = 'openzcad-project-object';
export const PROJECT_OBJECT_STORAGE_VERSION = 1;
export const PROJECT_OBJECT_STORAGE_PREFIX = 'project-storage';

const PROJECT_ASSET_REFERENCE_MARKER = 'openzcad-project-asset';
const PROJECT_ASSET_REFERENCE_VERSION = 1;
const MESH_PAYLOAD_REFERENCE_KEY = '__openzcadMeshPayload';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type ProjectStorageAssetKind = 'step-source' | 'mesh-payload';

export interface ProjectStorageAssetReference {
  marker: typeof PROJECT_ASSET_REFERENCE_MARKER;
  version: typeof PROJECT_ASSET_REFERENCE_VERSION;
  kind: ProjectStorageAssetKind;
  objectKey: string;
  checksumSha256: string;
  logicalBytes: number;
  contentEncoding: 'gzip';
}

export interface ProjectStorageAssetObject extends ProjectStorageAssetReference {
  storedBody: Uint8Array;
  storedBytes: number;
  contentType: string;
}

export interface ProjectStorageSnapshot {
  format: typeof PROJECT_OBJECT_STORAGE_FORMAT;
  version: typeof PROJECT_OBJECT_STORAGE_VERSION;
  projectId: string;
  document: unknown;
}

export interface PreparedProjectStorageSnapshot {
  snapshot: ProjectStorageSnapshot;
  checksumSha256: string;
  logicalBytes: number;
  storedBody: Uint8Array;
  storedBytes: number;
  contentEncoding: 'gzip';
  assets: ProjectStorageAssetObject[];
}

export class ProjectObjectStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectObjectStorageError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bytesFor(value: string): Uint8Array {
  return textEncoder.encode(value);
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const body = new Response(ownedArrayBuffer(bytes)).body;
  if (!body) {
    throw new ProjectObjectStorageError(
      'Could not create a compression stream.'
    );
  }
  const compressed = body.pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

export async function decodeProjectStorageBody(
  body: ArrayBuffer,
  contentEncoding: 'gzip'
): Promise<Uint8Array> {
  if (contentEncoding !== 'gzip') {
    throw new ProjectObjectStorageError(
      `Unsupported project object encoding: ${String(contentEncoding)}.`
    );
  }
  const stream = new Response(body).body;
  if (!stream) {
    throw new ProjectObjectStorageError(
      'Could not create a decompression stream.'
    );
  }
  const decompressed = stream.pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(decompressed).arrayBuffer());
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', ownedArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0')
  ).join('');
}

function assetObjectKey(
  projectId: string,
  kind: ProjectStorageAssetKind,
  checksumSha256: string
): string {
  const extension = kind === 'step-source' ? 'step.txt.gz' : 'mesh.json.gz';
  return `${PROJECT_OBJECT_STORAGE_PREFIX}/${projectId}/assets/${checksumSha256}.${extension}`;
}

function expectedAssetPrefix(projectId: string): string {
  return `${PROJECT_OBJECT_STORAGE_PREFIX}/${projectId}/assets/`;
}

function isAssetReference(
  value: unknown
): value is ProjectStorageAssetReference {
  return (
    isRecord(value) &&
    value.marker === PROJECT_ASSET_REFERENCE_MARKER &&
    value.version === PROJECT_ASSET_REFERENCE_VERSION &&
    (value.kind === 'step-source' || value.kind === 'mesh-payload') &&
    typeof value.objectKey === 'string' &&
    typeof value.checksumSha256 === 'string' &&
    typeof value.logicalBytes === 'number' &&
    value.contentEncoding === 'gzip'
  );
}

function assertNoReservedReference(value: unknown): void {
  if (isAssetReference(value)) {
    throw new ProjectObjectStorageError(
      'Project document contains a reserved cloud-storage reference.'
    );
  }
}

/**
 * Builds the private R2 representation of a browser document.
 *
 * The browser document remains self-contained. Only this cloud projection
 * replaces imported STEP text and expanded mesh arrays with content-addressed
 * references, including the duplicate copies held by import commands.
 */
export async function prepareProjectStorageSnapshot(
  document: ProjectDocument
): Promise<PreparedProjectStorageSnapshot> {
  const projected = JSON.parse(JSON.stringify(document)) as Record<
    string,
    unknown
  >;
  const assetsByKey = new Map<string, ProjectStorageAssetObject>();

  const addAsset = async (
    kind: ProjectStorageAssetKind,
    logicalBody: Uint8Array,
    contentType: string
  ): Promise<ProjectStorageAssetReference> => {
    const checksumSha256 = await sha256Hex(logicalBody);
    const objectKey = assetObjectKey(document.projectId, kind, checksumSha256);
    const existing = assetsByKey.get(objectKey);
    if (existing) {
      return {
        marker: existing.marker,
        version: existing.version,
        kind: existing.kind,
        objectKey: existing.objectKey,
        checksumSha256: existing.checksumSha256,
        logicalBytes: existing.logicalBytes,
        contentEncoding: existing.contentEncoding
      };
    }
    const storedBody = await gzip(logicalBody);
    const asset: ProjectStorageAssetObject = {
      marker: PROJECT_ASSET_REFERENCE_MARKER,
      version: PROJECT_ASSET_REFERENCE_VERSION,
      kind,
      objectKey,
      checksumSha256,
      logicalBytes: logicalBody.byteLength,
      contentEncoding: 'gzip',
      storedBody,
      storedBytes: storedBody.byteLength,
      contentType
    };
    assetsByKey.set(objectKey, asset);
    return {
      marker: asset.marker,
      version: asset.version,
      kind: asset.kind,
      objectKey: asset.objectKey,
      checksumSha256: asset.checksumSha256,
      logicalBytes: asset.logicalBytes,
      contentEncoding: asset.contentEncoding
    };
  };

  const externalizeStep = async (payload: Record<string, unknown>) => {
    assertNoReservedReference(payload.stepText);
    if (typeof payload.stepText !== 'string') {
      return;
    }
    payload.stepText = await addAsset(
      'step-source',
      bytesFor(payload.stepText),
      'application/step'
    );
  };

  const externalizeMesh = async (payload: Record<string, unknown>) => {
    assertNoReservedReference(payload[MESH_PAYLOAD_REFERENCE_KEY]);
    if (!Array.isArray(payload.vertices) || !Array.isArray(payload.indices)) {
      return;
    }
    const logicalBody = bytesFor(
      JSON.stringify({ vertices: payload.vertices, indices: payload.indices })
    );
    payload[MESH_PAYLOAD_REFERENCE_KEY] = await addAsset(
      'mesh-payload',
      logicalBody,
      'application/json'
    );
    delete payload.vertices;
    delete payload.indices;
  };

  if (isRecord(projected.nodes)) {
    for (const node of Object.values(projected.nodes)) {
      if (!isRecord(node) || node.kind !== 'feature' || !isRecord(node.data)) {
        continue;
      }
      if (node.featureKind === 'imported-step') {
        await externalizeStep(node.data);
      } else if (node.featureKind === 'imported-mesh') {
        await externalizeMesh(node.data);
      }
    }
  }

  if (Array.isArray(projected.commandLog)) {
    for (const entry of projected.commandLog) {
      if (!isRecord(entry) || !isRecord(entry.payload)) {
        continue;
      }
      if (entry.kind === 'import.step') {
        await externalizeStep(entry.payload);
      } else if (
        entry.kind === 'import.shapr-guided' &&
        isRecord(entry.payload.step)
      ) {
        await externalizeStep(entry.payload.step);
      } else if (entry.kind === 'import.mesh') {
        await externalizeMesh(entry.payload);
      }
    }
  }

  const snapshot: ProjectStorageSnapshot = {
    format: PROJECT_OBJECT_STORAGE_FORMAT,
    version: PROJECT_OBJECT_STORAGE_VERSION,
    projectId: document.projectId,
    document: projected
  };
  const logicalBody = bytesFor(JSON.stringify(snapshot));
  const storedBody = await gzip(logicalBody);
  return {
    snapshot,
    checksumSha256: await sha256Hex(logicalBody),
    logicalBytes: logicalBody.byteLength,
    storedBody,
    storedBytes: storedBody.byteLength,
    contentEncoding: 'gzip',
    assets: [...assetsByKey.values()]
  };
}

async function verifiedAssetBody(
  projectId: string,
  reference: ProjectStorageAssetReference,
  loadAsset: (reference: ProjectStorageAssetReference) => Promise<Uint8Array>
): Promise<Uint8Array> {
  if (!reference.objectKey.startsWith(expectedAssetPrefix(projectId))) {
    throw new ProjectObjectStorageError(
      'Project object contains an out-of-scope asset reference.'
    );
  }
  const body = await loadAsset(reference);
  if (body.byteLength !== reference.logicalBytes) {
    throw new ProjectObjectStorageError(
      `Project asset ${reference.objectKey} has an unexpected size.`
    );
  }
  if ((await sha256Hex(body)) !== reference.checksumSha256) {
    throw new ProjectObjectStorageError(
      `Project asset ${reference.objectKey} failed its checksum.`
    );
  }
  return body;
}

/** Reconstructs the exact browser document from a verified R2 snapshot. */
export async function hydrateProjectStorageSnapshot(
  snapshot: ProjectStorageSnapshot,
  expectedProjectId: string,
  loadAsset: (reference: ProjectStorageAssetReference) => Promise<Uint8Array>
): Promise<ProjectDocument> {
  if (
    snapshot.format !== PROJECT_OBJECT_STORAGE_FORMAT ||
    snapshot.version !== PROJECT_OBJECT_STORAGE_VERSION ||
    snapshot.projectId !== expectedProjectId ||
    !isRecord(snapshot.document)
  ) {
    throw new ProjectObjectStorageError(
      'Project object has an invalid envelope.'
    );
  }

  const document = structuredClone(snapshot.document);

  const hydrateStep = async (payload: Record<string, unknown>) => {
    if (!isAssetReference(payload.stepText)) {
      return;
    }
    if (payload.stepText.kind !== 'step-source') {
      throw new ProjectObjectStorageError(
        'STEP payload points to an incompatible project asset.'
      );
    }
    payload.stepText = textDecoder.decode(
      await verifiedAssetBody(expectedProjectId, payload.stepText, loadAsset)
    );
  };

  const hydrateMesh = async (payload: Record<string, unknown>) => {
    const reference = payload[MESH_PAYLOAD_REFERENCE_KEY];
    if (!isAssetReference(reference)) {
      return;
    }
    if (reference.kind !== 'mesh-payload') {
      throw new ProjectObjectStorageError(
        'Mesh payload points to an incompatible project asset.'
      );
    }
    const decoded = JSON.parse(
      textDecoder.decode(
        await verifiedAssetBody(expectedProjectId, reference, loadAsset)
      )
    ) as unknown;
    if (
      !isRecord(decoded) ||
      !Array.isArray(decoded.vertices) ||
      !Array.isArray(decoded.indices)
    ) {
      throw new ProjectObjectStorageError(
        'Stored mesh payload has an invalid shape.'
      );
    }
    payload.vertices = decoded.vertices;
    payload.indices = decoded.indices;
    delete payload[MESH_PAYLOAD_REFERENCE_KEY];
  };

  if (isRecord(document.nodes)) {
    for (const node of Object.values(document.nodes)) {
      if (!isRecord(node) || node.kind !== 'feature' || !isRecord(node.data)) {
        continue;
      }
      if (node.featureKind === 'imported-step') {
        await hydrateStep(node.data);
      } else if (node.featureKind === 'imported-mesh') {
        await hydrateMesh(node.data);
      }
    }
  }

  if (Array.isArray(document.commandLog)) {
    for (const entry of document.commandLog) {
      if (!isRecord(entry) || !isRecord(entry.payload)) {
        continue;
      }
      if (entry.kind === 'import.step') {
        await hydrateStep(entry.payload);
      } else if (
        entry.kind === 'import.shapr-guided' &&
        isRecord(entry.payload.step)
      ) {
        await hydrateStep(entry.payload.step);
      } else if (entry.kind === 'import.mesh') {
        await hydrateMesh(entry.payload);
      }
    }
  }

  if (document.projectId !== expectedProjectId) {
    throw new ProjectObjectStorageError(
      'Stored document does not match its project.'
    );
  }
  return document as unknown as ProjectDocument;
}
