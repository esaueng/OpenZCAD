import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as KeysModule from '../../lib/e2ee/accountKeys';
import type * as PasskeysModule from '../../lib/e2ee/passkeys';
import type * as PreferencesModule from '../../lib/e2ee/projectPreferences';
import type * as MigrationsModule from '../../lib/e2ee/projectMigrations';
import type * as UnlockedKeysModule from '../../lib/e2ee/unlockedKeys';
import type {
  AccountView,
  E2eeContext,
  EncryptionState
} from '../../lib/e2ee/accountKeys';
import type { PasskeyPrf, PasskeySecret } from '../../lib/e2ee/passkeys';
import { E2eeApiError } from '../../lib/e2ee/e2eeApi';
import { testRun } from '../../test/encryptionRun';

const keys = vi.hoisted(() => ({
  setUpEncryption:
    vi.fn<
      (
        ctx: unknown,
        options: { recoverySecret: Uint8Array; label: string }
      ) => Promise<unknown>
    >(),
  addPasskey:
    vi.fn<
      (
        ctx: { passkeys?: PasskeyPrf },
        account: unknown,
        auth: unknown
      ) => Promise<unknown>
    >()
}));
const prf = vi.hoisted(() => vi.fn());
const preferences = vi.hoisted(() => ({
  config: vi.fn(),
  load: vi.fn(),
  save: vi.fn()
}));
const migration = vi.hoisted(() => ({
  refresh: vi.fn(),
  run: vi.fn(),
  state: {
    running: false,
    pausing: false,
    otherTab: false,
    projects: [] as { projectId: string; phase: string }[],
    error: null as string | null
  }
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
vi.mock('../../lib/e2ee/projectMigrations', async (original) => ({
  ...(await original<typeof MigrationsModule>()),
  pageMigrationController: () => ({
    getState: () => migration.state,
    refresh: migration.refresh,
    run: migration.run
  })
}));
vi.mock('../../lib/e2ee/unlockedKeys', async (original) => ({
  ...(await original<typeof UnlockedKeysModule>()),
  unlockedAccount: () => ({ accountKey: new Uint8Array(32) })
}));
const { SetupDialog, lastRecoveryGroup } = await import('./SetupDialog');
const { EncryptionFlowError, SETUP_OUTCOME_UNKNOWN } =
  await import('../../lib/e2ee/accountKeys');
const { PasskeyError, failedPasskeyEnrollment } =
  await import('../../lib/e2ee/passkeys');

const ready = {
  kind: 'ready',
  account: { userId: 'user_alice' } as AccountView
} as EncryptionState;

afterEach(() => {
  vi.clearAllMocks();
  migration.state.projects = [];
  migration.state.error = null;
});

function passkey(): PasskeySecret {
  return {
    targetId: 'pk_0123456789abcdef',
    secret: new Uint8Array(32).fill(7),
    enrollmentLabel: 'OpenZCAD encryption 0a1b2c3d4e5f'
  };
}

function open({
  create = vi.fn<() => Promise<PasskeySecret>>(),
  skipProjectsStep
}: {
  create?: ReturnType<typeof vi.fn<() => Promise<PasskeySecret>>>;
  skipProjectsStep?: boolean;
} = {}) {
  const onClose = vi.fn();
  const onComplete = vi.fn();
  const onEncryptExisting = vi.fn();
  render(
    <SetupDialog
      ctx={
        {
          userId: 'user_alice',
          passkeys: { create, get: vi.fn() }
        } as unknown as E2eeContext
      }
      busy={false}
      run={testRun()}
      userId="user_alice"
      onClose={onClose}
      onComplete={onComplete}
      onEncryptExisting={onEncryptExisting}
      skipProjectsStep={skipProjectsStep}
    />
  );
  return { onClose, onComplete, onEncryptExisting, create };
}

const savedBox = () =>
  screen.getByRole('checkbox', { name: /I saved my recovery key/ });
const shownKey = () => screen.getByLabelText('Recovery key').textContent ?? '';

describe('the setup dialog', () => {
  it('says what losing every way in costs on its first screen', async () => {
    prf.mockResolvedValue('supported');
    preferences.config.mockResolvedValue({ enabled: false });
    open();
    expect(
      await screen.findByRole('dialog', { name: 'Turn on encryption' })
    ).toHaveTextContent(/can’t be recovered, by you or by us/);
    expect(screen.getByRole('progressbar', { name: 'Step' })).toHaveAttribute(
      'aria-valuetext',
      'Step 1 of 2'
    );
  });

  it('shows and acknowledges the key before any passkey or key exists, then creates, sets up and enrolls in one click', async () => {
    prf.mockResolvedValue('supported');
    preferences.config.mockResolvedValue({ enabled: false });
    const made = passkey();
    const order: string[] = [];
    const create = vi.fn(async () => {
      order.push('create');
      return made;
    });
    keys.setUpEncryption.mockImplementation(async () => {
      order.push('setup');
      return ready;
    });
    keys.addPasskey.mockImplementation(async (ctx) => {
      order.push('enroll');
      // The credential created inside the click, never a second prompt.
      expect(await ctx.passkeys!.create()).toBe(made);
      return ready;
    });
    const { onClose, onComplete } = open({ create });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Continue with passkey' })
    );
    // Screen 2 first: nothing created or committed yet.
    await screen.findByRole('dialog', { name: 'Save your recovery key' });
    expect(order).toEqual([]);
    expect(screen.getByText(/may ask you to confirm twice/)).toBeVisible();
    const primary = screen.getByRole('button', {
      name: 'Create passkey and turn on encryption'
    });
    expect(primary).toBeDisabled();
    fireEvent.click(savedBox());
    // D2: with the passkey path, no part of the key is typed.
    expect(
      screen.queryByLabelText('Last group of your recovery key')
    ).toBeNull();
    expect(screen.getByLabelText('Recovery key')).not.toHaveTextContent('•');
    fireEvent.click(primary);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(order).toEqual(['create', 'setup', 'enroll']);
    expect(keys.addPasskey.mock.calls[0]![2]).toBe(
      keys.setUpEncryption.mock.calls[0]![1].recoverySecret
    );
    // The passkey's PRF secret does not outlive the flow.
    expect(made.secret.every((byte) => byte === 0)).toBe(true);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('with a recovery key only, commits nothing until the last group is typed back', async () => {
    prf.mockResolvedValue('supported');
    preferences.config.mockResolvedValue({ enabled: false });
    keys.setUpEncryption.mockResolvedValue(ready);
    const { onClose, create } = open();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Use a recovery key only' })
    );
    const shown = shownKey();
    const turnOn = screen.getByRole('button', { name: 'Turn on encryption' });
    expect(turnOn).toBeDisabled();
    fireEvent.click(savedBox());
    // The group asked for is hidden, so it is read from the saved copy.
    expect(screen.getByLabelText('Recovery key')).toHaveTextContent(/-••••$/);
    const field = screen.getByLabelText('Last group of your recovery key');
    fireEvent.change(field, { target: { value: 'ZZZZ' } });
    fireEvent.click(turnOn);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That does not match'
    );
    expect(keys.setUpEncryption).not.toHaveBeenCalled();
    fireEvent.change(field, {
      target: { value: ` ${lastRecoveryGroup(shown).toLowerCase()} ` }
    });
    fireEvent.click(turnOn);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(keys.setUpEncryption).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    expect(keys.addPasskey).not.toHaveBeenCalled();
  });

  it('offers only the recovery key where passkeys are unavailable', async () => {
    prf.mockResolvedValue('unsupported');
    preferences.config.mockResolvedValue({ enabled: false });
    keys.setUpEncryption.mockResolvedValue(ready);
    const { onClose } = open();
    await screen.findByRole('dialog', { name: 'Turn on encryption' });
    expect(
      screen.queryByRole('button', { name: 'Continue with passkey' })
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const shown = shownKey();
    fireEvent.click(savedBox());
    fireEvent.change(screen.getByLabelText('Last group of your recovery key'), {
      target: { value: lastRecoveryGroup(shown) }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on encryption' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(keys.addPasskey).not.toHaveBeenCalled();
  });

  it('falls back to the recovery key alone, with nothing committed, when the passkey prompt is cancelled', async () => {
    prf.mockResolvedValue('unknown');
    preferences.config.mockResolvedValue({ enabled: false });
    keys.setUpEncryption.mockResolvedValue(ready);
    const create = vi.fn(async (): Promise<PasskeySecret> => {
      throw new PasskeyError(
        'The passkey prompt was canceled or timed out. Try again or use your recovery key.'
      );
    });
    const { onClose } = open({ create });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Continue with passkey' })
    );
    const shown = shownKey();
    fireEvent.click(savedBox());
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Create passkey and turn on encryption'
      })
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      /No passkey was added\. The passkey prompt was canceled.*Go back to try again/
    );
    expect(keys.setUpEncryption).not.toHaveBeenCalled();
    // Now recovery key only: Back still works, and the last group is asked.
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Last group of your recovery key'), {
      target: { value: lastRecoveryGroup(shown) }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on encryption' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(keys.setUpEncryption).toHaveBeenCalledOnce();
    expect(keys.addPasskey).not.toHaveBeenCalled();
  });

  it('keeps the keys and asks for the last group when enrolling the passkey fails after setup', async () => {
    prf.mockResolvedValue('supported');
    preferences.config.mockResolvedValue({ enabled: false });
    const made = passkey();
    keys.setUpEncryption.mockResolvedValue(ready);
    keys.addPasskey.mockRejectedValue(
      failedPasskeyEnrollment(
        new EncryptionFlowError('invalid-request', 'Device list changed.'),
        made.enrollmentLabel!,
        made.targetId
      )
    );
    const { onClose, onComplete } = open({ create: vi.fn(async () => made) });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Continue with passkey' })
    );
    const shown = shownKey();
    fireEvent.click(savedBox());
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Create passkey and turn on encryption'
      })
    );
    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent(
      'No passkey was added. Device list changed.'
    );
    // The provider's orphaned credential is named for clean-up.
    expect(notice).toHaveTextContent(made.enrollmentLabel!);
    expect(notice).toHaveTextContent('Encryption is on with your recovery key');
    expect(made.secret.every((byte) => byte === 0)).toBe(true);
    // Keys exist: no going back, and Escape does not leave unconfirmed.
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    const proceed = screen.getByRole('button', { name: 'Continue' });
    expect(proceed).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Last group of your recovery key'), {
      target: { value: lastRecoveryGroup(shown) }
    });
    fireEvent.click(proceed);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onComplete).toHaveBeenCalledOnce();
    expect(keys.setUpEncryption).toHaveBeenCalledOnce();
  });

  it('never offers Cancel while a lost setup answer is unresolved, and retries with the same key and credential', async () => {
    prf.mockResolvedValue('supported');
    preferences.config.mockResolvedValue({ enabled: false });
    const made = passkey();
    const create = vi.fn(async () => made);
    keys.setUpEncryption
      .mockRejectedValueOnce(
        new EncryptionFlowError('setup-unknown', SETUP_OUTCOME_UNKNOWN)
      )
      .mockResolvedValueOnce(ready);
    keys.addPasskey.mockResolvedValue(ready);
    const { onClose } = open({ create });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Continue with passkey' })
    );
    fireEvent.click(savedBox());
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Create passkey and turn on encryption'
      })
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t tell whether encryption was turned on'
    );
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    // The key on screen is the one the retry sends.
    expect(screen.getByLabelText('Recovery key')).not.toHaveTextContent('•');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    const [first, second] = keys.setUpEncryption.mock.calls;
    expect(second![1].recoverySecret).toBe(first![1].recoverySecret);
    // Both attempts share one record, so the read-back knows either.
    expect((second![1] as { attempts?: unknown }).attempts).toBeDefined();
    expect((second![1] as { attempts?: unknown }).attempts).toBe(
      (first![1] as { attempts?: unknown }).attempts
    );
    // The credential made for the first try is reused, not made again.
    expect(create).toHaveBeenCalledOnce();
    expect(keys.addPasskey).toHaveBeenCalledOnce();
  });

  it('says plainly when another recovery key already holds the account', async () => {
    prf.mockResolvedValue('supported');
    preferences.config.mockResolvedValue({ enabled: false });
    keys.setUpEncryption.mockRejectedValue(
      new E2eeApiError(
        409,
        'Encryption keys are already set up.',
        'E2EE_ALREADY_SET_UP'
      )
    );
    const { onClose } = open();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Use a recovery key only' })
    );
    const shown = shownKey();
    fireEvent.click(savedBox());
    fireEvent.change(screen.getByLabelText('Last group of your recovery key'), {
      target: { value: lastRecoveryGroup(shown) }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on encryption' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'with a different recovery key'
    );
    expect(
      screen.queryByRole('button', { name: 'Turn on encryption' })
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('holds default-on migration while it is open', async () => {
    prf.mockResolvedValue('supported');
    preferences.config.mockResolvedValue({ enabled: false });
    const { setupInProgress } = await import('../../lib/e2ee/setupInProgress');
    const { unmount } = render(
      <SetupDialog
        ctx={{ userId: 'user_held' } as E2eeContext}
        busy={false}
        run={testRun()}
        userId="user_held"
        onClose={vi.fn()}
      />
    );
    expect(setupInProgress('user_held')).toBe(true);
    unmount();
    expect(setupInProgress('user_held')).toBe(false);
  });

  /** Recovery key only through to screen 3. */
  async function toProjects() {
    fireEvent.click(
      await screen.findByRole('button', { name: 'Use a recovery key only' })
    );
    const shown = shownKey();
    fireEvent.click(savedBox());
    fireEvent.change(screen.getByLabelText('Last group of your recovery key'), {
      target: { value: lastRecoveryGroup(shown) }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on encryption' }));
    await screen.findByRole('dialog', { name: 'You’re set' });
  }

  function migrationOpen(extra: Record<string, unknown> = {}) {
    prf.mockResolvedValue('supported');
    preferences.config.mockResolvedValue({
      enabled: true,
      projectsEnabled: true,
      migrationEnabled: true,
      ...extra
    });
    preferences.load.mockResolvedValue({ kind: 'unset', pinned: null });
    preferences.save.mockResolvedValue({
      kind: 'verified',
      encryptNewProjects: true,
      sequence: 1
    });
    keys.setUpEncryption.mockResolvedValue(ready);
    migration.run.mockResolvedValue(undefined);
  }

  it('ends with new and existing projects both ticked, and starts encrypting the existing ones only on Done', async () => {
    migrationOpen();
    migration.refresh.mockImplementation(async () => {
      migration.state.projects = [
        { projectId: 'proj_a', phase: 'waiting' },
        { projectId: 'proj_b', phase: 'waiting' },
        { projectId: 'proj_c', phase: 'done' }
      ];
    });
    const { onClose, onComplete, onEncryptExisting } = open();
    await toProjects();
    expect(
      screen.getByRole('checkbox', { name: /Encrypt new projects/ })
    ).toBeChecked();
    expect(
      await screen.findByRole('checkbox', {
        name: /Encrypt my 2 existing cloud projects/
      })
    ).toBeChecked();
    expect(migration.run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(onEncryptExisting).toHaveBeenCalledOnce());
    expect(preferences.save.mock.calls[0]![1]).toBe(true);
    expect(migration.run).toHaveBeenCalledWith(['proj_a', 'proj_b']);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('leaves existing projects alone when that box is unticked', async () => {
    migrationOpen();
    preferences.load.mockResolvedValue({
      kind: 'verified',
      encryptNewProjects: true,
      sequence: 1
    });
    migration.refresh.mockImplementation(async () => {
      migration.state.projects = [{ projectId: 'proj_a', phase: 'waiting' }];
    });
    const { onClose, onEncryptExisting } = open();
    await toProjects();
    fireEvent.click(
      await screen.findByRole('checkbox', {
        name: /Encrypt my 1 existing cloud project\b/
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(migration.run).not.toHaveBeenCalled();
    expect(onEncryptExisting).not.toHaveBeenCalled();
    expect(preferences.save).not.toHaveBeenCalled();
  });

  it('under default-on, encrypts existing projects on Done, not before', async () => {
    migrationOpen({ defaultOn: true });
    migration.refresh.mockImplementation(async () => {
      migration.state.projects = [{ projectId: 'proj_a', phase: 'waiting' }];
    });
    const { onEncryptExisting } = open();
    await toProjects();
    expect(
      await screen.findByText(/Done starts encrypting your 1 existing cloud/)
    ).toBeVisible();
    expect(migration.run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(onEncryptExisting).toHaveBeenCalledOnce());
    expect(migration.run).toHaveBeenCalledWith(['proj_a']);
    // The server decides for new projects; nothing is saved here.
    expect(preferences.save).not.toHaveBeenCalled();
  });

  it('says when the existing projects could not be counted, and retries', async () => {
    migrationOpen();
    migration.refresh
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(async () => {
        migration.state.projects = [{ projectId: 'proj_a', phase: 'waiting' }];
      });
    open();
    await toProjects();
    expect(
      await screen.findByText(/Couldn’t count your existing cloud projects/)
    ).toBeVisible();
    // Done still works: they can be encrypted later from Settings.
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByRole('checkbox', {
        name: /Encrypt my 1 existing cloud project\b/
      })
    ).toBeChecked();
  });

  it('lets a caller replace the projects step with its own', async () => {
    migrationOpen();
    keys.addPasskey.mockResolvedValue(ready);
    const { onClose, onComplete } = open({
      create: vi.fn(async () => passkey()),
      skipProjectsStep: true
    });
    await waitFor(() => expect(preferences.config).toHaveBeenCalled());
    fireEvent.click(
      await screen.findByRole('button', { name: 'Continue with passkey' })
    );
    expect(screen.getByRole('progressbar', { name: 'Step' })).toHaveAttribute(
      'aria-valuetext',
      'Step 2 of 2'
    );
    fireEvent.click(savedBox());
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Create passkey and turn on encryption'
      })
    );
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(onClose).toHaveBeenCalledOnce();
    expect(migration.refresh).not.toHaveBeenCalled();
  });

  it('stays open and says why when saving the choice fails', async () => {
    migrationOpen();
    preferences.save.mockRejectedValue(
      new EncryptionFlowError('invalid-request', 'The setting was not saved.')
    );
    migration.refresh.mockImplementation(async () => {
      migration.state.projects = [{ projectId: 'proj_a', phase: 'waiting' }];
    });
    const { onClose, onComplete, onEncryptExisting } = open();
    await toProjects();
    await screen.findByRole('checkbox', { name: /Encrypt my 1 existing/ });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The setting was not saved.'
    );
    expect(migration.run).not.toHaveBeenCalled();
    expect(onEncryptExisting).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('lastRecoveryGroup', () => {
  it('is the final group of four', () => {
    expect(lastRecoveryGroup('ABCD-EFGH-JK01')).toBe('JK01');
  });
});
