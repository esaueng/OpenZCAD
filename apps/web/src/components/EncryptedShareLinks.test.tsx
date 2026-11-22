import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  EncryptedShareLinks,
  type EncryptedShareLinkClient,
  type EncryptedShareLinksState
} from './EncryptedShareLinks';
import type { ShareRemovalNotice } from '../lib/e2ee/shareWorkStore';
import type { ProjectDocument } from '@openzcad/shared';

const URL_A = 'https://app.example/#share=a.b.c';

/** Opens a link's card, which holds its settings and actions. */
async function openCard(
  name: string,
  user: { click(element: Element): Promise<void> } = userEvent
) {
  await user.click(screen.getByRole('button', { name }));
}

/** Opens the card that makes a new link, once links exist. */
async function startNewLink(
  user: { click(element: Element): Promise<void> } = userEvent
) {
  await user.click(screen.getByRole('button', { name: 'New link' }));
}

function fakeClient(states: EncryptedShareLinksState[]) {
  let index = 0;
  let removal: ((notice?: ShareRemovalNotice) => void) | null = null;
  const client: EncryptedShareLinkClient & {
    fireRemoval(notice?: ShareRemovalNotice): void;
  } = {
    list: vi.fn(async () => states[Math.min(index++, states.length - 1)]!),
    create: vi.fn(async () => ({ url: URL_A, shareId: 'shr_new' })),
    rename: vi.fn(async () => undefined),
    revoke: vi.fn(async () => undefined),
    allowComments: vi.fn(async () => undefined),
    confirm: vi.fn(async () => undefined),
    reissue: vi.fn(async () => undefined),
    subscribeRemovals: vi.fn(
      (_projectId: string, listener: (notice?: ShareRemovalNotice) => void) => {
        removal = listener;
        return () => {
          removal = null;
        };
      }
    ),
    fireRemoval: (notice) => removal?.(notice)
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
  // Design review I79: a red banner, a disabled Create link and a separate
  // "Confirm sharing…" made two steps of one action. Create link now asks for
  // the confirmation itself, then makes the link.
  it('confirms sharing as part of Create link, and creates nothing on Cancel', async () => {
    const client = fakeClient([
      { links: [], retired: [], needsConfirmation: true },
      { links: [], retired: [], needsConfirmation: true },
      { links: [], retired: [], needsConfirmation: false }
    ]);
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    const create = await screen.findByRole('button', { name: 'Create link' });
    expect(create).toBeEnabled();
    // Without links there is no separate confirm step to find.
    expect(
      screen.queryByRole('button', { name: 'Confirm sharing…' })
    ).not.toBeInTheDocument();
    await userEvent.click(create);
    let group = screen.getByRole('group', { name: 'Confirm sharing' });
    expect(group).toHaveTextContent('To create the link');
    await userEvent.click(
      within(group).getByRole('button', { name: 'Cancel' })
    );
    expect(client.confirm).not.toHaveBeenCalled();
    expect(client.create).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Create link' }));
    group = screen.getByRole('group', { name: 'Confirm sharing' });
    await userEvent.click(
      within(group).getByRole('button', { name: 'Confirm with passkey' })
    );
    await waitFor(() => expect(client.create).toHaveBeenCalledOnce());
    expect(client.confirm).toHaveBeenCalledWith('proj_x', 'passkey');
    expect(client.create).toHaveBeenCalledWith('proj_x', 'view');
  });

  it.each(['not-published', 'needs-confirming', 'revocation-pending'] as const)(
    'does not copy a link while it is %s',
    async (status) => {
      const client = fakeClient([
        { ...active, links: [{ ...active.links[0]!, status }] }
      ]);
      render(<EncryptedShareLinks projectId="proj_x" client={client} />);
      expect(
        await screen.findByRole('button', { name: 'Copy View only link' })
      ).toBeDisabled();
    }
  );

  it('keeps the newest affected links when failed-journal callbacks arrive out of order', async () => {
    const client = fakeClient([active]);
    client.dismissRemoval = vi.fn(async () => {});
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    await screen.findByText(/^Active until /);
    act(() =>
      client.fireRemoval({
        cursor: '13',
        links: [{ shareId: 'shr_b', mode: 'tweak' }],
        problem: 'Storage unavailable'
      })
    );
    act(() =>
      client.fireRemoval({
        cursor: '12',
        links: [{ shareId: 'shr_a', mode: 'view' }],
        problem: 'Storage unavailable'
      })
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Reissue links' })
    );
    expect(client.reissue).toHaveBeenCalledWith('proj_x', [
      { shareId: 'shr_b', mode: 'tweak' }
    ]);
  });
  it('keeps a transient removal across the initial pending list and later empty reloads until acknowledged', async () => {
    const client = fakeClient([active]);
    let release!: (state: EncryptedShareLinksState) => void;
    vi.mocked(client.list)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      )
      .mockResolvedValue(active);
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    act(() =>
      client.fireRemoval({
        cursor: '12',
        links: [active.links[0]!],
        problem: 'Storage unavailable'
      })
    );
    expect(screen.getByText(/Someone lost access/)).toBeVisible();
    await act(async () => {
      release(active);
      await Promise.resolve();
    });
    expect(screen.getByText(/Someone lost access/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() =>
      expect(screen.queryByText(/Someone lost access/)).toBeNull()
    );
  });
  it('does not let an older reload erase a newer journaled notice', async () => {
    const client = fakeClient([active]);
    let release!: (state: EncryptedShareLinksState) => void;
    vi.mocked(client.list)
      .mockResolvedValueOnce(active)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      )
      .mockImplementationOnce(() => new Promise(() => {}));
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    await screen.findByText(/^Active until /);
    act(() =>
      client.fireRemoval({
        cursor: '12',
        links: [{ shareId: 'shr_a', mode: 'view' }]
      })
    );
    act(() =>
      client.fireRemoval({
        cursor: '13',
        links: [{ shareId: 'shr_b', mode: 'tweak' }]
      })
    );
    await act(async () => {
      release(active);
      await Promise.resolve();
    });
    expect(screen.getByText(/Someone lost access/)).toBeVisible();
    await userEvent.click(
      screen.getByRole('button', { name: 'Reissue links' })
    );
    expect(client.reissue).toHaveBeenCalledWith('proj_x', [
      { shareId: 'shr_b', mode: 'tweak' }
    ]);
  });

  it('shows the journaled affected links immediately while the background reload is stalled', async () => {
    const client = fakeClient([active]);
    vi.mocked(client.list)
      .mockResolvedValueOnce(active)
      .mockImplementation(() => new Promise(() => {}));
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    await screen.findByText(/^Active until /);
    act(() =>
      client.fireRemoval({
        cursor: '12',
        links: [{ shareId: 'shr_a', mode: 'view' }],
        problem: 'Browser storage is unavailable.'
      })
    );
    expect(screen.getByText(/Someone lost access/)).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Browser storage is unavailable.'
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Reissue links' })
    );
    expect(client.reissue).toHaveBeenCalledWith('proj_x', [
      { shareId: 'shr_a', mode: 'view' }
    ]);
  });

  it('loads a saved removal warning after the dialog was closed and acknowledges its exact cursor', async () => {
    const saved = {
      ...active,
      removalNotice: 'epoch-12',
      removalLinks: [active.links[0]!]
    };
    const newer = {
      ...active,
      removalNotice: 'epoch-13',
      removalLinks: [active.links[0]!]
    };
    const client = fakeClient([saved, newer]);
    client.dismissRemoval = vi.fn(async () => undefined);
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    expect(await screen.findByText(/Someone lost access/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(client.dismissRemoval).toHaveBeenCalledWith('proj_x', 'epoch-12');
    expect(await screen.findByText(/Someone lost access/)).toBeVisible();
  });

  it('signs a comment grant for the new link when its visitors may comment (L08)', async () => {
    const empty: EncryptedShareLinksState = {
      links: [],
      needsConfirmation: false,
      retired: []
    };
    const client = fakeClient([empty, active]);
    const user = userEvent.setup();
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    expect(await screen.findByText('Only invited people')).toBeVisible();
    const comments = screen.getByRole('checkbox', {
      name: /^Visitors can comment/
    });
    expect(comments).not.toBeChecked();
    await user.click(comments);
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    expect(client.create).toHaveBeenCalledWith('proj_x', 'view', {
      comments: true
    });
  });

  it('creates a Tweak link when the owner picks Tweak', async () => {
    const client = fakeClient([
      { links: [], needsConfirmation: false, retired: [] }
    ]);
    const user = userEvent.setup();
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    expect(await screen.findByText('Only invited people')).toBeVisible();
    const access = screen.getByRole('radiogroup', { name: 'Link access' });
    // An encrypted link still defaults to View.
    expect(within(access).getByRole('radio', { name: 'View' })).toBeChecked();
    await user.click(within(access).getByRole('radio', { name: 'Tweak' }));
    expect(access).toHaveAccessibleDescription(
      'Visitors can also change parameters. Their changes stay with them.'
    );
    expect(
      screen.getByText('End-to-end encrypted: the key is in the link.')
    ).toBeVisible();
    await user.click(within(access).getByRole('radio', { name: 'View' }));
    expect(access).toHaveAccessibleDescription(
      /Visitors can look, measure and export\./
    );
    await user.click(within(access).getByRole('radio', { name: 'Tweak' }));
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    expect(client.create).toHaveBeenCalledWith('proj_x', 'tweak');
    // The output names the link it holds; the new-link card has closed.
    expect(await screen.findByText('Tweak link is ready')).toBeVisible();
    expect(
      screen.queryByRole('radiogroup', { name: 'Link access' })
    ).not.toBeInTheDocument();
  });

  it('lets the owner allow comments on a link that does not take them (L08)', async () => {
    const commenting: EncryptedShareLinksState = {
      links: [
        { ...active.links[0]!, comments: false },
        { ...active.links[0]!, shareId: 'shr_c', mode: 'tweak', comments: true }
      ],
      needsConfirmation: false,
      retired: []
    };
    const client = fakeClient([commenting, commenting]);
    const user = userEvent.setup();
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    expect(await screen.findByText(/· Visitors can comment/)).toBeVisible();
    await openCard('Tweak link', user);
    await openCard('View only link', user);
    // Only the link that takes none offers it.
    expect(
      screen.queryByRole('button', { name: 'Allow comments on Tweak link' })
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Allow comments on View only link' })
    );
    expect(client.allowComments).toHaveBeenCalledWith('proj_x', 'shr_a');
  });

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
    expect(await screen.findByText('Only invited people')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Create link' }));
    expect(client.create).toHaveBeenCalledWith('proj_x', 'view');
    expect(await screen.findByLabelText('Share link')).toHaveValue(URL_A);
    expect(screen.getByText(/^Active until /)).toBeVisible();
    expect(screen.getByText('Needs confirming')).toBeVisible();
    // A link this device cannot open the key of offers no copy.
    expect(
      screen.queryByRole('button', { name: 'Copy Tweak link' })
    ).not.toBeInTheDocument();
    // The new link is copied from its box, not from its row as well.
    expect(
      screen.queryByRole('button', { name: 'Copy View only link' })
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Copy/ })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(URL_A);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeVisible();

    // Revoking asks first, with focus on the safe choice (design review I2).
    await openCard('View only link', user);
    await user.click(
      screen.getByRole('button', { name: 'Revoke View only link' })
    );
    expect(client.revoke).not.toHaveBeenCalled();
    const ask = screen.getByRole('group', { name: 'Revoke View only link' });
    expect(
      within(ask).getByRole('button', { name: 'Keep link' })
    ).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(client.revoke).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Revoke View only link' })
    ).toBeVisible();
    await user.click(
      screen.getByRole('button', { name: 'Revoke View only link' })
    );
    await user.click(screen.getByRole('button', { name: 'Revoke link' }));
    expect(client.revoke).toHaveBeenCalledWith('proj_x', 'shr_a');
    expect(await screen.findByText('Only invited people')).toBeVisible();
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
      { ...active, removalNotice: '12', removalLinks: [active.links[0]!] }
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
      await screen.findByText(/Someone lost access to this project/)
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Reissue links' }));
    expect(client.reissue).toHaveBeenLastCalledWith('proj_x', [
      active.links[0]!
    ]);
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
    await openCard('View only link', user);
    await user.click(
      screen.getByRole('button', { name: 'Revoke View only link' })
    );
    await user.click(screen.getByRole('button', { name: 'Revoke link' }));
    expect(await screen.findAllByText('Revocation pending')).not.toHaveLength(
      0
    );
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
    await user.click(screen.getByRole('button', { name: 'Revoke link' }));
    expect(client.revoke).toHaveBeenCalledTimes(2);
    expect(client.revoke).toHaveBeenLastCalledWith('proj_x', 'shr_a');
    expect(await screen.findByText('Only invited people')).toBeVisible();
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
    await openCard('Tweak link');
    expect(
      screen.getByRole('button', { name: 'Revoke Tweak link' })
    ).toBeEnabled();
  });
});

