import {
  normalizeDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  MAX_CLOUD_PROJECT_DOCUMENT_BYTES,
  MAX_ARTIFACT_UPLOAD_BYTES,
  MAX_PROJECT_STORAGE_ASSET_UPLOADS
} from '@openzcad/shared';
import type {
  ProjectDocument,
  ProjectStorageAssetUpload
} from '@openzcad/shared';

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
  contentEncoding: 'gzip',
  maxBytes = MAX_CLOUD_PROJECT_DOCUMENT_BYTES + MAX_ARTIFACT_UPLOAD_BYTES
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
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new ProjectObjectStorageError('Invalid project object length.');
  const reader = decompressed.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ProjectObjectStorageError(
          'Project object exceeds its decompression limit.'
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
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

function contentTypeFor(kind: ProjectStorageAssetKind): string {
  return kind === 'step-source' ? 'application/step' : 'application/json';
}

function referenceOf(
  asset: ProjectStorageAssetObject
): ProjectStorageAssetReference {
  return {
    marker: asset.marker,
    version: asset.version,
    kind: asset.kind,
    objectKey: asset.objectKey,
    checksumSha256: asset.checksumSha256,
    logicalBytes: asset.logicalBytes,
    contentEncoding: asset.contentEncoding
  };
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

/** History holds exact value fragments, including imports no longer in the model. */
async function visitHistoryPayloads(
  value: unknown,
  step: (payload: Record<string, unknown>) => Promise<void>,
  mesh: (payload: Record<string, unknown>) => Promise<void>
): Promise<void> {
  if (Array.isArray(value)) {
    for (const entry of value) await visitHistoryPayloads(entry, step, mesh);
  } else if (isRecord(value)) {
    if (Object.hasOwn(value, 'stepText')) await step(value);
    if (
      (Object.hasOwn(value, 'vertices') && Object.hasOwn(value, 'indices')) ||
      Object.hasOwn(value, MESH_PAYLOAD_REFERENCE_KEY)
    )
      await mesh(value);
    for (const [key, child] of Object.entries(value)) {
      if (
        ![
          'stepText',
          'vertices',
          'indices',
          MESH_PAYLOAD_REFERENCE_KEY
        ].includes(key)
      )
        await visitHistoryPayloads(child, step, mesh);
    }
  }
}

/** A document with its import payloads replaced by project-asset references. */
export interface ProjectStorageSplit {
  /** The storage projection of the document; references stand in for payloads. */
  document: Record<string, unknown>;
  assets: ProjectStorageAssetObject[];
}

/**
 * Replaces imported STEP text and expanded mesh arrays with content-addressed
 * references, including the duplicate copies held by import commands and undo
 * history. The input document is not modified. A declined asset stays
 * embedded throughout the projection and its history.
 */
export async function splitProjectStorageAssets(
  document: ProjectDocument,
  options?: {
    externalizeAsset?: (
      reference: ProjectStorageAssetReference
    ) => Promise<boolean>;
  }
): Promise<ProjectStorageSplit> {
  const projected = JSON.parse(JSON.stringify(document)) as Record<
    string,
    unknown
  >;
  const assetsByKey = new Map<string, ProjectStorageAssetObject>();
  const embeddedKeys = new Set<string>();

  const addAsset = async (
    kind: ProjectStorageAssetKind,
    logicalBody: Uint8Array,
    contentType: string
  ): Promise<ProjectStorageAssetReference | null> => {
    const checksumSha256 = await sha256Hex(logicalBody);
    const objectKey = assetObjectKey(document.projectId, kind, checksumSha256);
    if (embeddedKeys.has(objectKey)) return null;
    const existing = assetsByKey.get(objectKey);
    if (existing) return referenceOf(existing);
    const reference: ProjectStorageAssetReference = {
      marker: PROJECT_ASSET_REFERENCE_MARKER,
      version: PROJECT_ASSET_REFERENCE_VERSION,
      kind,
      objectKey,
      checksumSha256,
      logicalBytes: logicalBody.byteLength,
      contentEncoding: 'gzip'
    };
    if (
      options?.externalizeAsset &&
      !(await options.externalizeAsset(reference))
    ) {
      embeddedKeys.add(objectKey);
      return null;
    }
    const storedBody = await gzip(logicalBody);
    const asset: ProjectStorageAssetObject = {
      ...reference,
      storedBody,
      storedBytes: storedBody.byteLength,
      contentType
    };
    assetsByKey.set(objectKey, asset);
    return referenceOf(asset);
  };

  const externalizeStep = async (payload: Record<string, unknown>) => {
    assertNoReservedReference(payload.stepText);
    if (typeof payload.stepText !== 'string') {
      return;
    }
    const reference = await addAsset(
      'step-source',
      bytesFor(payload.stepText),
      contentTypeFor('step-source')
    );
    if (reference) payload.stepText = reference;
  };

  const externalizeMesh = async (payload: Record<string, unknown>) => {
    assertNoReservedReference(payload[MESH_PAYLOAD_REFERENCE_KEY]);
    if (!Array.isArray(payload.vertices) || !Array.isArray(payload.indices)) {
      return;
    }
    const logicalBody = bytesFor(
      JSON.stringify({ vertices: payload.vertices, indices: payload.indices })
    );
    const reference = await addAsset(
      'mesh-payload',
      logicalBody,
      contentTypeFor('mesh-payload')
    );
    if (!reference) return;
    payload[MESH_PAYLOAD_REFERENCE_KEY] = reference;
    delete payload.vertices;
    delete payload.indices;
  };

  await visitImportPayloads(projected, externalizeStep, externalizeMesh);
  return { document: projected, assets: [...assetsByKey.values()] };
}

async function preparedSnapshot(
  projectId: string,
  split: ProjectStorageSplit
): Promise<PreparedProjectStorageSnapshot> {
  const snapshot: ProjectStorageSnapshot = {
    format: PROJECT_OBJECT_STORAGE_FORMAT,
    version: PROJECT_OBJECT_STORAGE_VERSION,
    projectId,
    document: split.document
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
    assets: split.assets
  };
}

/**
 * Builds the private R2 representation of a document the server holds whole:
 * a room checkpoint, a server-built copy, or a pre-Phase 1 client's write.
 *
 * The browser document remains self-contained. Only this cloud projection
 * replaces imported STEP text and expanded mesh arrays with content-addressed
 * references (see {@link splitProjectStorageAssets}).
 */
export async function prepareProjectStorageSnapshot(
  document: ProjectDocument,
  options?: {
    externalizeAsset?: (
      reference: ProjectStorageAssetReference
    ) => Promise<boolean>;
  }
): Promise<PreparedProjectStorageSnapshot> {
  return preparedSnapshot(
    document.projectId,
    await splitProjectStorageAssets(document, options)
  );
}

/** Calls `step` and `mesh` on every payload position the projection covers. */
async function visitImportPayloads(
  document: Record<string, unknown>,
  step: (payload: Record<string, unknown>) => Promise<void>,
  mesh: (payload: Record<string, unknown>) => Promise<void>
): Promise<void> {
  if (isRecord(document.nodes)) {
    for (const node of Object.values(document.nodes)) {
      if (!isRecord(node) || node.kind !== 'feature' || !isRecord(node.data)) {
        continue;
      }
      if (node.featureKind === 'imported-step') {
        await step(node.data);
      } else if (node.featureKind === 'imported-mesh') {
        await mesh(node.data);
      }
    }
  }

  if (Array.isArray(document.commandLog)) {
    for (const entry of document.commandLog) {
      if (!isRecord(entry) || !isRecord(entry.payload)) {
        continue;
      }
      if (entry.kind === 'import.step') {
        await step(entry.payload);
      } else if (
        entry.kind === 'import.shapr-guided' &&
        isRecord(entry.payload.step)
      ) {
        await step(entry.payload.step);
      } else if (entry.kind === 'import.mesh') {
        await mesh(entry.payload);
      }
    }
  }

  await visitHistoryPayloads(document.editHistory, step, mesh);
}

interface MeshArrays {
  vertices: unknown[];
  indices: unknown[];
}

/**
 * Puts payloads back at every reference in a storage projection. `load`
 * returns verified content for a reference whose kind suits its position.
 */
async function hydrateDocument(
  stored: Record<string, unknown>,
  expectedProjectId: string,
  load: {
    step: (reference: ProjectStorageAssetReference) => Promise<string>;
    mesh: (reference: ProjectStorageAssetReference) => Promise<MeshArrays>;
  }
): Promise<ProjectDocument> {
  const document = structuredClone(stored);

  const hydrateStep = async (payload: Record<string, unknown>) => {
    if (!isAssetReference(payload.stepText)) {
      return;
    }
    if (payload.stepText.kind !== 'step-source') {
      throw new ProjectObjectStorageError(
        'STEP payload points to an incompatible project asset.'
      );
    }
    payload.stepText = await load.step(payload.stepText);
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
    const decoded = await load.mesh(reference);
    payload.vertices = decoded.vertices;
    payload.indices = decoded.indices;
    delete payload[MESH_PAYLOAD_REFERENCE_KEY];
  };

  await visitImportPayloads(document, hydrateStep, hydrateMesh);

  if (document.projectId !== expectedProjectId) {
    throw new ProjectObjectStorageError(
      'Stored document does not match its project.'
    );
  }
  return document as unknown as ProjectDocument;
}

function meshArraysOf(body: Uint8Array): MeshArrays {
  let decoded: unknown;
  try {
    decoded = JSON.parse(textDecoder.decode(body));
  } catch {
    decoded = null;
  }
  if (
    !isRecord(decoded) ||
    !Array.isArray(decoded.vertices) ||
    !Array.isArray(decoded.indices)
  ) {
    throw new ProjectObjectStorageError(
      'Stored mesh payload has an invalid shape.'
    );
  }
  return { vertices: decoded.vertices, indices: decoded.indices };
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
  const verified = (reference: ProjectStorageAssetReference) =>
    verifiedAssetBody(expectedProjectId, reference, loadAsset);
  return hydrateDocument(snapshot.document, expectedProjectId, {
    step: async (reference) => textDecoder.decode(await verified(reference)),
    mesh: async (reference) => meshArraysOf(await verified(reference))
  });
}

interface VerifiedPayload {
  asset: ProjectStorageAssetObject;
  value: string | MeshArrays;
}

/**
 * A browser-split write the account has verified (ADR-024 Phase 1): the
 * projection as sent and its uploaded payloads, each checked against its
 * declared size and checksum. Every upload is referenced by the projection.
 */
export interface ClientProjectStorage {
  document: Record<string, unknown>;
  /** Verified payloads by object key, shared by every hydration of this write. */
  readonly payloads: ReadonlyMap<string, VerifiedPayload>;
}

/** A browser-split write that cannot be stored as sent. */
export class ProjectStorageUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectStorageUploadError';
  }
}

