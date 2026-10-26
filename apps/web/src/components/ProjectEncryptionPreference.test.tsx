import {
  act,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  E2eeSaveProjectPreferenceRequest
} from '@openzcad/shared';
import {
  loadProjectPreference,
  memoryPreferencePins,
  saveProjectPreference,
  type PreferencePinStore,
  type ProjectPreferenceApi
} from '../lib/e2ee/projectPreferences';
import { lockAccount, rememberUnlockedAccount } from '../lib/e2ee/unlockedKeys';
import { ProjectEncryptionPreference } from './ProjectEncryptionPreference';

const USER = 'user_alice';
const ACCOUNT_KEY = new Uint8Array(32).fill(9);

function unlock() {
  rememberUnlockedAccount(USER, {
    generation: 1,
    commitment: '00',
    accountKey: ACCOUNT_KEY.slice(),
    encryptionPrivateKey: {} as CryptoKey
  });
}

afterEach(() => lockAccount(USER));

async function stored(
  sequence: number,
  encryptNewProjects: boolean,
  key = ACCOUNT_KEY
): Promise<E2eeProjectPreferenceRecord> {
  const record = encodeProjectPreferences({
    userId: USER,
    encryptNewProjects,
    sequence
  });
  return {
    record: toBase64Url(record),
    recordMac: toBase64Url(await macProjectPreferences(key, record)),
    encryptNewProjects,
    sequence,
    updatedAt: '2026-10-24T00:00:00.000Z'
  };
}

/** The Worker's behavior, in memory: forward-moving writes only. */
function fakeApi(
  config: E2eeConfigResponse,
  initial: E2eeProjectPreferenceRecord | null = null
) {
  let current = initial;
  const api: ProjectPreferenceApi = {
    config: vi.fn(async () => config),
    load: vi.fn(async () => ({ preference: current })),
    save: vi.fn(async (request: E2eeSaveProjectPreferenceRequest) => {
      const record = await openProjectPreferences(
        ACCOUNT_KEY,
        fromBase64Url(request.record),
        fromBase64Url(request.recordMac)
      );
      if (current && record.sequence <= current.sequence) {
        throw new Error('stale');
      }
      current = {
        ...request,
        encryptNewProjects: record.encryptNewProjects,
        sequence: record.sequence,
        updatedAt: 'now'
      };
      return { preference: current };
    })
  };
  return { api, current: () => current };
}

const OPEN = { enabled: true, projectsEnabled: true };

function renderToggle(
  api: ProjectPreferenceApi,
  pins: PreferencePinStore = memoryPreferencePins(),
  unlocked = true
) {
  return render(
    <ProjectEncryptionPreference
      userId={USER}
      unlocked={unlocked}
      api={api}
      pins={pins}
    />
  );
}

