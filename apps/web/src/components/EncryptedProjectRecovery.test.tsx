import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AccountView, E2eeContext } from '../lib/e2ee/accountKeys';
import { EncryptedProjectRecovery } from './EncryptedProjectRecovery';

const CONFIRMATION =
  'Nobody else has access to this project. Reset its encryption group.';

const RESTORE_CONFIRMATION =
  'This is my project. Restore its verification record from this device.';

interface Listed {
  projectId: string;
  name: string;
  authority?: 'restorable' | 'identity-discontinued';
}

const page = vi.hoisted(() => ({
  resetEncryptedProject: vi.fn(async () => ({ epoch: 0, keyEpoch: 4 })),
  restoreEncryptedProjectAuthority: vi.fn(
    async (): Promise<{ verified: boolean; problem?: string }> => ({
      verified: true
    })
  ),
  encryptedProjectsForRecovery: vi.fn(async (): Promise<Listed[]> => [
    { projectId: 'proj_1', name: 'Bracket' }
  ])
}));

vi.mock('../lib/e2ee/pageDeviceRemoval', () => ({
  GROUP_RESET_CONFIRMATION:
    'Nobody else has access to this project. Reset its encryption group.',
  AUTHORITY_RESTORE_CONFIRMATION:
    'This is my project. Restore its verification record from this device.',
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
    // A project whose record the account returns is offered no restoration.
    expect(screen.queryByText('Restore record')).toBeNull();
  });

  // Issue #1704.
  it('restores a withdrawn verification record only after the plain-words confirmation', async () => {
    page.encryptedProjectsForRecovery.mockResolvedValueOnce([
      { projectId: 'proj_1', name: 'Bracket', authority: 'restorable' },
      {
        projectId: 'proj_2',
        name: 'Plate',
        authority: 'identity-discontinued'
      },
      { projectId: 'proj_3', name: 'Gear' }
    ]);
    const ctx = context(true);
    render(
      <EncryptedProjectRecovery ctx={ctx} account={account} canUsePasskey />
    );
    fireEvent.click(await screen.findByText('Show encrypted projects'));
    await screen.findByText(/no longer returns this project’s verification/);
    expect(page.encryptedProjectsForRecovery).toHaveBeenLastCalledWith(
      ctx,
      account
    );
    // Only the project this device can vouch for is offered a restoration;
    // one secured by erased keys is pointed at its local copy instead.
    expect(screen.getAllByText('Restore record')).toHaveLength(1);
    expect(screen.getByText(/Export project in the File menu/)).toBeTruthy();
    expect(
      screen.queryByLabelText('Restore the verification record of Plate')
    ).toBeNull();
    expect(
      screen.queryByLabelText('Restore the verification record of Gear')
    ).toBeNull();

    fireEvent.click(
      screen.getByLabelText('Restore the verification record of Bracket')
    );
    const action = screen.getByText('Restore verification record');
    expect((action as HTMLButtonElement).disabled).toBe(true);
    expect(page.restoreEncryptedProjectAuthority).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(RESTORE_CONFIRMATION));
    expect((action as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(action);
    await screen.findByText(/is back in your account. Open the project/);
    expect(page.restoreEncryptedProjectAuthority).toHaveBeenCalledWith(
      ctx,
      account,
      'proj_1',
      RESTORE_CONFIRMATION
    );
    // Restored: the row no longer offers it.
    expect(screen.queryByText('Restore record')).toBeNull();
  });

  it('says so when the restored record still leaves the history unverified, and keeps a refusal’s own words', async () => {
    const listed: Listed[] = [
      { projectId: 'proj_1', name: 'Bracket', authority: 'restorable' }
    ];
    page.encryptedProjectsForRecovery
      .mockResolvedValueOnce(listed)
      .mockResolvedValueOnce(listed);
    page.restoreEncryptedProjectAuthority
      .mockResolvedValueOnce({ verified: false, problem: 'History differs.' })
      .mockRejectedValueOnce(new Error('Only the owner can restore.'));
    const restore = async () => {
      fireEvent.click(await screen.findByText('Show encrypted projects'));
      fireEvent.click(
        await screen.findByLabelText(
          'Restore the verification record of Bracket'
        )
      );
      fireEvent.click(screen.getByLabelText(RESTORE_CONFIRMATION));
      fireEvent.click(screen.getByText('Restore verification record'));
    };
    const first = render(
      <EncryptedProjectRecovery
        ctx={context(true)}
        account={account}
        canUsePasskey
      />
    );
    await restore();
    await screen.findByText(/still doesn’t verify.*History differs/);
    first.unmount();
    render(
      <EncryptedProjectRecovery
        ctx={context(true)}
        account={account}
        canUsePasskey
      />
    );
    await restore();
    await screen.findByText('Only the owner can restore.');
    // Refused: the restoration stays on offer.
    expect(screen.getByText('Restore record')).toBeTruthy();
  });
});
