import type {
  E2eeAccountKeyHistoryResponse,
  E2eeAccountResponse,
  E2eeAppendDeviceListRequest,
  E2eeApprovalRecord,
  E2eeCompleteApprovalRequest,
  E2eeConfigResponse,
  E2eeCreateApprovalRequest,
  E2eeReplaceIdentityRequest,
  E2eeSetupRequest
} from '@openzcad/shared';
import { desktopFetch } from '../desktopBridge';

/** A refusal from the key routes, with the Worker's stable `code`. */
export class E2eeApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = 'E2eeApiError';
  }
}

/**
 * The `/api/e2ee/*` routes (ADR-024 Phase 3). The Worker stores and relays;
 * every value here is either public or already wrapped in the browser, and
 * `accountKeys.ts` verifies whatever comes back before using it.
 */
export interface E2eeApi {
  config(): Promise<E2eeConfigResponse>;
  account(): Promise<E2eeAccountResponse>;
  /** This account's replaced account keys, each wrapped under its successor. */
  accountKeyHistory(): Promise<E2eeAccountKeyHistoryResponse>;
  setup(request: E2eeSetupRequest): Promise<E2eeAccountResponse>;
  appendDeviceList(
    request: E2eeAppendDeviceListRequest
  ): Promise<E2eeAccountResponse>;
  replaceIdentity(
    request: E2eeReplaceIdentityRequest
  ): Promise<E2eeAccountResponse>;
  createApproval(
    request: E2eeCreateApprovalRequest
  ): Promise<E2eeApprovalRecord>;
  listApprovals(): Promise<{ approvals: E2eeApprovalRecord[] }>;
  getApproval(id: string): Promise<E2eeApprovalRecord>;
  respondApproval(
    id: string,
    request: { approverKey: string; approverNonce: string }
  ): Promise<E2eeApprovalRecord>;
  revealApproval(
    id: string,
    request: { nonce: string }
  ): Promise<E2eeApprovalRecord>;
  completeApproval(
    id: string,
    request: E2eeCompleteApprovalRequest
  ): Promise<E2eeApprovalRecord>;
  cancelApproval(id: string): Promise<{ ok: true }>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

async function call<T>(
  fetcher: Fetch,
  path: string,
  method = 'GET',
  body?: unknown
): Promise<T> {
  const response = await fetcher(path, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // A static host answers unknown routes with HTML; that is "not here".
  }
  if (!response.ok || payload === null || typeof payload !== 'object') {
    const details = (payload ?? {}) as { error?: unknown; code?: unknown };
    throw new E2eeApiError(
      response.ok ? 502 : response.status,
      typeof details.error === 'string'
        ? details.error
        : `${response.status} ${response.statusText}`,
      typeof details.code === 'string' ? details.code : undefined
    );
  }
  return payload as T;
}

export function createE2eeApi(fetcher: Fetch = desktopFetch): E2eeApi {
  const id = (value: string) => encodeURIComponent(value);
  return {
    config: () => call(fetcher, '/api/e2ee/config'),
    account: () => call(fetcher, '/api/e2ee/account'),
    accountKeyHistory: () => call(fetcher, '/api/e2ee/account-key-history'),
    setup: (request) => call(fetcher, '/api/e2ee/setup', 'POST', request),
    appendDeviceList: (request) =>
      call(fetcher, '/api/e2ee/device-list', 'POST', request),
    replaceIdentity: (request) =>
      call(fetcher, '/api/e2ee/identity', 'POST', request),
    createApproval: (request) =>
      call(fetcher, '/api/e2ee/approvals', 'POST', request),
    listApprovals: () => call(fetcher, '/api/e2ee/approvals'),
    getApproval: (approvalId) =>
      call(fetcher, `/api/e2ee/approvals/${id(approvalId)}`),
    respondApproval: (approvalId, request) =>
      call(
        fetcher,
        `/api/e2ee/approvals/${id(approvalId)}/respond`,
        'POST',
        request
      ),
    revealApproval: (approvalId, request) =>
      call(
        fetcher,
        `/api/e2ee/approvals/${id(approvalId)}/reveal`,
        'POST',
        request
      ),
    completeApproval: (approvalId, request) =>
      call(
        fetcher,
        `/api/e2ee/approvals/${id(approvalId)}/complete`,
        'POST',
        request
      ),
    cancelApproval: (approvalId) =>
      call(fetcher, `/api/e2ee/approvals/${id(approvalId)}`, 'DELETE')
  };
}

/** One `/api/e2ee/*` call with this module's error handling, for sibling APIs. */
export { call as callE2eeRoute, type Fetch as E2eeFetch };
