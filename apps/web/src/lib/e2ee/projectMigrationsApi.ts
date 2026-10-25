/**
 * The migration routes of moving an existing plaintext project to
 * encrypted storage (ADR-024 Phase 7, slice 7-1):
 * `/api/e2ee/projects/:id/migration…`. Thin transport only; the engine that
 * stages a project's revisions, files and head is slice 7-2.
 *
 * While staging, every encrypted-project request the engine sends for the
 * project names the lease: {@link withMigrationLease} wraps a fetcher so
 * the existing clients (`encryptedDocumentsApi.ts`, `projectGroups.ts`,
 * `encryptedContentBlobs.ts`, `replacedEnvelopes.ts`) carry it unchanged.
 * Refusals are `ApiError`s with the Worker's code (`E2EE_MIGRATION_CODES`,
 * 409 PROJECT_MIGRATING on the plaintext routes).
 */
import {
  E2EE_MIGRATION_LEASE_HEADER,
  type E2eeMigrationCutoverResponse,
  type E2eeMigrationLeaseResponse,
  type E2eeMigrationStartRequest,
  type E2eeMigrationStepResponse,
  type E2eeProjectMigrationResponse
} from '@openzcad/shared';
import { ApiError } from '../api';
import { desktopFetch } from '../desktopBridge';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProjectMigrationsApi {
  /** The project's migration, or null when it never started one. */
  status(
    projectId: string,
    leaseId?: string | null
  ): Promise<E2eeProjectMigrationResponse>;
  /** Starts staging, or resumes it once a lease lapsed (or with its own). */
  start(
    projectId: string,
    request: E2eeMigrationStartRequest,
    leaseId?: string | null
  ): Promise<E2eeMigrationLeaseResponse>;
  renew(
    projectId: string,
    leaseId: string
  ): Promise<E2eeMigrationLeaseResponse>;
  cutover(
    projectId: string,
    leaseId: string
  ): Promise<E2eeMigrationCutoverResponse>;
  /** One bounded step; call again while `complete` is false. */
  abandon(
    projectId: string,
    leaseId?: string | null
  ): Promise<E2eeMigrationStepResponse>;
  /** One bounded step; call again while `complete` is false. */
  purge(projectId: string): Promise<E2eeMigrationStepResponse>;
}

/** A fetcher whose every request names the migration lease. */
export function withMigrationLease(fetcher: Fetch, leaseId: string): Fetch {
  return (input, init = {}) => {
    // A plain record, which every fetcher in the app spreads safely.
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    headers[E2EE_MIGRATION_LEASE_HEADER] = leaseId;
    return fetcher(input, { ...init, headers });
  };
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

export function createProjectMigrationsApi(
  fetcher: Fetch = desktopFetch
): ProjectMigrationsApi {
  const path = (projectId: string, action?: string) =>
    `/api/e2ee/projects/${encodeURIComponent(projectId)}/migration${action ? `/${action}` : ''}`;
  const send = async <T>(
    url: string,
    method: string,
    leaseId?: string | null,
    body?: unknown
  ): Promise<T> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (leaseId) headers[E2EE_MIGRATION_LEASE_HEADER] = leaseId;
    const response = await fetcher(url, {
      method,
      credentials: 'same-origin',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) throw await refusal(response);
    try {
      return (await response.json()) as T;
    } catch {
      throw new ApiError(502, 'The migration route answered garbage.');
    }
  };
  return {
    status: (projectId, leaseId) => send(path(projectId), 'GET', leaseId),
    start: (projectId, request, leaseId) =>
      send(path(projectId), 'POST', leaseId, request),
    renew: (projectId, leaseId) =>
      send(path(projectId, 'lease'), 'POST', leaseId),
    cutover: (projectId, leaseId) =>
      send(path(projectId, 'cutover'), 'POST', leaseId),
    abandon: (projectId, leaseId) =>
      send(path(projectId, 'abandon'), 'POST', leaseId),
    purge: (projectId) => send(path(projectId, 'purge'), 'POST')
  };
}
