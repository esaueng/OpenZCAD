/**
 * Wire types of per-project assistant consent on encrypted projects
 * (ADR-024 Phase 6, slice 6-1; roadmap L11), served under
 * `/api/e2ee/assistant-consents`. The browser trusts only `record` and
 * `recordMac` (base64url canonical JSON and its HMAC under a key its account
 * key derives); the other fields are the Worker's reading of the record, for
 * its own gate on `/api/assistant/proposals` and for co-members to see who
 * allowed the assistant (plan default M6).
 */

import { sha256HexSync } from './sha256-sync';

/**
 * The consent copy's version. Bump it whenever the list of what an
 * assistant request sends changes (apps/web/src/lib/assistant/consentCopy.ts
 * pins the two together): every browser then asks again, and the Worker
 * stops honouring consent given to an older copy.
 */
export const ASSISTANT_CONSENT_COPY_VERSION = 1;

/**
 * The Worker refuses an encrypted project's assistant request with this
 * code (409) when consent storage is installed but this account has no
 * live consent for the project, for this copy and provider route.
 */
export const ENCRYPTED_PROJECT_ASSISTANT_CONSENT_REQUIRED_CODE =
  'ENCRYPTED_PROJECT_ASSISTANT_CONSENT_REQUIRED';

/**
 * Who receives an assistant request: whose key, which provider and model,
 * and the upstream endpoint the Worker sends it to.
 */
export interface AssistantConsentRouteInput {
  /** Absent from older status answers; a deployment key then. */
  source?: 'deployment' | 'personal';
  provider: string;
  model: string;
  /**
   * The normalized upstream URL: a personal base URL, the deployment's
   * `AI_BASE_URL` or the provider's default. Absent from older Workers.
   */
  endpoint?: string;
}

/**
 * The provider route a consent names, as one string both the browser and
 * the Worker compute from the effective assistant settings. A change of
 * key source, provider, model or endpoint is a different route, so consent
 * is asked again. The readable part is cut short for display only; the
 * digest binds every component in full, so distinct routes never collide.
 */
export function assistantConsentRoute(
  input: AssistantConsentRouteInput
): string {
  const source = input.source === 'personal' ? 'personal' : 'deployment';
  const label = (value: string, max: number) =>
    value.replace(/[^\x20-\x7e]|\|/g, '?').slice(0, max);
  return [
    'v2',
    source,
    label(input.provider, 40),
    label(input.model, 60),
    sha256HexSync(
      JSON.stringify([
        source,
        input.provider,
        input.model,
        input.endpoint ?? ''
      ])
    )
  ].join('|');
}

/** One stored consent, as the Worker returns it to its owner. */
export interface E2eeAssistantConsentRecord {
  projectId: string;
  record: string;
  recordMac: string;
  allowed: boolean;
  copyVersion: number;
  route: string;
  sequence: number;
  updatedAt: string;
  /** Set when the latest record is a revocation. */
  revokedAt: string | null;
}

export interface E2eeAssistantConsentResponse {
  consent: E2eeAssistantConsentRecord | null;
}

export interface E2eeAssistantConsentListResponse {
  consents: E2eeAssistantConsentRecord[];
}

export interface E2eeSaveAssistantConsentRequest {
  record: string;
  recordMac: string;
}

/**
 * Who on a project has the assistant allowed: readable by the project's
 * owner and members (M6). Informational only; only each user's own
 * browser can verify that user's record.
 */
export interface E2eeProjectAssistantConsentSummary {
  userId: string;
  allowed: boolean;
  updatedAt: string;
}

export interface E2eeProjectAssistantConsentsResponse {
  consents: E2eeProjectAssistantConsentSummary[];
}
