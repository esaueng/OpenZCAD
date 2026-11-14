/**
 * Review rounds 11 and 12 of PR #1418: a Stop must outrank every Allow
 * registered before it, in any tab, at whatever point it comes, and a
 * consent log storage refuses must latch consent closed on this device.
 *
 * Consent lives in one durable, de-duplicated log per account and project
 * (`assistantConsentPins.ts`): every Allow and Stop is an entry with its own
 * id, written when it is clicked; an Allow gets its record sequence durably
 * before the record is sent; every tab derives its answer from the stored
 * log, and the broadcast channel is only a hint to re-read it.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeAssistantConsent, fromBase64Url } from '@openzcad/crypto';
import {
  ASSISTANT_CONSENT_COPY_VERSION,
  toProjectId,
  type E2eeAssistantConsentRecord
} from '@openzcad/shared';
import * as consentModule from '../e2ee/assistantConsent';
import {
  ASSISTANT_CONSENT_CHANNEL,
  assistantConsentCurrent,
  assistantConsentLogPrefix,
  localStorageConsentPins,
  type ConsentPinStore,
  type ConsentStorage
} from '../e2ee/assistantConsentPins';
import { E2eeApiError } from '../e2ee/e2eeApi';
import { useAssistantConsentGate } from './consentGate';

const USER = 'user_stops';
const ROUTE = 'deployment:openrouter:test-model';
const OTHER_ROUTE = 'deployment:openrouter:other-model';
const ACCOUNT_KEY = new Uint8Array(32).fill(5);
let counter = 0;
const nextProject = () => `proj_stops_${(counter += 1)}`;

/** A gate held open until the test releases it. */
function hold() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

/** The Worker's consent routes, in memory; `before` runs ahead of each call. */
function consentServer() {
  const rows = new Map<string, E2eeAssistantConsentRecord>();
  const before = {
    load: async () => undefined as void,
    save: async () => undefined as void,
    afterSave: async () => undefined as void
  };
  const api: consentModule.AssistantConsentApi = {
    list: async () => ({ consents: [...rows.values()] }),
    load: async (projectId) => {
      await before.load();
      return { consent: rows.get(projectId) ?? null };
    },
    save: async (projectId, request) => {
      await before.save();
      const decoded = decodeAssistantConsent(fromBase64Url(request.record));
      const current = rows.get(projectId);
      if (current && current.sequence >= decoded.sequence) {
        throw new E2eeApiError(409, 'stale');
      }
      const row: E2eeAssistantConsentRecord = {
        projectId,
        record: request.record,
        recordMac: request.recordMac,
        allowed: decoded.allowed,
        copyVersion: decoded.copyVersion,
        route: decoded.route,
        sequence: decoded.sequence,
        updatedAt: new Date().toISOString(),
        revokedAt: decoded.allowed ? null : new Date().toISOString()
      };
      rows.set(projectId, row);
      await before.afterSave();
      return { consent: row };
    },
    members: async () => ({ consents: [] })
  };
  return { api, rows, before };
}

type Server = ReturnType<typeof consentServer>;

/**
 * This device's localStorage, with faults the test switches on: `full`
 * refuses new keys (shorter rewrites still fit), `all` refuses every write,
 * and `read` refuses every read. (happy-dom's storage is a Proxy spies do
 * not reach.)
 */
const faults = { write: 'none' as 'none' | 'full' | 'all', read: false };
const quota = () => new DOMException('Quota exceeded', 'QuotaExceededError');
const storage: ConsentStorage = {
  getItem(key) {
    if (faults.read) throw new DOMException('Blocked', 'SecurityError');
    return window.localStorage.getItem(key);
  },
  setItem(key, value) {
    if (faults.write === 'all') throw quota();
    if (faults.write === 'full') {
      const current = window.localStorage.getItem(key);
      if (current === null || value.length > current.length) throw quota();
    }
    window.localStorage.setItem(key, value);
  },
  removeItem: (key) => window.localStorage.removeItem(key),
  key(index) {
    if (faults.read) throw new DOMException('Blocked', 'SecurityError');
    return window.localStorage.key(index);
  },
  get length() {
    return window.localStorage.length;
  }
};

/** This device's log, as any tab reads it. */
const deviceLog = () => localStorageConsentPins(storage);
/** The send gate's check, on this device's storage. */
const current = (consent: {
  userId: string;
  projectId: string;
  sequence: number;
}) => assistantConsentCurrent(consent, storage);