describe('Settings › Encryption › Encrypt new projects (ADR-024 D2)', () => {
  it('lets required encryption repair an untrusted preference with a fresh true-only record', async () => {
    unlock();
    const { api, current } = fakeApi(
      { ...OPEN, defaultOn: true },
      await stored(7, false, new Uint8Array(32).fill(1))
    );
    renderToggle(api);
    const confirm = await screen.findByRole('button', {
      name: 'Confirm encryption'
    });
    expect(
      screen.getByRole('checkbox', { name: 'Encrypt new projects' })
    ).toBeDisabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(current()?.sequence).toBe(8));
    expect(current()?.encryptNewProjects).toBe(true);
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Confirm encryption' })
      ).toBeNull()
    );
  });

  it.each(['unset', 'off'] as const)(
    'shows required encryption instead of an opt-out for an %s beta preference',
    async (preference) => {
      unlock();
      const { api } = fakeApi(
        { ...OPEN, defaultOn: true },
        preference === 'unset' ? null : await stored(4, false)
      );
      renderToggle(api);
      const toggle = await screen.findByRole('checkbox', {
        name: 'Encrypt new projects'
      });
      await waitFor(() => expect(toggle).toBeChecked());
      expect(toggle).toBeDisabled();
      expect(
        screen.getByText(
          'Encryption is required for new cloud projects on this server.'
        )
      ).toBeTruthy();
      fireEvent.click(toggle);
      expect(api.save).not.toHaveBeenCalled();
    }
  );

  it('is hidden while encrypted projects are off for the account', async () => {
    unlock();
    const { api } = fakeApi({ enabled: true, projectsEnabled: false });
    renderToggle(api);
    await waitFor(() => expect(api.config).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText('Encrypt new projects')).toBeNull();
    expect(api.load).not.toHaveBeenCalled();
  });

  it('is hidden until keys are set up and unlocked on this device', async () => {
    const { api } = fakeApi(OPEN);
    renderToggle(api, memoryPreferencePins(), false);
    await act(async () => {});
    expect(screen.queryByText('Encrypt new projects')).toBeNull();
    // Unlocked in the view, but no account key on this device.
    renderToggle(api, memoryPreferencePins(), true);
    await act(async () => {});
    expect(screen.queryByText('Encrypt new projects')).toBeNull();
  });

  it('shows a verified record and writes the next one, MAC’d and pinned', async () => {
    unlock();
    const { api, current } = fakeApi(OPEN, await stored(4, false));
    const pins = memoryPreferencePins();
    renderToggle(api, pins);
    const toggle = await screen.findByRole('checkbox', {
      name: 'Encrypt new projects'
    });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).not.toBeChecked();
    expect(await pins.read(USER)).toBe(4);
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(current()).toMatchObject({ sequence: 5, encryptNewProjects: true });
    expect(await pins.read(USER)).toBe(5);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refuses a record whose MAC does not verify, and shows it as unknown', async () => {
    unlock();
    const forged = await stored(7, false, new Uint8Array(32).fill(1));
    const { api, current } = fakeApi(OPEN, forged);
    renderToggle(api);
    expect(
      await screen.findByText(/did not verify with your keys/)
    ).toBeTruthy();
    const toggle = screen.getByRole('checkbox', {
      name: 'Encrypt new projects'
    });
    expect(toggle).not.toBeChecked();
    // Choosing again replaces it with a record past the server's sequence.
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(current()?.sequence).toBe(8);
  });

  it('refuses a rollback below this device’s pin', async () => {
    unlock();
    const pins = memoryPreferencePins();
    await pins.write(USER, 6);
    const { api } = fakeApi(OPEN, await stored(3, true));
    renderToggle(api, pins);
    expect(await screen.findByText(/older copy of this setting/)).toBeTruthy();
    expect(
      screen.getByRole('checkbox', { name: 'Encrypt new projects' })
    ).not.toBeChecked();
    expect(await pins.read(USER)).toBe(6);
  });
});

describe('project preference records in the browser', () => {
  const ctx = (api: ProjectPreferenceApi, pins = memoryPreferencePins()) => ({
    userId: USER,
    accountKey: ACCOUNT_KEY,
    api,
    pins
  });

  it('treats a withdrawn record this device has seen as a rollback', async () => {
    const pins = memoryPreferencePins();
    await pins.write(USER, 2);
    const { api } = fakeApi(OPEN, null);
    await expect(loadProjectPreference(ctx(api, pins))).resolves.toMatchObject({
      kind: 'refused',
      reason: 'rollback',
      floor: 2
    });
    const fresh = fakeApi(OPEN, null);
    await expect(loadProjectPreference(ctx(fresh.api))).resolves.toEqual({
      kind: 'unset',
      pinned: null
    });
  });

  it('refuses a record for another account or whose columns disagree', async () => {
    const other = encodeProjectPreferences({
      userId: 'user_mallory',
      encryptNewProjects: true,
      sequence: 1
    });
    const { api } = fakeApi(OPEN, {
      record: toBase64Url(other),
      recordMac: toBase64Url(await macProjectPreferences(ACCOUNT_KEY, other)),
      encryptNewProjects: true,
      sequence: 1,
      updatedAt: 'now'
    });
    await expect(loadProjectPreference(ctx(api))).resolves.toMatchObject({
      kind: 'refused',
      reason: 'unverified'
    });
    const mismatched = {
      ...(await stored(2, false)),
      encryptNewProjects: true
    };
    const second = fakeApi(OPEN, mismatched);
    await expect(loadProjectPreference(ctx(second.api))).resolves.toMatchObject(
      { kind: 'refused', reason: 'unverified' }
    );
  });

  it('never writes a sequence at or below the pin', async () => {
    const pins = memoryPreferencePins();
    await pins.write(USER, 9);
    const { api, current } = fakeApi(OPEN, await stored(2, false));
    await saveProjectPreference(ctx(api, pins), true, 2);
    expect(current()?.sequence).toBe(10);
  });
});
