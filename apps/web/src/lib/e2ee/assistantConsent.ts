/**
 * Per-project assistant consent on encrypted projects (ADR-024 Phase 6,
 * slice 6-1). The record `{userId, projectId, allowed, copyVersion, route,
 * sequence}` is MAC'd under a key the account key derives
 * (`@openzcad/crypto` assistant consent), stored by the Worker and checked
 * against this device's consent log (`assistantConsentPins.ts`): a server
 * copy whose MAC does not verify, that names another account or project,
 * that is older than a record this device has seen, or that a Stop on this
 * device revoked is refused, and the assistant then sends nothing. A
 * server-forged consent therefore never makes this browser send. Loaded on
 * demand (it brings the crypto package), only for an encrypted project.
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
  type ConsentEntry,
  type ConsentPinStore,
  type ConsentTicket
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
  type ConsentTicket,
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
      /**
       * Bad MAC or malformed (`unverified`); older than a record this device
       * has seen (`rollback`); an Allow a Stop on this device revoked, or
       * consent latched closed here (`stopped`); this device's consent log
       * could not be read or written (`unrecorded`).
       */
      readonly reason: 'unverified' | 'rollback' | 'stopped' | 'unrecorded';
      readonly message: string;
      /** What a fresh write must exceed. */
      readonly floor: number;
    };

const UNVERIFIED_MESSAGE =
  'The account’s copy of your assistant choice for this project did not verify with your keys, so it is not trusted and nothing is sent.';
const ROLLBACK_MESSAGE =
  'The account returned an older assistant choice for this project than this device has seen, so it is not trusted and nothing is sent.';
export const ASSISTANT_CONSENT_STOPPED_HERE_MESSAGE =
  'The assistant was stopped for this project on this device, so the account’s earlier Allow is not used here and nothing is sent. Allow it again to continue.';
export const ASSISTANT_CONSENT_UNRECORDED_MESSAGE =
  'This device could not record your assistant choice for this project, so the assistant stays stopped here and nothing is sent. Once this browser’s storage works again, choose Allow to turn it back on.';

const REFUSALS = {
  rollback: ROLLBACK_MESSAGE,
  stopped: ASSISTANT_CONSENT_STOPPED_HERE_MESSAGE,
  unrecorded: ASSISTANT_CONSENT_UNRECORDED_MESSAGE
} as const;