describe('EncryptedShareLinks names (ADR-024 amendment 2026-11-22)', () => {
  const empty: EncryptedShareLinksState = {
    links: [],
    needsConfirmation: false,
    retired: []
  };

  it('names a new link once it is made, and shows the name on its card', async () => {
    const named: EncryptedShareLinksState = {
      ...active,
      links: [{ ...active.links[0]!, shareId: 'shr_new', name: 'Client review' }]
    };
    const client = fakeClient([empty, named]);
    const user = userEvent.setup();
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    await screen.findByText('Only invited people');
    await user.type(
      screen.getByRole('textbox', { name: 'Link name' }),
      '  Client   review '
    );
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await waitFor(() =>
      expect(client.rename).toHaveBeenCalledWith(
        'proj_x',
        'shr_new',
        'Client review'
      )
    );
    expect(client.create).toHaveBeenCalledWith('proj_x', 'view');
    expect(await screen.findByText('Client review is ready')).toBeVisible();
    expect(
      await screen.findByRole('button', { name: 'Client review' })
    ).toBeVisible();
  });

  it('leaves a link unnamed when no name was typed', async () => {
    const client = fakeClient([empty, active]);
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    await screen.findByText('Only invited people');
    await userEvent.click(screen.getByRole('button', { name: 'Create link' }));
    await screen.findByText('View only link is ready');
    expect(client.rename).not.toHaveBeenCalled();
  });

  it('refuses a name with control characters before making the link', async () => {
    const client = fakeClient([empty]);
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    await screen.findByText('Only invited people');
    const field = screen.getByRole('textbox', { name: 'Link name' });
    await userEvent.click(field);
    await userEvent.paste('Bad\u0007name');
    await userEvent.click(screen.getByRole('button', { name: 'Create link' }));
    expect(
      await screen.findByText('A link name cannot contain control characters.')
    ).toBeVisible();
    expect(client.create).not.toHaveBeenCalled();
  });

  it('says when the link was made but its name was not saved', async () => {
    const client = fakeClient([empty, active]);
    vi.mocked(client.rename!).mockRejectedValueOnce(new Error('offline'));
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    await screen.findByText('Only invited people');
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Link name' }),
      'Supplier'
    );
    await userEvent.click(screen.getByRole('button', { name: 'Create link' }));
    expect(
      await screen.findByText(
        'The link was created, but its name was not saved: offline'
      )
    ).toBeVisible();
    expect(screen.getByLabelText('Share link')).toHaveValue(URL_A);
  });

  it('renames and clears a link from its card', async () => {
    const named: EncryptedShareLinksState = {
      ...active,
      links: [{ ...active.links[0]!, name: 'Client review' }, active.links[1]!]
    };
    const client = fakeClient([named]);
    const user = userEvent.setup();
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    await screen.findByRole('button', { name: 'Client review' });
    await openCard('Client review', user);
    const form = screen.getByRole('form', { name: 'Rename Client review' });
    const field = within(form).getByRole('textbox', { name: 'Link name' });
    const save = within(form).getByRole('button', { name: 'Save' });
    expect(field).toHaveValue('Client review');
    expect(field).toHaveAttribute('placeholder', 'View only link');
    expect(save).toBeDisabled();

    await user.clear(field);
    await user.type(field, 'Supplier');
    // The refresh after a rename reads the name back.
    let finishList: (state: EncryptedShareLinksState) => void = () => {};
    vi.mocked(client.list).mockImplementationOnce(
      () => new Promise((done) => (finishList = done))
    );
    await user.click(save);
    await waitFor(() =>
      expect(client.rename).toHaveBeenCalledWith('proj_x', 'shr_a', 'Supplier')
    );
    // Shown at once, before the list comes back.
    expect(
      await screen.findByRole('button', { name: 'Supplier' })
    ).toBeVisible();
    await act(async () =>
      finishList({
        ...named,
        links: [{ ...named.links[0]!, name: 'Supplier' }, named.links[1]!]
      })
    );

    // An empty name clears it: the card goes back to its mode.
    vi.mocked(client.list).mockResolvedValue({
      ...named,
      links: [{ ...named.links[0]!, name: null }, named.links[1]!]
    });
    const renamed = screen.getByRole('form', { name: 'Rename Supplier' });
    await user.clear(within(renamed).getByRole('textbox', { name: 'Link name' }));
    await user.click(within(renamed).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(client.rename).toHaveBeenLastCalledWith('proj_x', 'shr_a', null)
    );
    expect(
      await screen.findByRole('button', { name: 'View only link' })
    ).toBeVisible();
  });

  it('cannot name links with a client that does not store names', async () => {
    const client = fakeClient([empty]);
    delete client.rename;
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    await screen.findByText('Only invited people');
    expect(
      screen.queryByRole('textbox', { name: 'Link name' })
    ).not.toBeInTheDocument();
  });
});