const contextFor = (
  server: Server,
  pins: ConsentPinStore = deviceLog()
): consentModule.AssistantConsentContext => ({
  userId: USER,
  accountKey: ACCOUNT_KEY,
  api: server.api,
  pins
});

function renderGate(
  server: Server,
  projectId: string,
  pins: ConsentPinStore = deviceLog()
) {
  return renderHook(() =>
    useAssistantConsentGate(
      USER,
      { projectId: toProjectId(projectId), storageFormat: 2 },
      {
        loadModule: async () => consentModule,
        context: () => contextFor(server, pins),
        pins
      }
    )
  );
}

/**
 * Another tab's Stop: registered in this device's log, then its revocation
 * saved to the account unless `saved` is false (its read or save failed).
 */
async function otherTabStops(
  server: Server,
  projectId: string,
  { saved = true }: { saved?: boolean } = {}
) {
  const stop = deviceLog().stop(USER, projectId);
  if (!saved) return;
  const floor = server.rows.get(projectId)?.sequence ?? 0;
  const before = { ...server.before };
  server.before.load = async () => undefined;
  server.before.save = async () => undefined;
  server.before.afterSave = async () => undefined;
  try {
    await consentModule.saveAssistantConsent(
      contextFor(server),
      projectId,
      { allowed: false, route: '' },
      floor,
      { stop }
    );
  } finally {
    Object.assign(server.before, before);
  }
}

/** What a fresh read of the account's record decides now. */
async function freshRead(server: Server, projectId: string) {
  return consentModule.loadAssistantConsent(contextFor(server), projectId);
}

const grantOf = (projectId: string, sequence: number) => ({
  userId: USER,
  projectId,
  sequence
});

