import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as KeysModule from '../../lib/e2ee/accountKeys';
import type * as PasskeysModule from '../../lib/e2ee/passkeys';
import type * as PreferencesModule from '../../lib/e2ee/projectPreferences';
import type {
  AccountView,
  E2eeContext,
  EncryptionState
} from '../../lib/e2ee/accountKeys';
import { testRun } from '../../test/encryptionRun';

const keys = vi.hoisted(() => ({
  setUpEncryption: vi.fn(),
  addPasskey: vi.fn()
}));
const prf = vi.hoisted(() => vi.fn());
const preferences = vi.hoisted(() => ({
  config: vi.fn(),
  load: vi.fn(),
  save: vi.fn()
}));
vi.mock('../../lib/e2ee/accountKeys', async (original) => ({
  ...(await original<typeof KeysModule>()),
  ...keys
}));
vi.mock('../../lib/e2ee/passkeys', async (original) => ({
  ...(await original<typeof PasskeysModule>()),
  passkeyPrfSupport: prf
}));
vi.mock('../../lib/e2ee/projectPreferences', async (original) => ({
  ...(await original<typeof PreferencesModule>()),
  createProjectPreferenceApi: () => ({ config: preferences.config }),
  loadProjectPreference: preferences.load,
  saveProjectPreference: preferences.save
}));
vi.mock('../../lib/e2ee/unlockedKeys', async (original) => ({
  ...(await original<typeof import('../../lib/e2ee/unlockedKeys')>()),
  unlockedAccount: () => ({ accountKey: new Uint8Array(32) })
}));
const { SetupDialog } = await import('./SetupDialog');

const ready = {
  kind: 'ready',
  account: { userId: 'user_alice' } as AccountView
} as EncryptionState;

afterEach(() => {
  vi.clearAllMocks();
});

function open() {
  const onClose = vi.fn();
  render(
    <SetupDialog
      ctx={{ userId: 'user_alice' } as E2eeContext}
      busy={false}
      run={testRun()}
      userId="user_alice"
      onClose={onClose}
      onEncryptExisting={vi.fn()}
    />
  );
  return { onClose };
}

async function throughConfirm() {
  fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
  const shown = screen.getByLabelText('Recovery key').textContent!;
  const continueButton = screen.getByRole('button', { name: 'Continue' });
  // The acknowledgement comes first (design review I80).
  expect(continueButton).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(continueButton);
  return shown;
}

describe('the setup dialog', () => {
  it('says what losing every way in costs before anything else', async () => {
    prf.mockResolvedValue('supported');
    preferences.config.mockResolvedValue({ enabled: false });
    open();
    expect(
      await screen.findByText(/can’t be recovered, by you or by us/)
    ).toBeVisible();
  });

  it('turns encryption on only once the key is typed back exactly', async () => {
    prf.mockResolvedValue('supported');
    preferences.config.mockResolvedValue({ enabled: false });
    keys.setUpEncryption.mockResolvedValue(ready);
    open();
    const shown = await throughConfirm();
    const field = screen.getByLabelText('Confirm recovery key');
    fireEvent.change(field, { target: { value: 'ABCD-EFGH' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on encryption' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That does not match'
    );
    expect(keys.setUpEncryption).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: shown.toLowerCase() } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on encryption' }));
    await screen.findByRole('dialog', { name: 'Add a passkey' });
    expect(keys.setUpEncryption).toHaveBeenCalledOnce();
  });

  it('adds a passkey with the key already in hand, then encrypts new projects by default', async () => {
    prf.mockResolvedValue('unknown');
    preferences.config.mockResolvedValue({
      enabled: true,
      projectsEnabled: true
    });
    preferences.load.mockResolvedValue({ kind: 'unset', pinned: null });
    preferences.save.mockResolvedValue({
      kind: 'verified',
      encryptNewProjects: true,
      sequence: 1
    });
    keys.setUpEncryption.mockResolvedValue(ready);
    keys.addPasskey.mockResolvedValue(ready);
    const { onClose } = open();
    const shown = await throughConfirm();
    fireEvent.change(screen.getByLabelText('Confirm recovery key'), {
      target: { value: shown }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on encryption' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add passkey' }));
    await screen.findByRole('dialog', { name: 'Your projects' });
    // The same recovery secret setup used, never typed a second time.
    expect(keys.addPasskey.mock.calls[0]![2]).toBe(
      keys.setUpEncryption.mock.calls[0]![1].recoverySecret
    );
    expect(
      screen.getByRole('checkbox', { name: /Encrypt new projects/ })
    ).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(preferences.save.mock.calls[0]![1]).toBe(true);
  });

  it('never offers a passkey where the browser says PRF is unsupported', async () => {
    prf.mockResolvedValue('unsupported');
    preferences.config.mockResolvedValue({ enabled: false });
    keys.setUpEncryption.mockResolvedValue(ready);
    const { onClose } = open();
    await waitFor(() => expect(prf).toHaveBeenCalled());
    const shown = await throughConfirm();
    expect(screen.getByRole('progressbar', { name: 'Step' })).toHaveAttribute(
      'aria-valuetext',
      'Step 3 of 3'
    );
    fireEvent.change(screen.getByLabelText('Confirm recovery key'), {
      target: { value: shown }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on encryption' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(keys.addPasskey).not.toHaveBeenCalled();
  });
});
