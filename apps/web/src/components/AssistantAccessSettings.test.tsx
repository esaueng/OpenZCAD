import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeAssistantConsent,
  encodeAssistantConsent,
  fromBase64Url,
  macAssistantConsent,
  toBase64Url
} from '@openzcad/crypto';
import {
  ASSISTANT_CONSENT_COPY_VERSION,
  type E2eeAssistantConsentRecord,
  type E2eeSaveAssistantConsentRequest,
  type ProjectSummary
} from '@openzcad/shared';
import {
  memoryConsentPins,
  type AssistantConsentApi
} from '../lib/e2ee/assistantConsent';
import { E2eeApiError } from '../lib/e2ee/e2eeApi';
import { lockAccount, rememberUnlockedAccount } from '../lib/e2ee/unlockedKeys';
import { api as appApi } from '../lib/api';
import { assistantConsentRoute } from '../lib/assistant/consentCopy';
import { AssistantAccessSettings, routeWords } from './AssistantAccessSettings';
import { AssistantConsentSummary } from './assistant/AssistantConsentSummary';

const USER = 'user_alice';
const ACCOUNT_KEY = new Uint8Array(32).fill(5);
const ROUTE = assistantConsentRoute({
  source: 'deployment',
  provider: 'openrouter',
  model: 'test-model',
  endpoint: 'https://openrouter.ai/api/v1/responses'
});

describe('routeWords', () => {
  it('names the key, provider and model of a stored route', () => {
    expect(routeWords(ROUTE)).toBe('OpenZCAD’s key · openrouter · test-model');
    expect(
      routeWords(
        assistantConsentRoute({
          source: 'personal',
          provider: 'openai',
          model: 'gpt-5'
        })
      )
    ).toBe('Your key · openai · gpt-5');
    expect(routeWords('deployment|openrouter|test-model')).toBe(
      'Unknown provider'
    );
  });
});

function unlock() {
  rememberUnlockedAccount(USER, {
    generation: 1,
    commitment: '00',
    accountKey: ACCOUNT_KEY.slice(),
    encryptionPrivateKey: {} as CryptoKey
  });
}

afterEach(() => lockAccount(USER));

async function row(
  projectId: string,
  sequence: number,
  allowed = true,
  key = ACCOUNT_KEY
): Promise<E2eeAssistantConsentRecord> {
  const record = encodeAssistantConsent({
    userId: USER,
    projectId,
    allowed,
    copyVersion: ASSISTANT_CONSENT_COPY_VERSION,
    route: allowed ? ROUTE : '',
    sequence
  });
  return {
    projectId,
    record: toBase64Url(record),
    recordMac: toBase64Url(await macAssistantConsent(key, record)),
    allowed,
    copyVersion: ASSISTANT_CONSENT_COPY_VERSION,
    route: allowed ? ROUTE : '',
    sequence,
    updatedAt: '2026-10-24T00:00:00.000Z',
    revokedAt: allowed ? null : '2026-10-24T00:00:00.000Z'
  };
}

function fakeApi(initial: E2eeAssistantConsentRecord[]) {
  const rows = new Map(initial.map((entry) => [entry.projectId, entry]));
  const api: AssistantConsentApi = {
    list: vi.fn(async () => ({ consents: [...rows.values()] })),
    load: vi.fn(async (projectId: string) => ({
      consent: rows.get(projectId) ?? null
    })),
    save: vi.fn(
      async (projectId: string, request: E2eeSaveAssistantConsentRequest) => {
        const decoded = decodeAssistantConsent(fromBase64Url(request.record));
        const entry: E2eeAssistantConsentRecord = {
          projectId,
          ...request,
          allowed: decoded.allowed,
          copyVersion: decoded.copyVersion,
          route: decoded.route,
          sequence: decoded.sequence,
          updatedAt: '2026-10-24T01:00:00.000Z',
          revokedAt: decoded.allowed ? null : '2026-10-24T01:00:00.000Z'
        };
        rows.set(projectId, entry);
        return { consent: entry };
      }
    ),
    members: vi.fn(async () => ({
      consents: [
        { userId: USER, allowed: true, updatedAt: 'x' },
        { userId: 'user_bob', allowed: true, updatedAt: 'x' },
        { userId: 'user_carol', allowed: false, updatedAt: 'x' }
      ]
    }))
  };
  return { api, rows };
}