beforeEach(() => {
  window.localStorage.clear();
  faults.write = 'none';
  faults.read = false;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('an Allow in flight when another tab stops', () => {
  it('is refused before its save when the Stop came during its read', async () => {
    const server = consentServer();
    const projectId = nextProject();
    const { result } = renderGate(server, projectId);
    await waitFor(() => expect(result.current?.status.kind).toBe('ready'));

    // Tab A clicks Allow; it reads the account's record first.
    const read = hold();
    server.before.load = () => read.held;
    let allowing!: Promise<boolean>;
    act(() => {
      allowing = result.current!.allow(ROUTE);
    });
    // Tab B clicks Stop meanwhile.
    await otherTabStops(server, projectId);
    read.release();
    await act(async () => {
      await expect(allowing).resolves.toBe(false);
    });

    // The account's latest word is B's Stop, and nothing here permits.
    expect(server.rows.get(projectId)).toMatchObject({ allowed: false });
    expect(result.current!.permits(ROUTE)).toBe(false);
    expect(result.current!.grant(ROUTE)).toBeNull();
    const state = await freshRead(server, projectId);
    expect(consentModule.consentPermits(state, ROUTE)).toBe(false);
  });

  it('is revoked here when the Stop came while its save was answered', async () => {
    const server = consentServer();
    const projectId = nextProject();
    const { result } = renderGate(server, projectId);
    await waitFor(() => expect(result.current?.status.kind).toBe('ready'));

    const answer = hold();
    server.before.afterSave = () => answer.held;
    let allowing!: Promise<boolean>;
    act(() => {
      allowing = result.current!.allow(ROUTE);
    });
    await waitFor(() =>
      expect(server.rows.get(projectId)).toMatchObject({ allowed: true })
    );
    const allowSequence = server.rows.get(projectId)!.sequence;
    // B's Stop lands in the log before A accepts the answer, and B's own
    // save never reaches the account (its read failed).
    await otherTabStops(server, projectId, { saved: false });
    answer.release();
    await act(async () => {
      await expect(allowing).resolves.toBe(false);
    });

    expect(result.current!.grant(ROUTE)).toBeNull();
    // The Allow the account stored is never used on this device.
    const reread = await freshRead(server, projectId);
    expect(consentModule.consentPermits(reread, ROUTE)).toBe(false);
    expect(current(grantOf(projectId, allowSequence))).toBe(false);
  });

  it('is refused at the send when the Stop came after it was granted', async () => {
    const server = consentServer();
    const projectId = nextProject();
    const { result } = renderGate(server, projectId);
    await waitFor(() => expect(result.current?.status.kind).toBe('ready'));
    await act(async () => {
      await expect(result.current!.allow(ROUTE)).resolves.toBe(true);
    });
    const grant = result.current!.grant(ROUTE)!;
    expect(grant).not.toBeNull();
    expect(current(grant)).toBe(true);

    await otherTabStops(server, projectId, { saved: false });
    expect(current(grant)).toBe(false);
    await waitFor(() => expect(result.current!.permits(ROUTE)).toBe(false));
  });

  it('lets an Allow asked after the Stop through', async () => {
    const server = consentServer();
    const projectId = nextProject();
    const { result } = renderGate(server, projectId);
    await waitFor(() => expect(result.current?.status.kind).toBe('ready'));
    await otherTabStops(server, projectId);
    await act(async () => {
      await expect(result.current!.allow(ROUTE)).resolves.toBe(true);
    });
    const grant = result.current!.grant(ROUTE)!;
    expect(current(grant)).toBe(true);
    expect(server.rows.get(projectId)).toMatchObject({
      allowed: true,
      copyVersion: ASSISTANT_CONSENT_COPY_VERSION
    });
  });
});

describe('a Stop during the Allow’s post-save verification (round 12, 1)', () => {
  /**
   * The device log, with another tab's Stop landing at the moment the
   * Allow's answer is checked against it: after the save and the MAC
   * check, before the log decides.
   */
  function stopDuringVerification(projectId: string) {
    const log = deviceLog();
    let armed = false;
    const pins: ConsentPinStore = {
      ...log,
      observe(userId, project, sequence, allowed) {
        // The second Allow's answer (not the read before it).
        if (armed && allowed && sequence >= 2 && project === projectId) {
          armed = false;
          // Tab B's Stop; its own save fails (the account is unreachable).
          deviceLog().stop(USER, projectId);
        }
        return log.observe(userId, project, sequence, allowed);
      }
    };
    return { pins, arm: () => (armed = true) };
  }

  it('leaves no stored Allow a fresh read or the gate would use', async () => {
    const server = consentServer();
    const projectId = nextProject();
    const { pins, arm } = stopDuringVerification(projectId);
    const { result } = renderGate(server, projectId, pins);
    await waitFor(() => expect(result.current?.status.kind).toBe('ready'));
    // An Allow at sequence 1, accepted and granted.
    await act(async () => {
      await expect(result.current!.allow(ROUTE)).resolves.toBe(true);
    });
    expect(result.current!.grant(ROUTE)).toMatchObject({ sequence: 1 });

    // A second Allow (another route) is stored at sequence 2; the Stop
    // comes while its answer is verified.
    arm();
    await act(async () => {
      await expect(result.current!.allow(OTHER_ROUTE)).resolves.toBe(false);
    });
    expect(server.rows.get(projectId)).toMatchObject({
      allowed: true,
      sequence: 2
    });

    // Neither Allow is used on this device, however it is read.
    expect(result.current!.grant(ROUTE)).toBeNull();
    expect(result.current!.grant(OTHER_ROUTE)).toBeNull();
    expect(current(grantOf(projectId, 1))).toBe(false);
    expect(current(grantOf(projectId, 2))).toBe(false);
    const reread = await freshRead(server, projectId);
    expect(reread).toMatchObject({ kind: 'refused', reason: 'stopped' });
    expect(consentModule.consentPermits(reread, OTHER_ROUTE)).toBe(false);
    await act(async () => {
      await expect(result.current!.confirm(OTHER_ROUTE)).resolves.toEqual({
        kind: 'ask'
      });
    });
    expect(result.current!.grant(OTHER_ROUTE)).toBeNull();
  });
});

describe('re-observing the same Stop (round 12, 3)', () => {
  it('a delayed broadcast or storage event of an observed Stop changes nothing', async () => {
    const server = consentServer();
    const projectId = nextProject();
    // Tab B's Stop, persisted before tab A opens.
    const stop = deviceLog().stop(USER, projectId);
    const { result } = renderGate(server, projectId);
    await waitFor(() => expect(result.current?.status.kind).toBe('ready'));
    await act(async () => {
      await expect(result.current!.allow(ROUTE)).resolves.toBe(true);
    });
    const grant = result.current!.grant(ROUTE)!;
    expect(current(grant)).toBe(true);

    // The earlier Stop's broadcast arrives late, twice, with and without
    // its entry, and its storage event too.
    const otherTab = new BroadcastChannel(ASSISTANT_CONSENT_CHANNEL);
    try {
      otherTab.postMessage({ userId: USER, projectId });
      otherTab.postMessage({ userId: USER, projectId, unsaved: [stop] });
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: `${assistantConsentLogPrefix(USER, projectId)}${stop.id}`
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      otherTab.close();
    }
    expect(current(grant)).toBe(true);
    expect(result.current!.grant(ROUTE)).toEqual(grant);
  });
});

describe('a consent log storage refuses (round 12, 4)', () => {
  /** Storage that is full: new keys are refused, shorter rewrites fit. */
  function fillStorage() {
    faults.write = 'full';
  }

  /** Storage that refuses every write. */
  function refuseWrites() {
    faults.write = 'all';
  }

  it('latches a tab opened later closed when neither the Stop nor its save landed', async () => {
    const server = consentServer();
    const projectId = nextProject();
    const { result, unmount } = renderGate(server, projectId);
    await waitFor(() => expect(result.current?.status.kind).toBe('ready'));
    await act(async () => {
      await expect(result.current!.allow(ROUTE)).resolves.toBe(true);
    });
    const sequence = server.rows.get(projectId)!.sequence;

    fillStorage();
    server.before.save = async () => {
      throw new E2eeApiError(500, 'The account is unavailable.');
    };
    await act(async () => {
      await expect(result.current!.stop()).resolves.toBe(false);
    });
    expect(server.rows.get(projectId)).toMatchObject({ allowed: true });
    unmount();

    // A tab opened later: none of this one's memory, only what is stored.
    vi.resetModules();
    const fresh = await import('../e2ee/assistantConsent');
    const freshPins = await import('../e2ee/assistantConsentPins');
    expect(
      freshPins.assistantConsentCurrent(grantOf(projectId, sequence), storage)
    ).toBe(false);
    const reread = await fresh.loadAssistantConsent(
      {
        ...contextFor(server),
        pins: freshPins.localStorageConsentPins(storage)
      },
      projectId
    );
    expect(fresh.consentPermits(reread, ROUTE)).toBe(false);
  });

  it('stays latched until the user allows again with storage working', async () => {
    const server = consentServer();
    const projectId = nextProject();
    const { result } = renderGate(server, projectId);
    await waitFor(() => expect(result.current?.status.kind).toBe('ready'));
    await act(async () => {
      await expect(result.current!.allow(ROUTE)).resolves.toBe(true);
    });

    refuseWrites();
    server.before.save = async () => {
      throw new E2eeApiError(500, 'The account is unavailable.');
    };
    await act(async () => {
      await expect(result.current!.stop()).resolves.toBe(false);
    });
    server.before.save = async () => undefined;
    // The account still holds the Allow; this device does not use it.
    const reread = await freshRead(server, projectId);
    expect(reread).toMatchObject({ kind: 'refused', reason: 'unrecorded' });
    expect(reread.kind === 'refused' && reread.message).toBe(
      consentModule.ASSISTANT_CONSENT_UNRECORDED_MESSAGE
    );
    // Allow while storage still refuses: still latched, and it says why.
    await act(async () => {
      await expect(result.current!.allow(ROUTE)).resolves.toBe(false);
    });
    expect(result.current!.error).toBe(
      consentModule.ASSISTANT_CONSENT_UNRECORDED_MESSAGE
    );
    expect(result.current!.grant(ROUTE)).toBeNull();

    // Storage works again and the user allows: the latch lifts.
    faults.write = 'none';
    await act(async () => {
      await expect(result.current!.allow(ROUTE)).resolves.toBe(true);
    });
    expect(current(result.current!.grant(ROUTE)!)).toBe(true);
  });

  it('refuses every consent send while the log cannot be read', async () => {
    const projectId = nextProject();
    expect(deviceLog().observe(USER, projectId, 1, true)).toBe('accepted');
    expect(current(grantOf(projectId, 1))).toBe(true);
    faults.read = true;
    expect(current(grantOf(projectId, 1))).toBe(false);
  });

  it('informs tabs without a broadcast channel through the stored log', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.resetModules();
    const pinsModule = await import('../e2ee/assistantConsentPins');
    const projectId = nextProject();
    const log = pinsModule.localStorageConsentPins(storage);
    expect(log.observe(USER, projectId, 1, true)).toBe('accepted');
    const grant = grantOf(projectId, 1);
    expect(pinsModule.assistantConsentCurrent(grant, storage)).toBe(true);
    // Another tab's Stop, written to storage only.
    localStorageConsentPins(storage).stop(USER, projectId);
    expect(pinsModule.assistantConsentCurrent(grant, storage)).toBe(false);
  });
});