function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function bytesOfBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * The browser's half of the storage projection (ADR-024 Phase 1): the
 * document as the account stores it, with its embedded import payloads split
 * into compressed uploads. The document is first normalized and stripped of
 * its derived projection, exactly as the account would, because the account
 * stores the projection only when it hydrates to the document it keeps.
 */
export async function splitProjectStorageUpload(
  document: ProjectDocument
): Promise<{
  document: Record<string, unknown>;
  storageAssets: ProjectStorageAssetUpload[];
}> {
  const split = await splitProjectStorageAssets(
    withoutDerivedProjection(normalizeDocument(document))
  );
  return {
    document: split.document,
    storageAssets: split.assets.map((asset) => ({
      kind: asset.kind,
      checksumSha256: asset.checksumSha256,
      logicalBytes: asset.logicalBytes,
      storedBody: base64Of(asset.storedBody)
    }))
  };
}

const CHECKSUM_SHA256 = /^[0-9a-f]{64}$/;
const UPLOAD_FIELDS = [
  'checksumSha256',
  'kind',
  'logicalBytes',
  'storedBody'
].join();

function parseAssetUploads(value: unknown): ProjectStorageAssetUpload[] {
  if (!Array.isArray(value)) {
    throw new ProjectStorageUploadError('"storageAssets" must be an array.');
  }
  if (value.length > MAX_PROJECT_STORAGE_ASSET_UPLOADS) {
    throw new ProjectStorageUploadError(
      `A document write carries at most ${MAX_PROJECT_STORAGE_ASSET_UPLOADS} split payloads.`
    );
  }
  let declaredBytes = 0;
  return value.map((upload: unknown, index) => {
    if (
      !isRecord(upload) ||
      Object.keys(upload).sort().join() !== UPLOAD_FIELDS ||
      (upload.kind !== 'step-source' && upload.kind !== 'mesh-payload') ||
      typeof upload.checksumSha256 !== 'string' ||
      !CHECKSUM_SHA256.test(upload.checksumSha256) ||
      typeof upload.logicalBytes !== 'number' ||
      !Number.isSafeInteger(upload.logicalBytes) ||
      upload.logicalBytes < 0 ||
      typeof upload.storedBody !== 'string'
    ) {
      throw new ProjectStorageUploadError(
        `"storageAssets[${index}]" is not a split payload.`
      );
    }
    // A payload is at least as long inside the document as on its own, so
    // the document ceiling bounds the sum before anything is decompressed.
    declaredBytes += upload.logicalBytes;
    if (declaredBytes > MAX_CLOUD_PROJECT_DOCUMENT_BYTES) {
      throw new ProjectStorageUploadError(
        'The split payloads exceed the cloud document size limit.'
      );
    }
    return upload as unknown as ProjectStorageAssetUpload;
  });
}