describe('EncryptedShareLinks without history (L08)', () => {
  const frozenModel = { projectId: 'proj_x' } as unknown as ProjectDocument;
  const frozenRow: EncryptedShareLinksState = {
    links: [
      {
        shareId: 'shr_f',
        mode: 'frozen',
        url: URL_A,
        status: 'active',
        expiresAt: Date.UTC(2026, 10, 2)
      }
    ],
    needsConfirmation: false,
    retired: []
  };

  it('offers no choice where a model cannot be frozen, and shares history by default', async () => {
    const client = fakeClient([
      { links: [], retired: [], needsConfirmation: false }
    ]);
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Create link' })
    );
    expect(
      screen.queryByRole('checkbox', { name: 'Include history' })
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(client.create).toHaveBeenCalledWith('proj_x', 'view')
    );
  });

  it('creates a frozen link with the model frozen in this browser', async () => {
    const client = fakeClient([
      { links: [], retired: [], needsConfirmation: false },
      frozenRow
    ]);
    const onFreezeModel = vi.fn(async () => frozenModel);
    const user = userEvent.setup();
    render(
      <EncryptedShareLinks
        projectId="proj_x"
        client={client}
        onFreezeModel={onFreezeModel}
      />
    );
    const history = await screen.findByRole('checkbox', {
      name: 'Include history'
    });
    expect(history).toBeChecked();
    await user.click(history);
    const access = screen.getByRole('radiogroup', { name: 'Link access' });
    expect(within(access).getByRole('radio', { name: 'Tweak' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await waitFor(() =>
      expect(client.create).toHaveBeenCalledWith('proj_x', 'frozen', {
        frozenDocument: frozenModel
      })
    );
    expect(await screen.findAllByText(/No history link/)).not.toHaveLength(0);
  });

  it('Update freezes the current model into the listed link', async () => {
    const update = vi.fn(async () => undefined);
    const client = { ...fakeClient([frozenRow]), update };
    const onFreezeModel = vi.fn(async () => frozenModel);
    render(
      <EncryptedShareLinks
        projectId="proj_x"
        client={client}
        onFreezeModel={onFreezeModel}
      />
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'No history link' })
    );
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Update No history link to the current model'
      })
    );
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('proj_x', 'shr_f', frozenModel)
    );
    expect(client.create).not.toHaveBeenCalled();
  });

  it('says a frozen link with no model needs an update', async () => {
    const client = fakeClient([
      {
        ...frozenRow,
        links: [{ ...frozenRow.links[0]!, status: 'not-published' }]
      }
    ]);
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    expect(await screen.findByText('Needs an update')).toBeVisible();
    await openCard('No history link');
    // No model can be frozen here, so no Update is offered.
    expect(
      screen.queryByRole('button', { name: /to the current model$/ })
    ).not.toBeInTheDocument();
  });
});