async function verify(
  ctx: AssistantConsentContext,
  projectId: string,
  stored: E2eeAssistantConsentRecord
): Promise<AssistantConsentState> {
  const floor = () =>
    Math.max(
      ctx.pins.seen(ctx.userId, projectId) ?? 0,
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
      floor: floor()
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
      floor: Math.max(floor(), opened.sequence)
    };
  }
  // Decided against this device's consent log as it stands now, after the
  // last await: a Stop that came while the record was verified revokes it.
  const outcome = ctx.pins.observe(
    ctx.userId,
    projectId,
    opened.sequence,
    opened.allowed
  );
  if (outcome !== 'accepted') {
    return {
      kind: 'refused',
      reason: outcome,
      message: REFUSALS[outcome],
      floor: floor()
    };
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

/** Reads and verifies this account's consent for one project. */
export async function loadAssistantConsent(
  ctx: AssistantConsentContext,
  projectId: string
): Promise<AssistantConsentState> {
  const { consent } = await ctx.api.load(projectId);
  if (!consent) {
    const seen = ctx.pins.seen(ctx.userId, projectId);
    if (seen === undefined) {
      return {
        kind: 'refused',
        reason: 'unrecorded',
        message: ASSISTANT_CONSENT_UNRECORDED_MESSAGE,
        floor: 0
      };
    }
    // A record this device saw that the account no longer has is a
    // rollback; refusing it costs nothing, since refusing sends nothing.
    return seen === null
      ? { kind: 'none', floor: 0 }
      : {
          kind: 'refused',
          reason: 'rollback',
          message: ROLLBACK_MESSAGE,
          floor: seen
        };
  }
  return verify(ctx, projectId, consent);
}

/**
 * Verifies a record from the account's list (Settings › Encryption)
 * against the same log. Never trusts the Worker's columns on their own.
 */
export async function verifyListedConsent(
  ctx: AssistantConsentContext,
  stored: E2eeAssistantConsentRecord
): Promise<AssistantConsentState> {
  return verify(ctx, stored.projectId, stored);
}

export const ASSISTANT_CONSENT_STOPPED_MESSAGE =
  'The assistant was stopped for this project while it was being allowed, so it stays stopped and nothing was sent.';

/**
 * What a save was registered as before its caller's first await: the
 * Allow's ticket (`ConsentPinStore.beginAllow`, null when it could not be
 * recorded) or the Stop's entry (`ConsentPinStore.stop`). Registered on the
 * call, before anything is awaited, when not given.
 */
export type ConsentRegistration =
  { readonly ticket: ConsentTicket | null } | { readonly stop: ConsentEntry };

/**
 * Writes the next record, past everything this device's log and the
 * account (`floor`) know of. `allowed = false` is a revocation. The answer
 * must be the record just written.
 *
 * An Allow is registered in the log before anything is awaited, and gets
 * its sequence durably before the record is sent, so a Stop at any later
 * point (before the save, during it, or while its answer is verified)
 * revokes it; an Allow refused or failed after that is given up
 * (`withdraw`), so its record is never used here even if the account
 * stored it. A Stop is registered likewise and holds on this device
 * whatever becomes of its save.
 */
export async function saveAssistantConsent(
  ctx: AssistantConsentContext,
  projectId: string,
  choice: { allowed: boolean; route: string },
  floor: number,
  registered?: ConsentRegistration
): Promise<AssistantConsentState> {
  const stopped = () =>
    new E2eeApiError(409, ASSISTANT_CONSENT_STOPPED_MESSAGE);
  const unrecorded = () =>
    new E2eeApiError(409, ASSISTANT_CONSENT_UNRECORDED_MESSAGE);
  let allow: ConsentTicket | null = null;
  let sequence: number;
  if (choice.allowed) {
    allow =
      registered && 'ticket' in registered
        ? registered.ticket
        : ctx.pins.beginAllow(ctx.userId, projectId);
    if (!allow) throw unrecorded();
    const assigned = ctx.pins.assign(allow, floor);
    if (assigned.kind === 'stopped') {
      ctx.pins.withdraw(allow);
      throw stopped();
    }
    if (assigned.kind === 'unrecorded') throw unrecorded();
    sequence = assigned.sequence;
  } else {
    const stop =
      registered && 'stop' in registered
        ? registered.stop
        : ctx.pins.stop(ctx.userId, projectId);
    sequence = Math.max(floor + 1, stop.sequence ?? 0);
  }
  const ticket = allow;
  try {
    const record = encodeAssistantConsent({
      userId: ctx.userId,
      projectId,
      allowed: choice.allowed,
      copyVersion: ASSISTANT_CONSENT_COPY_VERSION,
      route: choice.allowed ? choice.route : '',
      sequence
    });
    const mac = await macAssistantConsent(ctx.accountKey, record);
    if (ticket && !ctx.pins.ticketCurrent(ticket)) throw stopped();
    const { consent } = await ctx.api.save(projectId, {
      record: toBase64Url(record),
      recordMac: toBase64Url(mac)
    });
    if (ticket && !ctx.pins.ticketCurrent(ticket)) throw stopped();
    if (!consent || consent.record !== toBase64Url(record)) {
      throw new E2eeApiError(
        502,
        'The account did not store this choice as sent. Try again.'
      );
    }
    const state = await verify(ctx, projectId, consent);
    if (ticket) {
      if (!ctx.pins.ticketCurrent(ticket)) throw stopped();
      if (state.kind === 'refused') {
        throw state.reason === 'stopped'
          ? stopped()
          : new E2eeApiError(409, state.message);
      }
    }
    return state;
  } catch (error) {
    // Refused or failed after its sequence was assigned: given up, so the
    // record (if the account stored it) is never used on this device.
    if (ticket) ctx.pins.withdraw(ticket);
    throw error;
  }
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
