import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateRecoveryKey } from '@openzcad/crypto';
import type { AccountView, E2eeContext } from '../lib/e2ee/accountKeys';
import type * as ContactsModule from '../lib/e2ee/contacts';
import type { ContactsBook } from '../lib/e2ee/contacts';

/**
 * ADR-024, verified pins: on a device whose contacts list no other device
 * confirmed, contacts verified elsewhere show as seen, with a way to have
 * another device confirm the list.
 */

const loadContacts = vi.fn<() => Promise<ContactsBook>>();
const sealContactsList = vi.fn<(...args: unknown[]) => Promise<ContactsBook>>();

vi.mock('../lib/e2ee/contacts', async (importOriginal) => ({
  ...(await importOriginal<typeof ContactsModule>()),
  loadContacts: () => loadContacts(),
  sealContactsList: (...args: unknown[]) => sealContactsList(...args),
  ownVerificationCode: async () => ({
    hash: new Uint8Array(32),
    code: '00000 00000 00000 00000 00000 00000 00000 00000'
  })
}));

const { EncryptionContacts } = await import('./EncryptionContacts');

const account = {
  userId: 'user_alice',
  generation: 1,
  list: { headHash: new Uint8Array(32), unlockTargets: [] }
} as unknown as AccountView;
const keys = { userId: 'user_alice' } as unknown as E2eeContext;

function book(listConfirmed: boolean, status = 'verified'): ContactsBook {
  return {
    userId: 'user_alice',
    generation: 1,
    list: {
      contacts: new Map([['user_bob', { status }]])
    } as unknown as ContactsBook['list'],
    listConfirmed,
    people: [{ userId: 'user_bob', email: 'bob@example.com' }],
    contacts: [
      {
        userId: 'user_bob',
        email: 'bob@example.com',
        standing: listConfirmed ? 'verified' : 'seen'
      }
    ]
  };
}

beforeEach(() => {
  loadContacts.mockReset();
  sealContactsList.mockReset();
});

describe('EncryptionContacts', () => {
  it.each(['empty', 'untrusted'] as const)(
    'offers confirmation for an unconfirmed %s list',
    async (kind) => {
      const baseline = book(false, 'untrusted');
      const answer: ContactsBook = {
        ...baseline,
        list: kind === 'empty' ? null : baseline.list,
        contacts: []
      };
      loadContacts.mockResolvedValue(answer);
      const confirm = vi.fn();
      render(
        <EncryptionContacts
          keys={keys}
          account={account}
          onConfirmFromDevice={confirm}
        />
      );
      fireEvent.click(
        await screen.findByRole('button', {
          name: 'Confirm from another device'
        })
      );
      expect(confirm).toHaveBeenCalledOnce();
    }
  );

  it('shows verified contacts as seen on an unconfirmed device and offers confirmation', async () => {
    loadContacts.mockResolvedValue(book(false));
    const confirm = vi.fn();
    render(
      <EncryptionContacts
        keys={keys}
        account={account}
        onConfirmFromDevice={confirm}
      />
    );
    expect(await screen.findByText('Seen')).toBeTruthy();
    expect(screen.queryByText('Verified')).toBeNull();
    expect(screen.getByText('0 verified')).toBeTruthy();
    expect(
      screen.getByText(/No other device of yours has confirmed/)
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm from another device' })
    );
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('says nothing more once the list is confirmed', async () => {
    loadContacts.mockResolvedValue(book(true));
    render(
      <EncryptionContacts
        keys={keys}
        account={account}
        onConfirmFromDevice={vi.fn()}
      />
    );
    expect(await screen.findByText('Verified')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('1 verified')).toBeTruthy());
    expect(screen.queryByText(/No other device of yours/)).toBeNull();
  });

  it('offers to seal a plaintext list, and stops once it is sealed (ADR-024 amendment 2026-11-14)', async () => {
    const plaintext = book(true);
    loadContacts.mockResolvedValue({
      ...plaintext,
      list: { ...plaintext.list!, sealed: null }
    });
    const sealedBook: ContactsBook = {
      ...plaintext,
      list: {
        ...plaintext.list!,
        sealed: {
          sequence: 0,
          recordHash: new Uint8Array(32),
          accountKeySequence: 0
        }
      }
    };
    // The server holds the sealed list from then on.
    sealContactsList.mockImplementation(async () => {
      loadContacts.mockResolvedValue(sealedBook);
      return sealedBook;
    });
    render(<EncryptionContacts keys={keys} account={account} />);
    expect(
      await screen.findByText(/stored where the server can read whom you/)
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Seal contacts list' }));
    fireEvent.change(screen.getByLabelText('Recovery key'), {
      target: { value: 'not a key' }
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Seal with recovery key' })
    );
    // A recovery key that does not parse never reaches the seal.
    expect(await screen.findByText(/That is not a recovery key/)).toBeTruthy();
    expect(sealContactsList).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Recovery key'), {
      target: { value: (await generateRecoveryKey()).formatted }
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Seal with recovery key' })
    );
    await waitFor(() => expect(sealContactsList).toHaveBeenCalledOnce());
    expect(sealContactsList.mock.calls[0]![3]).toBeInstanceOf(Uint8Array);
    await waitFor(() =>
      expect(screen.queryByText(/stored where the server can read/)).toBeNull()
    );
    expect(screen.queryByLabelText('Recovery key')).toBeNull();
  });

  it('says nothing about sealing a sealed list', async () => {
    loadContacts.mockResolvedValue(book(true));
    render(<EncryptionContacts keys={keys} account={account} />);
    expect(await screen.findByText('Verified')).toBeTruthy();
    expect(screen.queryByText(/stored where the server can read/)).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Seal contacts list' })
    ).toBeNull();
  });
});
