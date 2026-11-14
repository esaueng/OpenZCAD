/**
 * Review round 11 of PR #1418: a Stop must outrank an Allow that was in
 * flight when it came, in any tab, and a Stop that storage refused to
 * record must still refuse every grant on this device.
 *
 * - An Allow reads this device's stop generation before its first await,
 *   and is refused if a Stop came before its save, before its answer is
 *   accepted, or before its request is sent.
 * - A revocation or Stop storage refuses is held in this tab's memory and
 *   told to this device's other tabs.
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
  assistantConsentPinKey,
  assistantConsentRevokedKey,
  assistantConsentStopsKey,
  assistantStopGeneration,
  localStorageConsentPins,
  revokeKnownAssistantConsent
} from '../e2ee/assistantConsentPins';
import { E2eeApiError } from '../e2ee/e2eeApi';
import { useAssistantConsentGate } from './consentGate';

const USER = 'user_stops';
const ROUTE = 'deployment:openrouter:test-model';
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

const contextFor = (server: Server): consentModule.AssistantConsentContext => ({
  userId: USER,
  accountKey: ACCOUNT_KEY,
  api: server.api,
  pins: localStorageConsentPins(window.localStorage)
});

function renderGate(server: Server, projectId: string) {
  return renderHook(() =>
    useAssistantConsentGate(
      USER,
      { projectId: toProjectId(projectId), storageFormat: 2 },
      {
        loadModule: async () => consentModule,
        context: () => contextFor(server)
      }
    )
  );
}

/**
 * Another tab's Stop, as this tab sees it: storage only (that tab's own
 * memory is not this one's), then its revocation saved to the account
 * unless `saved` is false (its read or save failed).
 */
async function otherTabStops(
  server: Server,
  projectId: string,
  { saved = true }: { saved?: boolean } = {}
) {
  const key = assistantConsentStopsKey(USER, projectId);
  window.localStorage.setItem(
    key,
    String(Number(window.localStorage.getItem(key) ?? 0) + 1)
  );
  const pinned = window.localStorage.getItem(
    assistantConsentPinKey(USER, projectId)
  );
  if (pinned) {
    window.localStorage.setItem(
      assistantConsentRevokedKey(USER, projectId),
      pinned
    );
  }
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
      floor
    );
  } finally {
    Object.assign(server.before, before);
  }
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
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
    const state = await consentModule.loadAssistantConsent(
      contextFor(server),
      projectId
    );
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
    // B's Stop lands in storage before A accepts the answer, and B's own
    // save never reaches the account (its read failed).
    await otherTabStops(server, projectId, { saved: false });
    answer.release();
    await act(async () => {
      await expect(allowing).resolves.toBe(false);
    });

    expect(result.current!.grant(ROUTE)).toBeNull();
    // The Allow the account stored is never used on this device.
    const reread = await consentModule.loadAssistantConsent(
      contextFor(server),
      projectId
    );
    expect(consentModule.consentPermits(reread, ROUTE)).toBe(false);
    expect(
      assistantConsentCurrent({
        userId: USER,
        projectId,
        sequence: allowSequence,
        stops: assistantStopGeneration(USER, projectId)
      })
    ).toBe(false);
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
    expect(assistantConsentCurrent(grant)).toBe(true);

    // Another tab's Stop moved only the stop generation (its revocation
    // read an older pin): the grant is still refused.
    const key = assistantConsentStopsKey(USER, projectId);
    window.localStorage.setItem(key, '1');
    expect(assistantConsentCurrent(grant)).toBe(false);
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
    expect(assistantConsentCurrent(grant)).toBe(true);
    expect(server.rows.get(projectId)).toMatchObject({
      allowed: true,
      copyVersion: ASSISTANT_CONSENT_COPY_VERSION
    });
  });
});

describe('a Stop whose revocation storage refuses', () => {
  /** Storage that reads, but refuses every consent revocation and Stop. */
  function refuseRevocationWrites() {
    const original = window.localStorage.setItem.bind(window.localStorage);
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(
      (key, value) => {
        if (key.includes('consent-revoked') || key.includes('consent-stops')) {
          throw new DOMException('Quota exceeded', 'QuotaExceededError');
        }
        original(key, value);
      }
    );
  }

  it('latches this tab’s sends closed though nothing was saved', async () => {
    const server = consentServer();
    const projectId = nextProject();
    const { result } = renderGate(server, projectId);
    await waitFor(() => expect(result.current?.status.kind).toBe('ready'));
    await act(async () => {
      await expect(result.current!.allow(ROUTE)).resolves.toBe(true);
    });
    const sequence = server.rows.get(projectId)!.sequence;

    refuseRevocationWrites();
    server.before.save = async () => {
      throw new E2eeApiError(500, 'The account is unavailable.');
    };
    await act(async () => {
      await expect(result.current!.stop()).resolves.toBe(false);
    });
    // Neither storage nor the account holds the revocation.
    expect(
      window.localStorage.getItem(assistantConsentRevokedKey(USER, projectId))
    ).toBeNull();
    expect(server.rows.get(projectId)).toMatchObject({ allowed: true });

    // A grant of the account's still-stored Allow, read now: refused.
    expect(
      assistantConsentCurrent({
        userId: USER,
        projectId,
        sequence,
        stops: assistantStopGeneration(USER, projectId)
      })
    ).toBe(false);
    // And a fresh read refuses it as superseded.
    const reread = await consentModule.loadAssistantConsent(
      contextFor(server),
      projectId
    );
    expect(consentModule.consentPermits(reread, ROUTE)).toBe(false);
  });

  it('tells this device’s other tabs, whose grants are then refused', async () => {
    const projectId = nextProject();
    const heard: unknown[] = [];
    const otherTab = new BroadcastChannel(ASSISTANT_CONSENT_CHANNEL);
    otherTab.onmessage = (event: MessageEvent) => heard.push(event.data);
    try {
      window.localStorage.setItem(assistantConsentPinKey(USER, projectId), '4');
      refuseRevocationWrites();
      revokeKnownAssistantConsent(USER, projectId);
      await waitFor(() =>
        expect(heard).toContainEqual({
          kind: 'stop',
          userId: USER,
          projectId,
          revoked: 4
        })
      );
    } finally {
      otherTab.close();
    }
  });

  it('refuses this tab’s grant when another tab says it stopped', async () => {
    const projectId = nextProject();
    window.localStorage.setItem(assistantConsentPinKey(USER, projectId), '2');
    const grant = {
      userId: USER,
      projectId,
      sequence: 2,
      stops: assistantStopGeneration(USER, projectId)
    };
    expect(assistantConsentCurrent(grant)).toBe(true);
    // The other tab's storage refused its Stop; only the channel carries it.
    const otherTab = new BroadcastChannel(ASSISTANT_CONSENT_CHANNEL);
    try {
      otherTab.postMessage({
        kind: 'stop',
        userId: USER,
        projectId,
        revoked: 2
      });
      await waitFor(() => expect(assistantConsentCurrent(grant)).toBe(false));
      // Even a grant read after it: the revocation is held here.
      expect(
        assistantConsentCurrent({
          ...grant,
          stops: assistantStopGeneration(USER, projectId)
        })
      ).toBe(false);
    } finally {
      otherTab.close();
    }
  });
});
