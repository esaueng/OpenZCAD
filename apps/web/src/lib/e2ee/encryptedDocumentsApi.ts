/**
 * The encrypted document routes (ADR-024 Phase 4, encrypted documents):
 * `POST /api/e2ee/projects` and `/api/e2ee/projects/:id/{document,
 * versions, revisions, info}`. Envelopes travel as raw bytes in frames;
 * everything that comes back is verified by `encryptedProjectStore.ts`.
 * Refusals are `ApiError`s, so the sync paths read them as they read the
 * plaintext routes' (409 conflict, 401 session, 413 size, 503 repair).
 */
import {
  E2EE_FRAME_CONTENT_TYPE,
  decodeE2eeFrame,
  encodeE2eeFrame,
  type E2eeCreateProjectMetadata,
  type E2eeCreateProjectResponse,
  type E2eeDocumentHeadMetadata,
  type E2eeProjectEnvelopeUpload,
  type E2eeProjectInfoResponse,
  type E2eeRevisionMetadata,
  type E2eeRevisionUpload,
  type E2eeRevisionsResponse,
  type E2eeSaveVersionResponse,
  type E2eeVersionLogResponse,
  type E2eeVersionUpload
} from '@openzcad/shared';
import { ApiError } from '../api';
import { desktopFetch } from '../desktopBridge';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface EncryptedDocumentsApi {
  create(
    metadata: E2eeCreateProjectMetadata,
    envelope: Uint8Array
  ): Promise<E2eeCreateProjectResponse>;
  saveDocument(
    projectId: string,
    version: E2eeVersionUpload,
    envelope: Uint8Array
  ): Promise<E2eeSaveVersionResponse>;
  saveRevision(
    projectId: string,
    version: E2eeRevisionUpload,
    envelope: Uint8Array
  ): Promise<E2eeSaveVersionResponse>;
  /** The head and, with `since`, the log from that version up to it. */
  loadDocument(
    projectId: string,
    since?: number
  ): Promise<{ metadata: E2eeDocumentHeadMetadata; envelope: Uint8Array }>;
  versions(
    projectId: string,
    since?: number,
    through?: number
  ): Promise<E2eeVersionLogResponse>;
  revisions(projectId: string): Promise<E2eeRevisionsResponse>;
  /** Null when the account no longer keeps that save state. */
  revision(
    projectId: string,
    revisionId: string
  ): Promise<{ metadata: E2eeRevisionMetadata; envelope: Uint8Array } | null>;
  info(projectId: string): Promise<E2eeProjectInfoResponse>;
  saveInfo(
    projectId: string,
    upload: E2eeProjectEnvelopeUpload
  ): Promise<E2eeProjectInfoResponse>;
}

async function refusal(response: Response): Promise<ApiError> {
  const text = await response.text().catch(() => '');
  let details: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object') {
      details = parsed as Record<string, unknown>;
    }
  } catch {
    // A static host answers unknown routes with HTML.
  }
  return new ApiError(
    response.status,
    typeof details?.error === 'string'
      ? details.error
      : `${response.status} ${response.statusText}`,
    typeof details?.code === 'string' ? details.code : undefined,
    details
  );
}

export function createEncryptedDocumentsApi(
  fetcher: Fetch = desktopFetch
): EncryptedDocumentsApi {
  const base = (projectId: string) =>
    `/api/e2ee/projects/${encodeURIComponent(projectId)}`;
  const send = async (
    path: string,
    init: RequestInit = {}
  ): Promise<Response> => {
    const response = await fetcher(path, {
      credentials: 'same-origin',
      ...init
    });
    if (!response.ok) throw await refusal(response);
    return response;
  };
  const sendJson = async <T>(
    path: string,
    method = 'GET',
    body?: unknown
  ): Promise<T> => {
    const response = await send(path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    try {
      return (await response.json()) as T;
    } catch {
      throw new ApiError(502, 'The encrypted project route answered garbage.');
    }
  };
  const sendFrame = <T>(
    path: string,
    method: string,
    metadata: unknown,
    envelope: Uint8Array
  ) =>
    send(path, {
      method,
      headers: { 'content-type': E2EE_FRAME_CONTENT_TYPE },
      body: encodeE2eeFrame(metadata, envelope)
    }).then((response) => response.json() as Promise<T>);
  const readFrame = async <T>(response: Response) => {
    try {
      const { metadata, payload } = decodeE2eeFrame(
        new Uint8Array(await response.arrayBuffer())
      );
      return { metadata: metadata as T, envelope: payload };
    } catch {
      throw new ApiError(502, 'The encrypted project route answered garbage.');
    }
  };
  return {
    create: (metadata, envelope) =>
      sendFrame('/api/e2ee/projects', 'POST', metadata, envelope),
    saveDocument: (projectId, version, envelope) =>
      sendFrame(`${base(projectId)}/document`, 'PUT', { version }, envelope),
    saveRevision: (projectId, version, envelope) =>
      sendFrame(`${base(projectId)}/revisions`, 'POST', { version }, envelope),
    loadDocument: async (projectId, since) =>
      readFrame<E2eeDocumentHeadMetadata>(
        await send(
          `${base(projectId)}/document${since === undefined ? '' : `?since=${since}`}`
        )
      ),
    versions: (projectId, since, through) => {
      const query = new URLSearchParams();
      if (since !== undefined) query.set('since', String(since));
      if (through !== undefined) query.set('through', String(through));
      return sendJson(
        `${base(projectId)}/versions${query.size ? `?${query}` : ''}`
      );
    },
    revisions: (projectId) => sendJson(`${base(projectId)}/revisions`),
    revision: async (projectId, revisionId) => {
      try {
        return await readFrame<E2eeRevisionMetadata>(
          await send(
            `${base(projectId)}/revisions/${encodeURIComponent(revisionId)}`
          )
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    info: (projectId) => sendJson(`${base(projectId)}/info`),
    saveInfo: (projectId, upload) =>
      sendJson(`${base(projectId)}/info`, 'PUT', upload)
  };
}
