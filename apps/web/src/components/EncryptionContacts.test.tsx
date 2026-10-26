import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountView, E2eeContext } from '../lib/e2ee/accountKeys';
import type * as ContactsModule from '../lib/e2ee/contacts';
import type { ContactsBook } from '../lib/e2ee/contacts';

/**
 * ADR-024, verified pins: on a device whose contacts list no other device
 * confirmed, contacts verified elsewhere show as seen, with a way to have
 * another device confirm the list.
 */

const loadContacts = vi.fn<() => Promise<ContactsBook>>();

vi.mock('../lib/e2ee/contacts', async (importOriginal) => ({
  ...(await importOriginal<typeof ContactsModule>()),
  loadContacts: () => loadContacts(),
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

function book(listConfirmed: boolean): ContactsBook {
  return {
    userId: 'user_alice',
    generation: 1,
    list: {
      contacts: new Map([['user_bob', { status: 'verified' }]])
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
});

describe('EncryptionContacts', () => {
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
});