async function verifiedUpload(
  projectId: string,
  upload: ProjectStorageAssetUpload
): Promise<{ asset: ProjectStorageAssetObject; logicalBody: Uint8Array }> {
  let storedBody: Uint8Array;
  let logicalBody: Uint8Array;
  try {
    storedBody = bytesOfBase64(upload.storedBody);
    logicalBody = await decodeProjectStorageBody(
      Uint8Array.from(storedBody).buffer,
      'gzip',
      upload.logicalBytes
    );
  } catch {
    throw new ProjectStorageUploadError(
      `The ${upload.kind} ${upload.checksumSha256} is not a gzip payload of its declared size.`
    );
  }
  if (logicalBody.byteLength !== upload.logicalBytes) {
    throw new ProjectStorageUploadError(
      `The ${upload.kind} ${upload.checksumSha256} has an unexpected size.`
    );
  }
  if ((await sha256Hex(logicalBody)) !== upload.checksumSha256) {
    throw new ProjectStorageUploadError(
      `The ${upload.kind} ${upload.checksumSha256} failed its checksum.`
    );
  }
  return {
    asset: {
      marker: PROJECT_ASSET_REFERENCE_MARKER,
      version: PROJECT_ASSET_REFERENCE_VERSION,
      kind: upload.kind,
      objectKey: assetObjectKey(projectId, upload.kind, upload.checksumSha256),
      checksumSha256: upload.checksumSha256,
      logicalBytes: upload.logicalBytes,
      contentEncoding: 'gzip',
      storedBody,
      storedBytes: storedBody.byteLength,
      contentType: contentTypeFor(upload.kind)
    },
    logicalBody
  };
}