describe('EncryptedShareLinks speed', () => {
  it('says it is checking while links load, with only Create link waiting', async () => {
    const client = fakeClient([
      { links: [], retired: [], needsConfirmation: false }
    ]);
    let finish: (state: EncryptedShareLinksState) => void = () => undefined;
    vi.mocked(client.list).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve))
    );
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    // Never "Anyone with a link" before the links are known.
    expect(screen.getByText('Checking links…')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'New link' })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Anyone with a link/)).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Tweak' })).toBeEnabled();
    expect(
      screen.getByRole('checkbox', { name: /^Visitors can comment/ })
    ).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Create link' })).toBeDisabled();
    await act(async () =>
      finish({ links: [], retired: [], needsConfirmation: false })
    );
    expect(screen.getByText('Only invited people')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create link' })).toBeEnabled();
  });

  it('goes straight to the passkey from Create link, then makes the link', async () => {
    const client = fakeClient([
      { links: [], retired: [], needsConfirmation: true, passkey: true },
      { links: [], retired: [], needsConfirmation: false, passkey: true }
    ]);
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Create link' })
    );
    expect(client.confirm).toHaveBeenCalledWith('proj_x', 'passkey');
    await waitFor(() => expect(client.create).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole('group', { name: 'Confirm sharing' })
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole('textbox', { name: 'Share link' })
    ).toHaveValue(URL_A);
  });

  it('offers the recovery key when the passkey prompt is cancelled', async () => {
    const client = fakeClient([
      { links: [], retired: [], needsConfirmation: true, passkey: true }
    ]);
    vi.mocked(client.confirm).mockRejectedValueOnce(
      new Error('The passkey prompt was canceled or timed out.')
    );
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Create link' })
    );
    const group = await screen.findByRole('group', { name: 'Confirm sharing' });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'canceled or timed out'
    );
    expect(client.create).not.toHaveBeenCalled();
    await userEvent.type(within(group).getByLabelText('Recovery key'), 'KEY');
    await userEvent.click(
      within(group).getByRole('button', { name: 'Confirm with recovery key' })
    );
    expect(client.confirm).toHaveBeenLastCalledWith('proj_x', {
      recoveryKey: 'KEY'
    });
    await waitFor(() => expect(client.create).toHaveBeenCalledOnce());
  });

  it('frees Create link when a passkey confirmation landed but a later step failed', async () => {
    const client = fakeClient([
      { links: [], retired: [], needsConfirmation: true, passkey: true },
      { links: [], retired: [], needsConfirmation: false, passkey: true }
    ]);
    // The confirmation was stored; issuing statements afterwards failed.
    vi.mocked(client.confirm).mockRejectedValueOnce(
      new Error('Statements could not be issued.')
    );
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    const create = await screen.findByRole('button', { name: 'Create link' });
    await userEvent.click(create);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'could not be issued'
    );
    // The refresh finds the confirmation: its form goes, and nothing waits on it.
    await waitFor(() =>
      expect(
        screen.queryByRole('group', { name: 'Confirm sharing' })
      ).not.toBeInTheDocument()
    );
    expect(create).toBeEnabled();
    expect(screen.getByRole('radio', { name: 'Tweak' })).toBeEnabled();
  });

  it('frees Create link when another refresh saw the confirmation before the action failed', async () => {
    const client = fakeClient([
      { links: [], retired: [], needsConfirmation: true, passkey: true },
      { links: [], retired: [], needsConfirmation: false, passkey: true }
    ]);
    let fail: (error: Error) => void = () => undefined;
    vi.mocked(client.confirm).mockImplementationOnce(
      () => new Promise((_, reject) => (fail = reject))
    );
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    const create = await screen.findByRole('button', { name: 'Create link' });
    await userEvent.click(create);
    // A removal refresh lands first and finds the stored confirmation...
    await act(async () => client.fireRemoval());
    // ...then the action's later step fails.
    await act(async () => fail(new Error('Statements could not be issued.')));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'could not be issued'
    );
    await waitFor(() => expect(create).toBeEnabled());
    expect(screen.getByRole('radio', { name: 'Tweak' })).toBeEnabled();
  });

  it('asks for the recovery key without a passkey prompt when the account has none', async () => {
    const client = fakeClient([
      { links: [], retired: [], needsConfirmation: true, passkey: false }
    ]);
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Create link' })
    );
    expect(
      screen.getByRole('group', { name: 'Confirm sharing' })
    ).toBeInTheDocument();
    expect(client.confirm).not.toHaveBeenCalled();
  });

  it('shows the new link and frees the dialog before the list catches up', async () => {
    const client = fakeClient([
      { links: [], retired: [], needsConfirmation: false }
    ]);
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    const create = await screen.findByRole('button', { name: 'Create link' });
    // The refresh after creating never answers in this test.
    vi.mocked(client.list).mockImplementation(() => new Promise(() => {}));
    await userEvent.click(create);
    expect(
      await screen.findByRole('textbox', { name: 'Share link' })
    ).toHaveValue(URL_A);
    // The new-link card closed; another one opens at once.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'New link' })).toBeEnabled()
    );
    await startNewLink();
    expect(screen.getByRole('button', { name: 'Create link' })).toBeEnabled();
    // The refresh skips the upkeep pass the action already did.
    expect(client.list).toHaveBeenLastCalledWith('proj_x', { upkeep: false });
  });

  it('keeps a revoked link uncopyable until the list shows it revoked', async () => {
    const client = fakeClient([active]);
    const user = userEvent.setup();
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    await screen.findByRole('button', { name: 'Copy View only link' });
    await openCard('View only link', user);
    let refreshed: (state: EncryptedShareLinksState) => void = () => undefined;
    vi.mocked(client.list).mockImplementation(
      () => new Promise((done) => (refreshed = done))
    );
    await user.click(
      screen.getByRole('button', { name: 'Revoke View only link' })
    );
    await user.click(screen.getByRole('button', { name: 'Revoke link' }));
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
    // Revoked on the server: not offered while the list catches up.
    expect(
      screen.queryByRole('button', { name: 'Copy View only link' })
    ).not.toBeInTheDocument();
    refreshed({ links: [], retired: [], needsConfirmation: false });
    expect(await screen.findByText('Only invited people')).toBeVisible();
  });

  it('keeps a revoked link uncopyable when the refresh after revoking fails', async () => {
    const client = fakeClient([active]);
    const user = userEvent.setup();
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    await screen.findByRole('button', { name: 'Copy View only link' });
    await openCard('View only link', user);
    vi.mocked(client.list).mockRejectedValue(new Error('List unavailable'));
    await user.click(
      screen.getByRole('button', { name: 'Revoke View only link' })
    );
    await user.click(screen.getByRole('button', { name: 'Revoke link' }));
    expect(await screen.findByText('List unavailable')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Copy View only link' })
    ).not.toBeInTheDocument();
  });

  it('drops an earlier action’s refresh error once another action starts', async () => {
    const client = fakeClient([active]);
    const user = userEvent.setup();
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    await user.click(await screen.findByRole('button', { name: 'New link' }));
    let fail: (error: Error) => void = () => undefined;
    vi.mocked(client.list).mockImplementationOnce(
      () => new Promise((_, reject) => (fail = reject))
    );
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    const again = await screen.findByRole('button', { name: 'New link' });
    await waitFor(() => expect(again).toBeEnabled());
    await user.click(again);
    const create = screen.getByRole('button', { name: 'Create link' });
    // The second Create link starts; the first one's refresh fails while
    // it runs.
    vi.mocked(client.list).mockResolvedValue(active);
    let made: (link: { url: string; shareId: string }) => void = () =>
      undefined;
    vi.mocked(client.create).mockImplementationOnce(
      () => new Promise((done) => (made = done))
    );
    await user.click(create);
    fail(new Error('First refresh failed'));
    await new Promise((settle) => setTimeout(settle, 0));
    made({ url: URL_A, shareId: 'shr_new' });
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'New link' })).toBeEnabled()
    );
    expect(screen.queryByText('First refresh failed')).not.toBeInTheDocument();
  });
});