const listProjects = async () => ({
  projects: [
    { projectId: 'proj_a', name: 'Secret bracket' } as ProjectSummary,
    { projectId: 'proj_b', name: 'Forged one' } as ProjectSummary
  ]
});

describe('Settings › Encryption › Assistant access (ADR-024 6-1)', () => {
  it('asks nothing of the consent routes while encrypted projects are closed', async () => {
    unlock();
    const { api } = fakeApi([await row('proj_a', 3)]);
    const config = vi.fn(async () => ({
      enabled: true,
      projectsEnabled: false
    }));
    const { container } = render(
      <AssistantAccessSettings
        userId={USER}
        unlocked
        api={{ ...api, config }}
        pins={memoryConsentPins()}
        listProjects={listProjects}
      />
    );
    await waitFor(() => expect(config).toHaveBeenCalled());
    expect(api.list).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
  });

  it('lists verified consents by name and revokes with the next sequence', async () => {
    unlock();
    const user = userEvent.setup();
    const { api, rows } = fakeApi([
      await row('proj_a', 3),
      // The server cannot make a project look allowed: a wrong key's MAC.
      await row('proj_b', 1, true, new Uint8Array(32).fill(1))
    ]);
    render(
      <AssistantAccessSettings
        userId={USER}
        unlocked
        api={api}
        pins={memoryConsentPins()}
        listProjects={listProjects}
      />
    );
    expect(await screen.findByText('Secret bracket')).toBeTruthy();
    expect(screen.getByText(/did not verify with your keys/)).toBeTruthy();
    await user.click(
      screen.getByRole('button', {
        name: 'Revoke assistant access to Secret bracket'
      })
    );
    await waitFor(() =>
      expect(rows.get('proj_a')).toMatchObject({ allowed: false, sequence: 4 })
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('button', {
          name: 'Revoke assistant access to Secret bracket'
        })
      ).toBeNull()
    );
  });

  it('shows nothing when the account cannot store consent', async () => {
    unlock();
    const api: AssistantConsentApi = {
      list: vi.fn(async () => {
        throw new E2eeApiError(503, 'Not yet.');
      }),
      load: vi.fn(),
      save: vi.fn(),
      members: vi.fn()
    };
    const { container } = render(
      <AssistantAccessSettings
        userId={USER}
        unlocked
        api={api}
        pins={memoryConsentPins()}
        listProjects={listProjects}
      />
    );
    await waitFor(() => expect(api.list).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});

describe('the project properties row (ADR-024 6-1, M6)', () => {
  it('says who allowed it, verified for this account', async () => {
    const { api } = fakeApi([await row('proj_a', 2)]);
    render(
      <AssistantConsentSummary
        projectId="proj_a"
        userId={async () => USER}
        context={(_module, userId) => ({
          userId,
          accountKey: ACCOUNT_KEY,
          api,
          pins: memoryConsentPins()
        })}
      />
    );
    expect(
      await screen.findByText('Allowed by you · allowed by 1 other member')
    ).toBeTruthy();
  });

  it('does not trust a record the account key does not verify', async () => {
    const { api } = fakeApi([
      await row('proj_a', 2, true, new Uint8Array(32).fill(1))
    ]);
    render(
      <AssistantConsentSummary
        projectId="proj_a"
        userId={async () => USER}
        context={(_module, userId) => ({
          userId,
          accountKey: ACCOUNT_KEY,
          api,
          pins: memoryConsentPins()
        })}
      />
    );
    expect(await screen.findByText(/did not verify/)).toBeTruthy();
  });
});

describe('Settings › Encryption › Assistant access, once per mount', () => {
  it('reads the consents and the shelf once, not on every render', async () => {
    unlock();
    const { api } = fakeApi([await row('proj_a', 3)]);
    const shelf = vi
      .spyOn(appApi, 'listProjects')
      .mockImplementation(listProjects);
    try {
      render(
        <AssistantAccessSettings
          userId={USER}
          unlocked
          api={api}
          pins={memoryConsentPins()}
        />
      );
      expect(await screen.findByText('Secret bracket')).toBeTruthy();
      // Before the fix each render made a new default `listProjects`, so
      // the reload effect ran again after every answer, without end.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(api.list).toHaveBeenCalledTimes(1);
      expect(shelf).toHaveBeenCalledTimes(1);
    } finally {
      shelf.mockRestore();
    }
  });
});
