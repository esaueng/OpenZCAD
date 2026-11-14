/**
 * Per-project assistant consent on encrypted projects (ADR-024 Phase 6,
 * slice 6-1). The record `{userId, projectId, allowed, copyVersion, route,
 * sequence}` is MAC'd under a key the account key derives
 * (`@openzcad/crypto` assistant consent), stored by the Worker and pinned on
 * this device per project: a server copy whose MAC does not verify, that
 * names another account or project, or whose sequence is older than the pin
 * is refused, and the assistant then sends nothing. A server-forged consent
 * therefore never makes this browser send. Loaded on demand (it brings the
 * crypto package), only for an encrypted project.
 */
import {
  encodeAssistantConsent,
  fromBase64Url,
  macAssistantConsent,
  openAssistantConsent,
  toBase64Url
} from '@openzcad/crypto';
import {
  ASSISTANT_CONSENT_COPY_VERSION,
  type E2eeAssistantConsentListResponse,
  type E2eeAssistantConsentRecord,
  type E2eeAssistantConsentResponse,
  type E2eeConfigResponse,
  type E2eeProjectAssistantConsentsResponse,
  type E2eeSaveAssistantConsentRequest
} from '@openzcad/shared';
import { desktopFetch } from '../desktopBridge';
import {
  localStorageConsentPins,
  type ConsentPinStore
} from './assistantConsentPins';
import { E2eeApiError } from './e2eeApi';
import { unlockedAccount } from './unlockedKeys';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface AssistantConsentApi {
  list(): Promise<E2eeAssistantConsentListResponse>;
  load(projectId: string): Promise<E2eeAssistantConsentResponse>;
  save(
    projectId: string,
    request: E2eeSaveAssistantConsentRequest
  ): Promise<E2eeAssistantConsentResponse>;
  members(projectId: string): Promise<E2eeProjectAssistantConsentsResponse>;
  /**
   * The account's key config: the consent routes answer only while
   * encrypted projects are open to it, so Settings asks first.
   */
  config?(): Promise<E2eeConfigResponse>;
}

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

const ROUTE = '/api/e2ee/assistant-consents';

export function createAssistantConsentApi(
  fetcher: Fetch = desktopFetch
): AssistantConsentApi {
  const one = (projectId: string) =>
    `${ROUTE}/${encodeURIComponent(projectId)}`;
  return {
    list: () => call(fetcher, ROUTE),
    load: (projectId) => call(fetcher, one(projectId)),
    save: (projectId, request) => call(fetcher, one(projectId), 'PUT', request),
    members: (projectId) => call(fetcher, `${one(projectId)}/members`),
    config: () => call(fetcher, '/api/e2ee/config')
  };
}

export {
  assistantConsentCurrent,
  localStorageConsentPins,
  memoryConsentPins,
  type ConsentPinStore,
  type VerifiedAssistantConsent
} from './assistantConsentPins';

export interface AssistantConsentContext {
  readonly userId: string;
  /** The unlocked account key; never sent anywhere. */
  readonly accountKey: Uint8Array;
  readonly api: AssistantConsentApi;
  readonly pins: ConsentPinStore;
}

export type AssistantConsentState =
  /** Never answered (and this device saw no answer either). */
  | { readonly kind: 'none'; readonly floor: number }
  | {
      readonly kind: 'verified';
      readonly allowed: boolean;
      readonly copyVersion: number;
      readonly route: string;
      readonly sequence: number;
      readonly updatedAt: string;
    }
  | {
      readonly kind: 'refused';
      /** Bad MAC or malformed (`unverified`); older than the pin (`rollback`). */
      readonly reason: 'unverified' | 'rollback';
      readonly message: string;
      /** What a fresh write must exceed. */
      readonly floor: number;
    };

const UNVERIFIED_MESSAGE =
  'The account’s copy of your assistant choice for this project did not verify with your keys, so it is not trusted and nothing is sent.';
const ROLLBACK_MESSAGE =
  'The account returned an older assistant choice for this project than this device has seen, so it is not trusted and nothing is sent.';

async function verify(
  ctx: AssistantConsentContext,
  projectId: string,
  stored: E2eeAssistantConsentRecord,
  pinned: number | null
): Promise<AssistantConsentState> {
  const floor = Math.max(
    pinned ?? 0,
    Number.isSafeInteger(stored.sequence) ? stored.sequence : 0
  );
  let opened;
  try {
    opened = await openAssistantConsent(
      ctx.accountKey,
      fromBase64Url(stored.record),
      fromBase64Url(stored.recordMac)
    );
  } catch {
    return {
      kind: 'refused',
      reason: 'unverified',
      message: UNVERIFIED_MESSAGE,
      floor
    };
  }
  // Only the MAC'd record counts; the Worker's columns must agree with it.
  if (
    opened.userId !== ctx.userId ||
    opened.projectId !== projectId ||
    opened.sequence !== stored.sequence ||
    opened.allowed !== stored.allowed
  ) {
    return {
      kind: 'refused',
      reason: 'unverified',
      message: UNVERIFIED_MESSAGE,
      floor: Math.max(floor, opened.sequence)
    };
  }
  if (pinned !== null && opened.sequence < pinned) {
    return {
      kind: 'refused',
      reason: 'rollback',
      message: ROLLBACK_MESSAGE,
      floor
    };
  }
  // A Stop this device recorded at or past this record (even one whose save
  // failed, or one saved in another tab) outranks it.
  const revoked = await ctx.pins.revoked(ctx.userId, projectId);
  if (opened.allowed && revoked !== null && opened.sequence <= revoked) {
    return {
      kind: 'refused',
      reason: 'rollback',
      message: ROLLBACK_MESSAGE,
      floor: Math.max(floor, revoked)
    };
  }
  await ctx.pins.write(ctx.userId, projectId, opened.sequence);
  if (!opened.allowed) {
    await ctx.pins.revoke(ctx.userId, projectId, opened.sequence);
  }
  return {
    kind: 'verified',
    allowed: opened.allowed,
    copyVersion: opened.copyVersion,
    route: opened.route,
    sequence: opened.sequence,
    updatedAt: stored.updatedAt
  };
}

