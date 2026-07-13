import {
  toArtifactId,
  toBodyId,
  toProjectId,
  toUploadSessionId,
  type CreateProjectRequest,
  type CreateUploadSessionRequest,
  type FinalizeImportRequest,
  type ProjectDocument,
  type RequestExportRequest,
  type SaveRevisionRequest,
  type UnitSystem
} from '@openzcad/shared';
import type { CadDocumentDigest } from '@openzcad/ai-contracts';

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
const EXPORT_FORMATS = ['step', 'stl'] as const;
const MAX_NAME_LENGTH = 200;
const MAX_FILE_NAME_LENGTH = 255;
const MAX_CONTENT_TYPE_LENGTH = 100;
const MAX_REASON_LENGTH = 500;
const MAX_EXPORT_BODIES = 100;
const MAX_AI_PROMPT_LENGTH = 4_000;

export interface AssistantProposalRequest {
  prompt: string;
  digest: CadDocumentDigest;
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
  return request;
}

/**
 * Structural sanity check of the posted document, not a full schema
 * validation: the document blob is round-tripped as-is, so this guards the
 * fields the server itself reads plus path/payload consistency.
 */
function parseProjectDocument(
  value: unknown,
  projectIdFromPath: string
): ProjectDocument {
  const record = asRecord(value, '"document"');
  if (record.projectId !== projectIdFromPath) {
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
  return value as ProjectDocument;
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
  const document = parseProjectDocument(record.document, projectIdFromPath);
  return {
    projectId: toProjectId(projectIdFromPath),
    reason,
    document
  };
}

export function parseCreateUploadSessionRequest(
  body: unknown
): CreateUploadSessionRequest {
  const record = asRecord(body, 'Request body');
  return {
    projectId: toProjectId(requireString(record, 'projectId', MAX_NAME_LENGTH)),
    fileName: requireString(record, 'fileName', MAX_FILE_NAME_LENGTH),
    contentType: requireString(record, 'contentType', MAX_CONTENT_TYPE_LENGTH)
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
    ),
    fileName: requireString(record, 'fileName', MAX_FILE_NAME_LENGTH),
    contentType: requireString(record, 'contentType', MAX_CONTENT_TYPE_LENGTH)
  };
}

export function parseRequestExportRequest(body: unknown): RequestExportRequest {
  const record = asRecord(body, 'Request body');
  const format = record.format;
  if (format !== 'step' && format !== 'stl') {
    throw badRequest(`"format" must be one of: ${EXPORT_FORMATS.join(', ')}.`);
  }
  const rawBodyIds: unknown[] = Array.isArray(record.bodyIds)
    ? record.bodyIds
    : [];
  const bodyIds = rawBodyIds.filter(
    (id): id is string => typeof id === 'string' && id.length > 0
  );
  if (
    bodyIds.length !== rawBodyIds.length ||
    bodyIds.length === 0 ||
    bodyIds.length > MAX_EXPORT_BODIES
  ) {
    throw badRequest(
      `"bodyIds" must be a non-empty array of up to ${MAX_EXPORT_BODIES} body ids.`
    );
  }
  return {
    projectId: toProjectId(requireString(record, 'projectId', MAX_NAME_LENGTH)),
    bodyIds: bodyIds.map((id) => toBodyId(id)),
    format
  };
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
    !Array.isArray(digest.warnings)
  ) {
    throw badRequest('"digest" is missing required fields.');
  }
  return { prompt, digest: digest as unknown as CadDocumentDigest };
}
