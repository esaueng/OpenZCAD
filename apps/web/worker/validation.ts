import {
  MAX_ARTIFACT_UPLOAD_PARTS,
  MAX_CLOUD_PROJECT_DOCUMENT_BYTES,
  MAX_PROJECT_NAME_LENGTH,
  MAX_PROJECT_CHECKPOINTS,
  THUMBNAIL_CONTENT_TYPE,
  persistedDocumentBytes,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  PROJECT_STATUSES,
  isProjectCheckpoint,
  isRevisionRecord,
  toArtifactId,
  toProjectId,
  toUploadSessionId,
  type ArtifactKind,
  type CompleteMultipartUploadRequest,
  type CreateProjectRequest,
  type CreateUploadSessionRequest,
  type DuplicateProjectRequest,
  type FinalizeImportRequest,
  type ProjectDocument,
  type ProjectStatus,
  type ReorderProjectsRequest,
  type SaveProjectDocumentRequest,
  type SaveRevisionRequest,
  type UnitSystem,
  type UpdateProjectRequest
} from '@openzcad/shared';
import {
  ASSISTANT_ATTACHMENT_MEDIA_TYPES,
  MAX_ASSISTANT_ATTACHMENTS,
  MAX_ASSISTANT_ATTACHMENT_BYTES,
  MAX_ASSISTANT_ATTACHMENT_TOTAL_BYTES,
  MAX_ASSISTANT_HISTORY_CHARS,
  MAX_ASSISTANT_HISTORY_TURNS,
  type AssistantAttachment,
  type AssistantAttachmentMediaType,
  type AssistantHistoryTurn,
  type CadDocumentDigest
} from '@openzcad/ai-contracts';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const UNIT_SYSTEMS: readonly UnitSystem[] = ['mm', 'cm', 'm', 'inch'];
const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  'step-import',
  'stl-import',
  'step-export',
  'stl-export',
  '3mf-export',
  'obj-export',
  'gltf-export',
  'snapshot',
  'thumbnail'
];
const MAX_NAME_LENGTH = MAX_PROJECT_NAME_LENGTH;
const MAX_FILE_NAME_LENGTH = 255;
const MAX_CONTENT_TYPE_LENGTH = 100;
const MAX_REASON_LENGTH = 500;
/** Bound on one reorder: a shelf that large is not being dragged by hand. */
const MAX_REORDERED_PROJECTS = 1_000;
const MAX_AI_PROMPT_LENGTH = 4_000;
const MAX_AI_DIGEST_BYTES = 128_000;
const MAX_AI_DIGEST_ITEMS = 1_000;

const MAX_AI_ATTACHMENT_LABEL_LENGTH = 200;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export interface AssistantProposalRequest {
  prompt: string;
  digest: CadDocumentDigest;
  history: AssistantHistoryTurn[];
  attachments: AssistantAttachment[];
}

