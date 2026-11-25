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
const { EncryptionFlowError } = await import('../../lib/e2ee/accountKeys');
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

/** Screen 2 without a passkey: ticked, then the last group typed back. */
async function confirmByLastGroup(shown: string) {
  fireEvent.click(
    screen.getByRole('checkbox', { name: /I saved my recovery key/ })
  );
  // The group asked for is hidden, so it is read from the saved copy.
  expect(screen.getByLabelText('Recovery key')).toHaveTextContent(/-••••$/);
  fireEvent.change(screen.getByLabelText('Last group of your recovery key'), {
    target: { value: lastRecoveryGroup(shown).toLowerCase() }
  });
}

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

  it('makes the passkey first, then sets up and enrolls it with the same in-memory key, and asks for no retype', async () => {
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
    await screen.findByRole('dialog', { name: 'Save your recovery key' });
    expect(order).toEqual(['create', 'setup', 'enroll']);
    expect(keys.addPasskey.mock.calls[0]![2]).toBe(
      keys.setUpEncryption.mock.calls[0]![1].recoverySecret
    );
    // The passkey's PRF secret does not outlive the flow.
    expect(made.secret.every((byte) => byte === 0)).toBe(true);
    expect(screen.getByText('Your passkey is ready.')).toBeVisible();
    // D2: with a passkey made in setup, no part of the key is typed.
    expect(
      screen.queryByLabelText('Last group of your recovery key')
    ).toBeNull();
    const proceed = screen.getByRole('button', { name: 'Continue' });
    expect(proceed).toBeDisabled();
    // Keys exist now: no going back, and Escape does not leave the key unsaved.
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('checkbox', { name: /I saved my recovery key/ })
    );
    expect(screen.getByLabelText('Recovery key')).not.toHaveTextContent('•');
    fireEvent.click(proceed);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onComplete).toHaveBeenCalledOnce();
    expect(keys.setUpEncryption).toHaveBeenCalledOnce();
  });

  it('with a recovery key only, commits nothing until the last group is typed back', async () => {
    prf.mockResolvedValue('supported');
    preferences.config.mockResolvedValue({ enabled: false });
    keys.setUpEncryption.mockResolvedValue(ready);
    const { onClose, create } = open();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Use a recovery key only' })
    );
    const shown = screen.getByLabelText('Recovery key').textContent ?? '';
    const turnOn = screen.getByRole('button', { name: 'Turn on encryption' });
    expect(turnOn).toBeDisabled();
    fireEvent.click(
      screen.getByRole('checkbox', { name: /I saved my recovery key/ })
    );
    const field = screen.getByLabelText('Last group of your recovery key');
    fireEvent.change(field, { target: { value: 'ZZZZ' } });
    fireEvent.click(turnOn);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That does not match'
    );
    expect(keys.setUpEncryption).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Recovery key')).toHaveTextContent(/-••••$/);
    fireEvent.change(field, {
      target: { value: ` ${lastRecoveryGroup(shown).toLowerCase()} ` }
    });
    fireEvent.click(turnOn);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(keys.setUpEncryption).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    expect(keys.addPasskey).not.toHaveBeenCalled();
  });

  it('offers only the recovery key where passkeys are unavailable, and asks for the last group', async () => {
    prf.mockResolvedValue('unsupported');
    preferences.config.mockResolvedValue({ enabled: false });
    keys.setUpEncryption.mockResolvedValue(ready);
    const { onClose } = open();
    await screen.findByRole('dialog', { name: 'Turn on encryption' });
    expect(
      screen.queryByRole('button', { name: 'Continue with passkey' })
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Use a recovery key only' })
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const shown = screen.getByLabelText('Recovery key').textContent ?? '';
    await confirmByLastGroup(shown);
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
    await screen.findByRole('dialog', { name: 'Save your recovery key' });
    expect(screen.getByRole('status')).toHaveTextContent(
      /No passkey was added\. The passkey prompt was canceled.*Go back to try again/
    );
    expect(keys.setUpEncryption).not.toHaveBeenCalled();
    // Still uncommitted: Back and Escape both leave with nothing set up.
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled();
    const shown = screen.getByLabelText('Recovery key').textContent ?? '';
    await confirmByLastGroup(shown);
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
    await screen.findByRole('dialog', { name: 'Save your recovery key' });
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent(
      'No passkey was added. Device list changed.'
    );
    // The provider's orphaned credential is named for clean-up.
    expect(notice).toHaveTextContent(made.enrollmentLabel!);
    expect(notice).toHaveTextContent('Encryption is on with your recovery key');
    expect(made.secret.every((byte) => byte === 0)).toBe(true);
    // Keys exist: confirmed like a recovery-key-only setup, never re-run.
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    const shown = screen.getByLabelText('Recovery key').textContent ?? '';
    fireEvent.click(
      screen.getByRole('checkbox', { name: /I saved my recovery key/ })
    );
    const proceed = screen.getByRole('button', { name: 'Continue' });
    expect(proceed).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Last group of your recovery key'), {
      target: { value: lastRecoveryGroup(shown) }
    });
    expect(screen.getByLabelText('Recovery key')).toHaveTextContent(/-••••$/);
    fireEvent.click(proceed);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onComplete).toHaveBeenCalledOnce();
    expect(keys.setUpEncryption).toHaveBeenCalledOnce();
  });

  it('names the new passkey to delete when setup itself fails after creating it', async () => {
    prf.mockResolvedValue('supported');
    preferences.config.mockResolvedValue({ enabled: false });
    const made = passkey();
    keys.setUpEncryption.mockRejectedValue(
      new EncryptionFlowError('invalid-request', 'Setup was refused.')
    );
    const { onClose } = open({ create: vi.fn(async () => made) });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Continue with passkey' })
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Setup was refused.'
    );
    await screen.findByRole('dialog', { name: 'Turn on encryption' });
    expect(keys.addPasskey).not.toHaveBeenCalled();
    expect(made.secret.every((byte) => byte === 0)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('ends with new and existing projects both ticked, and starts encrypting the existing ones', async () => {
    prf.mockResolvedValue('supported');
    preferences.config.mockResolvedValue({
      enabled: true,
      projectsEnabled: true,
      migrationEnabled: true
    });
    preferences.load.mockResolvedValue({ kind: 'unset', pinned: null });
    preferences.save.mockResolvedValue({
      kind: 'verified',
      encryptNewProjects: true,
      sequence: 1
    });
    migration.refresh.mockImplementation(async () => {
      migration.state.projects = [
        { projectId: 'proj_a', phase: 'waiting' },
        { projectId: 'proj_b', phase: 'waiting' },
        { projectId: 'proj_c', phase: 'done' }
      ];
    });
    migration.run.mockResolvedValue(undefined);
    keys.setUpEncryption.mockResolvedValue(ready);
    keys.addPasskey.mockResolvedValue(ready);
    const { onClose, onComplete, onEncryptExisting } = open({
      create: vi.fn(async () => passkey())
    });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Continue with passkey' })
    );
    fireEvent.click(
      await screen.findByRole('checkbox', { name: /I saved my recovery key/ })
    );
    expect(screen.getByRole('progressbar', { name: 'Step' })).toHaveAttribute(
      'aria-valuetext',
      'Step 2 of 3'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('dialog', { name: 'You’re set' });
    expect(
      screen.getByRole('checkbox', { name: /Encrypt new projects/ })
    ).toBeChecked();
    expect(
      await screen.findByRole('checkbox', {
        name: /Encrypt my 2 existing cloud projects/
      })
    ).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(onEncryptExisting).toHaveBeenCalledOnce());
    expect(preferences.save.mock.calls[0]![1]).toBe(true);
    expect(migration.run).toHaveBeenCalledWith(['proj_a', 'proj_b']);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('leaves existing projects alone when that box is unticked', async () => {
    prf.mockResolvedValue('unsupported');
    preferences.config.mockResolvedValue({
      enabled: true,
      projectsEnabled: true,
      migrationEnabled: true
    });
    preferences.load.mockResolvedValue({
      kind: 'verified',
      encryptNewProjects: true,
      sequence: 1
    });
    migration.refresh.mockImplementation(async () => {
      migration.state.projects = [{ projectId: 'proj_a', phase: 'waiting' }];
    });
    keys.setUpEncryption.mockResolvedValue(ready);
    const { onClose, onEncryptExisting } = open();
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    const shown = screen.getByLabelText('Recovery key').textContent ?? '';
    await confirmByLastGroup(shown);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on encryption' }));
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

  it('lets a caller replace the projects step with its own', async () => {
    prf.mockResolvedValue('supported');
    preferences.config.mockResolvedValue({
      enabled: true,
      projectsEnabled: true,
      migrationEnabled: true
    });
    keys.setUpEncryption.mockResolvedValue(ready);
    keys.addPasskey.mockResolvedValue(ready);
    const { onClose, onComplete } = open({
      create: vi.fn(async () => passkey()),
      skipProjectsStep: true
    });
    await waitFor(() => expect(preferences.config).toHaveBeenCalled());
    fireEvent.click(
      await screen.findByRole('button', { name: 'Continue with passkey' })
    );
    fireEvent.click(
      await screen.findByRole('checkbox', { name: /I saved my recovery key/ })
    );
    expect(screen.getByRole('progressbar', { name: 'Step' })).toHaveAttribute(
      'aria-valuetext',
      'Step 2 of 2'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(onClose).toHaveBeenCalledOnce();
    expect(migration.refresh).not.toHaveBeenCalled();
  });

  it('stays open and says why when saving the choice fails', async () => {
    prf.mockResolvedValue('unsupported');
    preferences.config.mockResolvedValue({
      enabled: true,
      projectsEnabled: true,
      migrationEnabled: true
    });
    preferences.load.mockResolvedValue({ kind: 'unset', pinned: null });
    preferences.save.mockRejectedValue(
      new EncryptionFlowError('invalid-request', 'The setting was not saved.')
    );
    migration.refresh.mockImplementation(async () => {
      migration.state.projects = [{ projectId: 'proj_a', phase: 'waiting' }];
    });
    keys.setUpEncryption.mockResolvedValue(ready);
    const { onClose, onComplete, onEncryptExisting } = open();
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    const shown = screen.getByLabelText('Recovery key').textContent ?? '';
    await confirmByLastGroup(shown);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on encryption' }));
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