describe('EncryptedShareLinks tab summary', () => {
  it('reports a revocation the server did not confirm, with its warning', async () => {
    const onSummary = vi.fn();
    const client = fakeClient([
      {
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
        retired: [],
        problem: 'A revoked link may still open for visitors.'
      }
    ]);
    render(
      <EncryptedShareLinks
        projectId="proj_x"
        client={client}
        onSummary={onSummary}
      />
    );
    await waitFor(() =>
      expect(onSummary).toHaveBeenLastCalledWith({
        count: 1,
        attention: true,
        problem: 'A revoked link may still open for visitors.'
      })
    );
  });

  it('keeps a card open, and focus on its Revoke, when revoking is cancelled after another card opened', async () => {
    const client = fakeClient([active]);
    const user = userEvent.setup();
    render(<EncryptedShareLinks projectId="proj_x" client={client} />);
    await screen.findByText(/^Active until /);
    await openCard('View only link', user);
    await user.click(
      screen.getByRole('button', { name: 'Revoke View only link' })
    );
    await openCard('Tweak link', user);
    await user.click(screen.getByRole('button', { name: 'Keep link' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Revoke View only link' })
      ).toHaveFocus()
    );
  });

  it('reports the link count, and a link that needs the owner', async () => {
    const onSummary = vi.fn();
    const client = fakeClient([{ ...active, needsConfirmation: true }]);
    render(
      <EncryptedShareLinks
        projectId="proj_x"
        client={client}
        onSummary={onSummary}
      />
    );
    await waitFor(() =>
      expect(onSummary).toHaveBeenLastCalledWith({
        count: 2,
        attention: true,
        problem: null
      })
    );
    // Nothing is reported before the links are known.
    expect(onSummary).not.toHaveBeenCalledWith(
      expect.objectContaining({ count: 0 })
    );
  });
});