function badRequest(message: string): HttpError {
  return new HttpError(400, message);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw badRequest(`"${key}" must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw badRequest(`"${key}" must be at most ${maxLength} characters.`);
  }
  return trimmed;
}

export function parseCreateProjectRequest(body: unknown): CreateProjectRequest {
  const record = asRecord(body, 'Request body');
  const name = requireString(record, 'name', MAX_NAME_LENGTH);

  const request: CreateProjectRequest = { name };
  if (record.units !== undefined) {
    if (!UNIT_SYSTEMS.includes(record.units as UnitSystem)) {
      throw badRequest(`"units" must be one of: ${UNIT_SYSTEMS.join(', ')}.`);
    }
    request.units = record.units as UnitSystem;
  }
  if (record.document !== undefined) {
    // Adoption. The id comes from the document rather than the URL, which is
    // the point — the device is asking to keep the id it already filed this
    // project under.
    const document = parseProjectDocument(record.document);
    assertDocumentWithinCeiling(document);
    request.document = document;
  }
  return request;
}

export function parseUpdateProjectRequest(
  body: unknown,
  projectIdFromPath: string
): UpdateProjectRequest {
  const record = asRecord(body, 'Request body');
  const request: UpdateProjectRequest = {
    projectId: toProjectId(projectIdFromPath)
  };
  if (record.status !== undefined) {
    if (!PROJECT_STATUSES.includes(record.status as ProjectStatus)) {
      throw badRequest(
        `"status" must be one of: ${PROJECT_STATUSES.join(', ')}.`
      );
    }
    request.status = record.status as ProjectStatus;
  }
  if (record.pinned !== undefined) {
    if (typeof record.pinned !== 'boolean') {
      throw badRequest('"pinned" must be a boolean.');
    }
    request.pinned = record.pinned;
  }
  if (record.sortOrder !== undefined) {
    if (
      typeof record.sortOrder !== 'number' ||
      !Number.isFinite(record.sortOrder)
    ) {
      throw badRequest('"sortOrder" must be a finite number.');
    }
    request.sortOrder = record.sortOrder;
  }
  if (
    request.status === undefined &&
    request.pinned === undefined &&
    request.sortOrder === undefined
  ) {
    throw badRequest(
      'Provide at least one of "status", "pinned", or "sortOrder".'
    );
  }
  return request;
}

export function parseDuplicateProjectRequest(
  body: unknown,
  projectIdFromPath: string
): DuplicateProjectRequest {
  // An empty body is the common case — the server picks a "(copy)" name.
  const record =
    body === undefined || body === null ? {} : asRecord(body, 'Request body');
  return {
    projectId: toProjectId(projectIdFromPath),
    ...(record.name === undefined
      ? {}
      : { name: requireString(record, 'name', MAX_NAME_LENGTH) })
  };
}

export function parseReorderProjectsRequest(
  body: unknown
): ReorderProjectsRequest {
  const record = asRecord(body, 'Request body');
  if (!Array.isArray(record.projectIds)) {
    throw badRequest('"projectIds" must be an array.');
  }
  if (record.projectIds.length > MAX_REORDERED_PROJECTS) {
    throw badRequest(
      `"projectIds" must contain at most ${MAX_REORDERED_PROJECTS} ids.`
    );
  }
  const seen = new Set<string>();
  return {
    projectIds: record.projectIds.map((value, index) => {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw badRequest(`"projectIds[${index}]" must be a non-empty string.`);
      }
      const projectId = value.trim();
      if (seen.has(projectId)) {
        throw badRequest('"projectIds" must not repeat a project.');
      }
      seen.add(projectId);
      return toProjectId(projectId);
    })
  };
}

/**
 * Structural sanity check of the posted document, not a full schema
 * validation: the document blob is round-tripped as-is, so this guards the
 * fields the server itself reads plus path/payload consistency.
 *
 * `projectIdFromPath` is omitted on adoption, where the document supplies the
 * id instead of the URL; the id is still required to be a usable string.
 */
function parseProjectDocument(
  value: unknown,
  projectIdFromPath?: string
): ProjectDocument {
  const record = asRecord(value, '"document"');
  if (projectIdFromPath === undefined) {
    if (
      typeof record.projectId !== 'string' ||
      record.projectId.trim().length === 0
    ) {
      throw badRequest('"document.projectId" must be a non-empty string.');
    }
  } else if (record.projectId !== projectIdFromPath) {
    throw badRequest(
      '"document.projectId" must match the project id in the URL.'
    );
  }
  if (typeof record.name !== 'string' || typeof record.version !== 'number') {
    throw badRequest('"document" is missing required fields.');
  }
  if (
    typeof record.nodes !== 'object' ||
    record.nodes === null ||
    !Array.isArray(record.revisions) ||
    !Array.isArray(record.commandLog)
  ) {
    throw badRequest('"document" is missing required collections.');
  }
  if (
    !record.revisions.every(isRevisionRecord) ||
    !Array.isArray(record.checkpoints) ||
    record.checkpoints.length > MAX_PROJECT_CHECKPOINTS ||
    !record.checkpoints.every(isProjectCheckpoint)
  ) {
    throw badRequest('"document" has invalid revision or checkpoint history.');
  }
  // A document written by a newer client can carry node kinds and references
  // this deployment does not understand. Normalization migrates forward, never
  // back, so storing one would hand the account a document it cannot rebuild.
  if (
    record.schemaVersion !== undefined &&
    (typeof record.schemaVersion !== 'number' ||
      record.schemaVersion > PROJECT_DOCUMENT_SCHEMA_VERSION)
  ) {
    throw badRequest(
      `"document.schemaVersion" is newer than this deployment supports (${PROJECT_DOCUMENT_SCHEMA_VERSION}). Reload to update.`
    );
  }
  return value as ProjectDocument;
}

/**
 * Refuses an oversize document at the edge. The persistence layer checks this
 * again — it is the layer that owns the invariant — but doing it here keeps a
 * document that can never be stored from being parsed, normalized, and
 * serialized first.
 */
function assertDocumentWithinCeiling(document: ProjectDocument): void {
  const bytes = persistedDocumentBytes(document);
  if (bytes > MAX_CLOUD_PROJECT_DOCUMENT_BYTES) {
    throw new HttpError(
      413,
      `Document is ${bytes} bytes; cloud storage accepts at most ${MAX_CLOUD_PROJECT_DOCUMENT_BYTES}.`
    );
  }
}

export function parseSaveRevisionRequest(
  body: unknown,
  projectIdFromPath: string
): SaveRevisionRequest {
  const record = asRecord(body, 'Request body');
  if (record.projectId !== projectIdFromPath) {
    throw badRequest('"projectId" must match the project id in the URL.');
  }
  const reason = requireString(record, 'reason', MAX_REASON_LENGTH);
  if (
    typeof record.expectedVersion !== 'number' ||
    !Number.isInteger(record.expectedVersion) ||
    record.expectedVersion < 0
  ) {
    throw badRequest('"expectedVersion" must be a non-negative integer.');
  }
  const document = parseProjectDocument(record.document, projectIdFromPath);
  assertDocumentWithinCeiling(document);
  return {
    projectId: toProjectId(projectIdFromPath),
    reason,
    expectedVersion: record.expectedVersion,
    document
  };
}

export function parseSaveProjectDocumentRequest(
  body: unknown,
  projectIdFromPath: string
): SaveProjectDocumentRequest {
  const record = asRecord(body, 'Request body');
  if (record.projectId !== projectIdFromPath) {
    throw badRequest('"projectId" must match the project id in the URL.');
  }
  if (
    typeof record.expectedVersion !== 'number' ||
    !Number.isInteger(record.expectedVersion) ||
    record.expectedVersion < 0
  ) {
    throw badRequest('"expectedVersion" must be a non-negative integer.');
  }
  const document = parseProjectDocument(record.document, projectIdFromPath);
  assertDocumentWithinCeiling(document);
  return {
    projectId: toProjectId(projectIdFromPath),
    expectedVersion: record.expectedVersion,
    document
  };
}

export function parseCreateUploadSessionRequest(
  body: unknown
): CreateUploadSessionRequest {
  const record = asRecord(body, 'Request body');
  if (!ARTIFACT_KINDS.includes(record.kind as ArtifactKind)) {
    throw badRequest(`"kind" must be one of: ${ARTIFACT_KINDS.join(', ')}.`);
  }
  if (
    record.kind === 'thumbnail' &&
    record.contentType !== THUMBNAIL_CONTENT_TYPE
  ) {
    throw badRequest(
      `Thumbnail contentType must be ${THUMBNAIL_CONTENT_TYPE}.`
    );
  }
  const metadata =
    record.metadata === undefined
      ? {}
      : asRecord(record.metadata, '"metadata"');
  if (JSON.stringify(metadata).length > 4_000) {
    throw badRequest('"metadata" is too large.');
  }
  if (
    Object.values(metadata).some(
      (value) =>
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        typeof value !== 'boolean'
    )
  ) {
    throw badRequest(
      '"metadata" values must be strings, numbers, or booleans.'
    );
  }
  return {
    projectId: toProjectId(requireString(record, 'projectId', MAX_NAME_LENGTH)),
    fileName: requireString(record, 'fileName', MAX_FILE_NAME_LENGTH),
    contentType: requireString(record, 'contentType', MAX_CONTENT_TYPE_LENGTH),
    kind: record.kind as ArtifactKind,
    metadata: metadata as Record<string, string | number | boolean>
  };
}

export function parseFinalizeImportRequest(
  body: unknown
): FinalizeImportRequest {
  const record = asRecord(body, 'Request body');
  return {
    projectId: toProjectId(requireString(record, 'projectId', MAX_NAME_LENGTH)),
    uploadSessionId: toUploadSessionId(
      requireString(record, 'uploadSessionId', MAX_NAME_LENGTH)
    ),
    artifactId: toArtifactId(
      requireString(record, 'artifactId', MAX_NAME_LENGTH)
    )
  };
}

export function parseCompleteMultipartUploadRequest(
  body: unknown
): CompleteMultipartUploadRequest {
  const record = asRecord(body, 'Request body');
  const uploadId = requireString(record, 'uploadId', MAX_NAME_LENGTH);
  if (!Array.isArray(record.parts) || record.parts.length === 0) {
    throw badRequest('"parts" must be a non-empty array.');
  }
  if (record.parts.length > MAX_ARTIFACT_UPLOAD_PARTS) {
    throw badRequest(
      `"parts" cannot exceed ${MAX_ARTIFACT_UPLOAD_PARTS} entries.`
    );
  }
  const seen = new Set<number>();
  const parts = record.parts.map((part) => {
    const partRecord = asRecord(part, 'Upload part');
    const partNumber = partRecord.partNumber;
    if (
      typeof partNumber !== 'number' ||
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > MAX_ARTIFACT_UPLOAD_PARTS ||
      seen.has(partNumber)
    ) {
      throw badRequest('"partNumber" must be a unique integer in range.');
    }
    seen.add(partNumber);
    return {
      partNumber,
      etag: requireString(partRecord, 'etag', MAX_NAME_LENGTH)
    };
  });
  return { uploadId, parts };
}

/**
 * Decoded byte count of a base64 payload, without allocating the bytes. An
 * attachment is rejected on its declared size before anything tries to decode
 * or forward it.
 */
function base64ByteLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function parseAssistantHistory(value: unknown): AssistantHistoryTurn[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw badRequest('"history" must be an array.');
  }
  if (value.length > MAX_ASSISTANT_HISTORY_TURNS) {
    throw badRequest(
      `"history" must contain at most ${MAX_ASSISTANT_HISTORY_TURNS} turns.`
    );
  }
  let characters = 0;
  return value.map((candidate, index) => {
    const turn = asRecord(candidate, `"history[${index}]"`);
    if (turn.role !== 'user' && turn.role !== 'assistant') {
      throw badRequest(`"history[${index}].role" must be user or assistant.`);
    }
    const text = requireString(turn, 'text', MAX_ASSISTANT_HISTORY_CHARS);
    characters += text.length;
    if (characters > MAX_ASSISTANT_HISTORY_CHARS) {
      throw badRequest(
        `"history" must total at most ${MAX_ASSISTANT_HISTORY_CHARS} characters.`
      );
    }
    const answeredQuestionId =
      turn.answeredQuestionId === undefined
        ? undefined
        : requireString(turn, 'answeredQuestionId', 200);
    return {
      role: turn.role,
      text,
      ...(answeredQuestionId ? { answeredQuestionId } : {})
    };
  });
}

function parseAssistantAttachments(value: unknown): AssistantAttachment[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw badRequest('"attachments" must be an array.');
  }
  if (value.length > MAX_ASSISTANT_ATTACHMENTS) {
    throw badRequest(
      `"attachments" must contain at most ${MAX_ASSISTANT_ATTACHMENTS} images.`
    );
  }
  let totalBytes = 0;
  return value.map((candidate, index) => {
    const attachment = asRecord(candidate, `"attachments[${index}]"`);
    if (
      !ASSISTANT_ATTACHMENT_MEDIA_TYPES.includes(
        attachment.mediaType as AssistantAttachmentMediaType
      )
    ) {
      throw badRequest(
        `"attachments[${index}].mediaType" must be one of: ${ASSISTANT_ATTACHMENT_MEDIA_TYPES.join(', ')}.`
      );
    }
    const dataBase64 = attachment.dataBase64;
    if (typeof dataBase64 !== 'string' || dataBase64.length === 0) {
      throw badRequest(`"attachments[${index}].dataBase64" must be a string.`);
    }
    // Reject anything that is not plain base64 before it is put in a data URL,
    // so a payload cannot smuggle a different media type past the allowlist.
    if (dataBase64.length % 4 !== 0 || !BASE64_PATTERN.test(dataBase64)) {
      throw badRequest(
        `"attachments[${index}].dataBase64" is not valid base64.`
      );
    }
    const bytes = base64ByteLength(dataBase64);
    if (bytes > MAX_ASSISTANT_ATTACHMENT_BYTES) {
      throw badRequest(
        `"attachments[${index}]" exceeds the ${Math.floor(MAX_ASSISTANT_ATTACHMENT_BYTES / (1024 * 1024))} MB per-image limit.`
      );
    }
    totalBytes += bytes;
    if (totalBytes > MAX_ASSISTANT_ATTACHMENT_TOTAL_BYTES) {
      throw badRequest(
        `"attachments" exceed the ${Math.floor(MAX_ASSISTANT_ATTACHMENT_TOTAL_BYTES / (1024 * 1024))} MB total limit.`
      );
    }
    return {
      id: requireString(attachment, 'id', 200),
      mediaType: attachment.mediaType as AssistantAttachmentMediaType,
      dataBase64,
      label: requireString(attachment, 'label', MAX_AI_ATTACHMENT_LABEL_LENGTH)
    };
  });
}

export function parseAssistantProposalRequest(
  body: unknown
): AssistantProposalRequest {
  const record = asRecord(body, 'Request body');
  const prompt = requireString(record, 'prompt', MAX_AI_PROMPT_LENGTH);
  const digest = asRecord(record.digest, '"digest"');
  if (
    typeof digest.schemaVersion !== 'number' ||
    typeof digest.projectId !== 'string' ||
    typeof digest.name !== 'string' ||
    typeof digest.units !== 'string' ||
    typeof digest.version !== 'number' ||
    !Array.isArray(digest.parameters) ||
    !Array.isArray(digest.features) ||
    (digest.bodies !== undefined && !Array.isArray(digest.bodies)) ||
    !Array.isArray(digest.warnings)
  ) {
    throw badRequest('"digest" is missing required fields.');
  }
  for (const key of ['parameters', 'features', 'bodies', 'warnings'] as const) {
    const value = digest[key];
    if (Array.isArray(value) && value.length > MAX_AI_DIGEST_ITEMS) {
      throw badRequest(`"digest.${key}" has too many items.`);
    }
  }
  if (
    new TextEncoder().encode(JSON.stringify(digest)).byteLength >
    MAX_AI_DIGEST_BYTES
  ) {
    throw badRequest('"digest" is too large.');
  }
  return {
    prompt,
    digest: digest as unknown as CadDocumentDigest,
    history: parseAssistantHistory(record.history),
    attachments: parseAssistantAttachments(record.attachments)
  };
}