/** Hydrates a verified write from its own payloads, sharing their values. */
function hydrateClientStorage(
  storage: ClientProjectStorage,
  projectId: string,
  used?: Set<string>
): Promise<ProjectDocument> {
  const payload = (reference: ProjectStorageAssetReference) => {
    const verified = storage.payloads.get(reference.objectKey);
    if (
      !verified ||
      verified.asset.kind !== reference.kind ||
      verified.asset.checksumSha256 !== reference.checksumSha256 ||
      // The upload was checked at its declared size; a reference claiming
      // another would be stored inconsistent with its bytes.
      verified.asset.logicalBytes !== reference.logicalBytes
    ) {
      throw new ProjectStorageUploadError(
        'The document references a project asset the request did not upload.'
      );
    }
    used?.add(reference.objectKey);
    return verified.value;
  };
  return hydrateDocument(storage.document, projectId, {
    step: async (reference) => payload(reference) as string,
    mesh: async (reference) => payload(reference) as MeshArrays
  });
}

/**
 * The account's half of a browser-split write (ADR-024 Phase 1). Checks
 * every upload against its declared size and checksum, then puts the payloads
 * back so the existing document checks can read the whole document; the
 * account never splits or searches the document to decide what it stores.
 * Every reference must name an upload and every upload must be referenced.
 */