/** Reads, verifies and pins this account's consent for one project. */
export async function loadAssistantConsent(
  ctx: AssistantConsentContext,
  projectId: string
): Promise<AssistantConsentState> {
  const [{ consent }, pinned] = await Promise.all([
    ctx.api.load(projectId),
    ctx.pins.read(ctx.userId, projectId)
  ]);
  if (!consent) {
    // A record this device saw that the account no longer has is a
    // rollback; refusing it costs nothing, since refusing sends nothing.
    return pinned === null
      ? { kind: 'none', floor: 0 }
      : {
          kind: 'refused',
          reason: 'rollback',
          message: ROLLBACK_MESSAGE,
          floor: pinned
        };
  }
  return verify(ctx, projectId, consent, pinned);
}

/**
 * Verifies a record from the account's list (Settings › Encryption), with
 * the same pin. Never trusts the Worker's columns on their own.
 */
export async function verifyListedConsent(
  ctx: AssistantConsentContext,
  stored: E2eeAssistantConsentRecord
): Promise<AssistantConsentState> {
  return verify(
    ctx,
    stored.projectId,
    stored,
    await ctx.pins.read(ctx.userId, stored.projectId)
  );
}

export const ASSISTANT_CONSENT_STOPPED_MESSAGE =
  'The assistant was stopped for this project while it was being allowed, so it stays stopped and nothing was sent.';

/**
 * Writes the next record, one past everything this device knows of: its
 * pin and the account's last sequence (`floor`). `allowed = false` is a
 * revocation. The answer must be the record just written.
 *
 * `current`: for an Allow, whether no Stop came since the Allow was asked
 * for (`assistantStopGeneration`, read before its first await). Asked again
 * immediately before the save and before its answer is accepted: a Stop
 * that came first refuses the Allow, and an Allow the account stored after
 * it is revoked here, so this device never uses it.
 */
export async function saveAssistantConsent(
  ctx: AssistantConsentContext,
  projectId: string,
  choice: { allowed: boolean; route: string },
  floor: number,
  current: () => boolean = () => true
): Promise<AssistantConsentState> {
  const stopped = () =>
    new E2eeApiError(409, ASSISTANT_CONSENT_STOPPED_MESSAGE);
  const [pinned, revoked] = await Promise.all([
    ctx.pins.read(ctx.userId, projectId),
    ctx.pins.revoked(ctx.userId, projectId)
  ]);
  const sequence = Math.max(pinned ?? 0, revoked ?? 0, floor) + 1;
  // A revocation holds here from now on, whether or not its save succeeds:
  // no consent before it is used again on this device.
  if (!choice.allowed) await ctx.pins.revoke(ctx.userId, projectId, sequence);
  const record = encodeAssistantConsent({
    userId: ctx.userId,
    projectId,
    allowed: choice.allowed,
    copyVersion: ASSISTANT_CONSENT_COPY_VERSION,
    route: choice.allowed ? choice.route : '',
    sequence
  });
  const mac = await macAssistantConsent(ctx.accountKey, record);
  if (choice.allowed && !current()) throw stopped();
  const { consent } = await ctx.api.save(projectId, {
    record: toBase64Url(record),
    recordMac: toBase64Url(mac)
  });
  if (choice.allowed && !current()) {
    // Stored after a Stop this device saw: never used here.
    await ctx.pins.revoke(ctx.userId, projectId, sequence);
    throw stopped();
  }
  if (!consent || consent.record !== toBase64Url(record)) {
    throw new E2eeApiError(
      502,
      'The account did not store this choice as sent. Try again.'
    );
  }
  return verify(
    ctx,
    projectId,
    consent,
    await ctx.pins.read(ctx.userId, projectId)
  );
}

/** What a write must exceed, from any state. */
export function consentFloor(state: AssistantConsentState): number {
  return state.kind === 'verified' ? state.sequence : state.floor;
}

/**
 * The one test before anything is sent: a verified record that allows this
 * project, for the current copy and for exactly this provider route.
 */
export function consentPermits(
  state: AssistantConsentState | null | undefined,
  route: string
): boolean {
  return (
    state?.kind === 'verified' &&
    state.allowed &&
    state.copyVersion === ASSISTANT_CONSENT_COPY_VERSION &&
    state.route === route
  );
}

/** The signed-in account's id, for views that are not handed one. */
export async function sessionUserId(
  fetcher: Fetch = desktopFetch
): Promise<string | null> {
  try {
    const response = await fetcher('/api/session', {
      credentials: 'same-origin'
    });
    if (!response.ok) return null;
    const session = (await response.json()) as { userId?: unknown };
    return typeof session.userId === 'string' ? session.userId : null;
  } catch {
    return null;
  }
}

/** This page's consent context for an account, when its keys are unlocked here. */
export function assistantConsentContext(
  userId: string,
  api: AssistantConsentApi = createAssistantConsentApi(),
  pins: ConsentPinStore = localStorageConsentPins()
): AssistantConsentContext | null {
  const account = unlockedAccount(userId);
  return account ? { userId, accountKey: account.accountKey, api, pins } : null;
}
