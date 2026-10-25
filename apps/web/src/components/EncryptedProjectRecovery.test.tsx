import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AccountView, E2eeContext } from '../lib/e2ee/accountKeys';
import { EncryptedProjectRecovery } from './EncryptedProjectRecovery';

const CONFIRMATION =
  'Nobody else has access to this project. Reset its encryption group.';

const page = vi.hoisted(() => ({
  resetEncryptedProject: vi.fn(async () => ({ epoch: 0, keyEpoch: 4 })),
  encryptedProjectsForRecovery: vi.fn(async () => [
    { projectId: 'proj_1', name: 'Bracket' }
  ])
}));

vi.mock('../lib/e2ee/pageDeviceRemoval', () => ({
  GROUP_RESET_CONFIRMATION:
    'Nobody else has access to this project. Reset its encryption group.',
  ...page
}));

function context(projectsEnabled: boolean): E2eeContext {
  return {
    userId: 'user_alice',
    api: {
      config: vi.fn(async () => ({ enabled: true, projectsEnabled }))
    } as unknown as E2eeContext['api'],
    store: {} as E2eeContext['store']
  };
}

const account = { userId: 'user_alice', generation: 1 } as AccountView;

describe('EncryptedProjectRecovery', () => {
  it('stays hidden while encrypted projects are off', async () => {
    const ctx = context(false);
    const { container } = render(
      <EncryptedProjectRecovery ctx={ctx} account={account} canUsePasskey />
    );
    await waitFor(() => expect(ctx.api.config).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('resets only after the plain-words confirmation', async () => {
    render(
      <EncryptedProjectRecovery
        ctx={context(true)}
        account={account}
        canUsePasskey
      />
    );
    fireEvent.click(await screen.findByText('Show encrypted projects'));
    fireEvent.click(
      await screen.findByLabelText('Reset the encryption group of Bracket')
    );
    const passkey = screen.getByText('Confirm with passkey');
    expect((passkey as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(CONFIRMATION));
    expect((passkey as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(passkey);
    await screen.findByText(/has a new encryption group/);
    expect(page.resetEncryptedProject).toHaveBeenCalledWith(
      expect.anything(),
      account,
      'proj_1',
      'passkey',
      CONFIRMATION
    );
  });
});
