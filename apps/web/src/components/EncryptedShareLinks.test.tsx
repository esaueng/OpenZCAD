import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  EncryptedShareLinks,
  type EncryptedShareLinkClient,
  type EncryptedShareLinksState
} from './EncryptedShareLinks';

const URL_A = 'https://app.example/#share=a.b.c';

function fakeClient(states: EncryptedShareLinksState[]) {
  let index = 0;
  let removal: (() => void) | null = null;
  const client: EncryptedShareLinkClient & { fireRemoval(): void } = {
    list: vi.fn(async () => states[Math.min(index++, states.length - 1)]!),
    create: vi.fn(async () => ({ url: URL_A })),
    revoke: vi.fn(async () => undefined),
    confirm: vi.fn(async () => undefined),
    reissue: vi.fn(async () => undefined),
    subscribeRemovals: vi.fn((_projectId: string, listener: () => void) => {
      removal = listener;
      return () => {
        removal = null;
      };
    }),
    fireRemoval: () => removal?.()
  };
  return client;
}

const active: EncryptedShareLinksState = {
  links: [
    {
      shareId: 'shr_a',
      mode: 'view',
      url: URL_A,
      status: 'active',
      expiresAt: Date.UTC(2026, 10, 2)
    },
    {
      shareId: 'shr_b',
      mode: 'tweak',
      url: null,
      status: 'needs-confirming',
      expiresAt: null
    }
  ],
  needsConfirmation: false,
  retired: []
};

describe('EncryptedShareLinks (slice 5-10)', () => {
  it('creates, copies and revokes links, with each one’s status', async () => {
    const empty: EncryptedShareLinksState = {
      links: [],
      needsConfirmation: false,
      retired: []
    };
    const client = fakeClient([empty, active, empty]);
    const user = userEvent.setup();
    // After user-event installs its own clipboard.
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    expect(await screen.findByText('No links yet.')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Create link' }));
    expect(client.create).toHaveBeenCalledWith('proj_x', 'view');
    expect(await screen.findByLabelText('Share link')).toHaveValue(URL_A);
    expect(screen.getByText(/^Active until /)).toBeVisible();
    expect(screen.getByText('Needs confirming')).toBeVisible();
    // A link this device cannot open the key of offers no copy.
    expect(
      screen.queryByRole('button', { name: 'Copy Tweak link' })
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Copy View only link' })
    );
    expect(writeText).toHaveBeenCalledWith(URL_A);

    await user.click(
      screen.getByRole('button', { name: 'Revoke View only link' })
    );
    expect(client.revoke).toHaveBeenCalledWith('proj_x', 'shr_a');
    expect(await screen.findByText('No links yet.')).toBeVisible();
    expect(screen.queryByLabelText('Share link')).not.toBeInTheDocument();
  });

  it('asks to confirm sharing with a passkey or the recovery key', async () => {
    const client = fakeClient([{ ...active, needsConfirmation: true }, active]);
    const user = userEvent.setup();
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    await user.click(
      await screen.findByRole('button', { name: 'Confirm sharing…' })
    );
    const group = screen.getByRole('group', { name: 'Confirm sharing' });
    expect(group).toHaveTextContent('in the last 30 days');
    await user.type(screen.getByLabelText('Recovery key'), ' ABCD-EFGH ');
    await user.click(
      screen.getByRole('button', { name: 'Confirm with recovery key' })
    );
    expect(client.confirm).toHaveBeenCalledWith('proj_x', {
      recoveryKey: 'ABCD-EFGH'
    });
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Confirm sharing…' })
      ).not.toBeInTheDocument()
    );
  });

  it('offers to reissue the links after a removal and after an identity change', async () => {
    const client = fakeClient([
      {
        ...active,
        retired: [{ shareId: 'shr_old', mode: 'tweak' }]
      },
      active,
      active
    ]);
    const user = userEvent.setup();
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    expect(
      await screen.findByText(/Your encryption identity changed/)
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Reissue links' }));
    expect(client.reissue).toHaveBeenCalledWith('proj_x', [
      { shareId: 'shr_old', mode: 'tweak' }
    ]);
    await waitFor(() =>
      expect(
        screen.queryByText(/Your encryption identity changed/)
      ).not.toBeInTheDocument()
    );
    act(() => client.fireRemoval());
    expect(
      screen.getByText(/Someone lost access to this project/)
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Reissue links' }));
    expect(client.reissue).toHaveBeenLastCalledWith('proj_x', active.links);
  });

  it('keeps a revoked link the server still serves listed as revocation pending until revoking again succeeds', async () => {
    const pending: EncryptedShareLinksState = {
      links: [
        {
          shareId: 'shr_a',
          mode: 'view',
          url: null,
          status: 'revocation-pending',
          expiresAt: null
        }
      ],
      needsConfirmation: false,
      retired: []
    };
    const client = fakeClient([
      { ...active, links: [active.links[0]!] },
      pending,
      { links: [], needsConfirmation: false, retired: [] }
    ]);
    vi.mocked(client.revoke).mockRejectedValueOnce(
      new Error('The server did not confirm it stopped serving it.')
    );
    const user = userEvent.setup();
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    expect(await screen.findByText(/^Active until /)).toBeVisible();

    // The tombstone landed but the server's forget failed.
    await user.click(
      screen.getByRole('button', { name: 'Revoke View only link' })
    );
    expect(await screen.findByText('Revocation pending')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'did not confirm it stopped serving it'
    );
    expect(screen.queryByText(/^Active until /)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Copy View only link' })
    ).not.toBeInTheDocument();

    // Revoking it again asks the server again.
    await user.click(
      screen.getByRole('button', { name: 'Revoke View only link' })
    );
    expect(client.revoke).toHaveBeenCalledTimes(2);
    expect(client.revoke).toHaveBeenLastCalledWith('proj_x', 'shr_a');
    expect(await screen.findByText('No links yet.')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reports a pending revocation the list could not finish', async () => {
    const client = fakeClient([
      {
        links: [
          {
            shareId: 'shr_a',
            mode: 'tweak',
            url: null,
            status: 'revocation-pending',
            expiresAt: null
          }
        ],
        needsConfirmation: false,
        retired: [],
        problem: 'A revoked link may still open for visitors.'
      }
    ]);
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    expect(await screen.findByText('Revocation pending')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'A revoked link may still open for visitors.'
    );
    expect(
      screen.getByRole('button', { name: 'Revoke Tweak link' })
    ).toBeEnabled();
  });
});
