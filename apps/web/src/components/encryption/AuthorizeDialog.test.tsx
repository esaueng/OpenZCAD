import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateRecoveryKey } from '@openzcad/crypto';
import { EncryptionFlowError } from '../../lib/e2ee/accountKeys';
import { AuthorizeDialog } from './AuthorizeDialog';
import { testRun } from '../../test/encryptionRun';

afterEach(() => {
  vi.clearAllMocks();
});

describe('the authorize dialog', () => {
  it('leads with the passkey and keeps the recovery key one click away', async () => {
    const work = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(
      <AuthorizeDialog
        busy={false}
        run={testRun()}
        onClose={onClose}
        request={{
          title: 'Remove Laptop',
          body: 'It won’t open anything new.',
          actionLabel: 'Remove device',
          danger: true,
          passkey: true,
          work
        }}
      />
    );
    expect(screen.getByRole('dialog', { name: 'Remove Laptop' })).toBeVisible();
    expect(screen.queryByLabelText('Recovery key')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove device' })).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm with passkey' })
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(work).toHaveBeenCalledWith('passkey');
  });

  it('says a mistyped key under its field and asks nothing of the work', async () => {
    const work = vi.fn(async () => undefined);
    render(
      <AuthorizeDialog
        busy={false}
        run={testRun()}
        onClose={vi.fn()}
        request={{
          title: 'Add a passkey',
          actionLabel: 'Create passkey',
          passkey: true,
          work
        }}
      />
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Use recovery key instead' })
    );
    const field = screen.getByLabelText('Recovery key');
    fireEvent.change(field, { target: { value: 'not a key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create passkey' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That is not a recovery key'
    );
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(work).not.toHaveBeenCalled();
  });

  it('passes a well-formed key, then says a wrong one at the field', async () => {
    const key = await generateRecoveryKey();
    const work = vi.fn(async (authorization: unknown) => {
      expect(authorization).toBeInstanceOf(Uint8Array);
      throw new EncryptionFlowError(
        'wrong-recovery-key',
        'That recovery key does not open these keys.'
      );
    });
    const onClose = vi.fn();
    render(
      <AuthorizeDialog
        busy={false}
        run={testRun()}
        onClose={onClose}
        request={{
          title: 'Unlock this device',
          actionLabel: 'Unlock this device',
          passkey: false,
          work
        }}
      />
    );
    // Without a passkey the field is shown at once.
    fireEvent.change(screen.getByLabelText('Recovery key'), {
      target: { value: key.formatted }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock this device' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'does not open these keys'
    );
    expect(work).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('says any other failure inside the dialog', async () => {
    render(
      <AuthorizeDialog
        busy={false}
        run={testRun()}
        onClose={vi.fn()}
        request={{
          title: 'Approve “Phone”',
          actionLabel: 'Approve device',
          passkey: true,
          work: async () => {
            throw new EncryptionFlowError(
              'wrong-passkey',
              'That passkey is not certified for this identity.'
            );
          }
        }}
      />
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm with passkey' })
    );
    expect(
      await screen.findByText(
        'That passkey is not certified for this identity.'
      )
    ).toBeVisible();
  });
});
