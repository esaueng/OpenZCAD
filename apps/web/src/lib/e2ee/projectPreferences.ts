/**
 * The "Encrypt new projects" opt-in (ADR-024 Phase 4, decision D2). The
 * record `{userId, encryptNewProjects, sequence}` is MAC'd under a key the
 * account key derives (`@openzcad/crypto` account records), stored by the
 * Worker, and pinned on this device: a server copy whose MAC does not verify,
 * that names another account, or whose sequence is older than the pin is
 * refused, and the setting is shown as unknown rather than as off.
 */
import {
  encodeProjectPreferences,
  fromBase64Url,
  macProjectPreferences,
  openProjectPreferences,
  toBase64Url
} from '@openzcad/crypto';
import type {
  E2eeConfigResponse,
  E2eeProjectPreferenceRecord,
  E2eeProjectPreferenceResponse,
  E2eeSaveProjectPreferenceRequest
} from '@openzcad/shared';
import { desktopFetch } from '../desktopBridge';
import { E2eeApiError } from './e2eeApi';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProjectPreferenceApi {
  config(): Promise<E2eeConfigResponse>;
  load(): Promise<E2eeProjectPreferenceResponse>;
  save(
    request: E2eeSaveProjectPreferenceRequest
  ): Promise<E2eeProjectPreferenceResponse>;
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

export function createProjectPreferenceApi(
  fetcher: Fetch = desktopFetch
): ProjectPreferenceApi {
  return {
    config: () => call(fetcher, '/api/e2ee/config'),
    load: () => call(fetcher, '/api/e2ee/project-preferences'),
    save: (request) =>
      call(fetcher, '/api/e2ee/project-preferences', 'PUT', request)
  };
}

import type { PreferencePinStore } from './preferencePins';
export {
  localStoragePreferencePins,
  memoryPreferencePins,
  type PreferencePinStore
} from './preferencePins';

export interface ProjectPreferenceContext {
  readonly userId: string;
  /** The unlocked account key; never sent anywhere. */
  readonly accountKey: Uint8Array;
  readonly api: ProjectPreferenceApi;
  readonly pins: PreferencePinStore;
}

export type ProjectPreferenceRefusal =
  /** The MAC did not verify under this account key, or the record is malformed. */
  | 'unverified'
  /** Older than the sequence this device already accepted, or withdrawn. */
  | 'rollback';

export type ProjectPreferenceState =
  | { readonly kind: 'unset'; readonly pinned: number | null }
  | {
      readonly kind: 'verified';
      readonly encryptNewProjects: boolean;
      readonly sequence: number;
    }
  | {
      readonly kind: 'refused';
      readonly reason: ProjectPreferenceRefusal;
      readonly message: string;
      /** What a fresh write must exceed: the server's and the pin's sequence. */
      readonly floor: number;
    };

const UNVERIFIED_MESSAGE =
  'The account’s copy of this setting did not verify with your keys, so it is not trusted. Choose the setting again to replace it.';
const FORK_MESSAGE =
  'The account returned a different copy of this setting than this device has already seen at the same point, so it is not trusted. Choose the setting again to replace it.';
const ROLLBACK_MESSAGE =
  'The account returned an older copy of this setting than this device has already seen, so it is not trusted. Choose the setting again to replace it.';

async function verify(
  ctx: ProjectPreferenceContext,
  stored: E2eeProjectPreferenceRecord,
  pinned: number | null
): Promise<ProjectPreferenceState> {
  const floor = Math.max(
    pinned ?? 0,
    Number.isSafeInteger(stored.sequence) ? stored.sequence : 0
  );
  let opened;
  try {
    opened = await openProjectPreferences(
      ctx.accountKey,
      fromBase64Url(stored.record),
      fromBase64Url(stored.recordMac)
    );
  } catch {
    // A wrong key, altered bytes or a malformed record: none is trusted.
    return {
      kind: 'refused',
      reason: 'unverified',
      message: UNVERIFIED_MESSAGE,
      floor
    };
  }
  // The Worker's own reading of the record decides its refusals (D2); a copy
  // whose columns disagree with the MAC'd record is not trusted either.
  if (
    opened.userId !== ctx.userId ||
    opened.sequence !== stored.sequence ||
    opened.encryptNewProjects !== stored.encryptNewProjects
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
  await ctx.pins.write(ctx.userId, opened.sequence, opened.encryptNewProjects);
  // Another tab may have pinned a newer record since this one was read: an
  // older record is then a rollback, however it verified.
  const after = await ctx.pins.read(ctx.userId);
  if (after !== null && after > opened.sequence) {
    return {
      kind: 'refused',
      reason: 'rollback',
      message: ROLLBACK_MESSAGE,
      floor: Math.max(floor, after)
    };
  }
  // Two authentic records at one sequence (two tabs wrote at once): the
  // one this device pinned first stands, and the other is not an update.
  const pinnedValue = await ctx.pins.pinnedValue(ctx.userId);
  if (
    after === opened.sequence &&
    pinnedValue !== null &&
    pinnedValue !== opened.encryptNewProjects
  ) {
    return {
      kind: 'refused',
      reason: 'rollback',
      message: FORK_MESSAGE,
      floor: Math.max(floor, after)
    };
  }
  return {
    kind: 'verified',
    encryptNewProjects: opened.encryptNewProjects,
    sequence: opened.sequence
  };
}

/** Reads, verifies and pins the account's opt-in. */
export async function loadProjectPreference(
  ctx: ProjectPreferenceContext
): Promise<ProjectPreferenceState> {
  const [{ preference }, pinned] = await Promise.all([
    ctx.api.load(),
    ctx.pins.read(ctx.userId)
  ]);
  if (!preference) {
    // A record this device saw that the account no longer has is a rollback
    // too: withdrawing it would quietly turn the opt-in off.
    return pinned === null
      ? { kind: 'unset', pinned }
      : {
          kind: 'refused',
          reason: 'rollback',
          message: ROLLBACK_MESSAGE,
          floor: pinned
        };
  }
  return verify(ctx, preference, pinned);
}

/**
 * Writes a new record one past everything this device knows of: its pin and
 * the account's last sequence (`floor`). The answer must be the record just
 * written; it is verified and pinned like a load.
 */
export async function saveProjectPreference(
  ctx: ProjectPreferenceContext,
  encryptNewProjects: boolean,
  floor: number
): Promise<ProjectPreferenceState> {
  const pinned = await ctx.pins.read(ctx.userId);
  const sequence = Math.max(pinned ?? 0, floor) + 1;
  const record = encodeProjectPreferences({
    userId: ctx.userId,
    encryptNewProjects,
    sequence
  });
  const mac = await macProjectPreferences(ctx.accountKey, record);
  const { preference } = await ctx.api.save({
    record: toBase64Url(record),
    recordMac: toBase64Url(mac)
  });
  if (!preference || preference.record !== toBase64Url(record)) {
    throw new E2eeApiError(
      502,
      'The account did not store this setting as sent. Try again.'
    );
  }
  return verify(ctx, preference, await ctx.pins.read(ctx.userId));
}

/** What a toggle shows: the floor a write must exceed, from any state. */
export function preferenceFloor(state: ProjectPreferenceState): number {
  return state.kind === 'verified'
    ? state.sequence
    : state.kind === 'refused'
      ? state.floor
      : (state.pinned ?? 0);
}