export async function openProjectStorageUpload(
  document: unknown,
  storageAssets: unknown,
  projectId: string
): Promise<{ document: ProjectDocument; storage: ClientProjectStorage }> {
  if (!isRecord(document)) {
    throw new ProjectStorageUploadError('"document" must be an object.');
  }
  const uploads = parseAssetUploads(storageAssets);
  const payloads = new Map<string, VerifiedPayload>();
  for (const upload of uploads) {
    const { asset, logicalBody } = await verifiedUpload(projectId, upload);
    if (payloads.has(asset.objectKey)) {
      throw new ProjectStorageUploadError(
        `The ${upload.kind} ${upload.checksumSha256} is uploaded twice.`
      );
    }
    payloads.set(asset.objectKey, {
      asset,
      value:
        asset.kind === 'step-source'
          ? textDecoder.decode(logicalBody)
          : meshArraysForUpload(logicalBody)
    });
  }
  const storage: ClientProjectStorage = { document, payloads };
  const used = new Set<string>();
  let hydrated: ProjectDocument;
  try {
    hydrated = await hydrateClientStorage(storage, projectId, used);
  } catch (error) {
    if (error instanceof ProjectObjectStorageError)
      throw new ProjectStorageUploadError(error.message);
    throw error;
  }
  if (used.size !== payloads.size) {
    throw new ProjectStorageUploadError(
      'The request uploads a project asset its document does not reference.'
    );
  }
  return { document: hydrated, storage };
}

function meshArraysForUpload(body: Uint8Array): MeshArrays {
  try {
    return meshArraysOf(body);
  } catch {
    throw new ProjectStorageUploadError(
      'An uploaded mesh payload has an invalid shape.'
    );
  }
}

/** Whether two JSON values would serialize to the same content, in any key order. */
function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) =>
        sameJsonValue(value ?? null, right[index] ?? null)
      )
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = (value: Record<string, unknown>) =>
    Object.keys(value).filter((key) => value[key] !== undefined);
  const leftKeys = keys(left);
  return (
    leftKeys.length === keys(right).length &&
    leftKeys.every(
      (key) => Object.hasOwn(right, key) && sameJsonValue(left[key], right[key])
    )
  );
}

/**
 * The R2 representation of a browser-split write: the browser's projection
 * as sent, provided it hydrates to exactly `document`, the document the
 * account is about to store. A projection that drifted from it — a document
 * the browser did not normalize, or a save point the account had to mint —
 * is refused rather than re-split.
 */
export async function prepareClientProjectStorageSnapshot(
  document: ProjectDocument,
  storage: ClientProjectStorage
): Promise<PreparedProjectStorageSnapshot> {
  let hydrated: ProjectDocument;
  try {
    hydrated = await hydrateClientStorage(storage, document.projectId);
  } catch (error) {
    if (error instanceof ProjectObjectStorageError)
      throw new ProjectStorageUploadError(error.message);
    throw error;
  }
  if (!sameJsonValue(hydrated, document)) {
    throw new ProjectStorageUploadError(
      'The split document does not match the document the account stores.'
    );
  }
  return preparedSnapshot(document.projectId, {
    document: storage.document,
    assets: [...storage.payloads.values()].map(({ asset }) => asset)
  });
}
