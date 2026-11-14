import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toProjectId } from '@openzcad/shared';
import {
  encryptedProjectPinsUnavailable,
  isEncryptedProject,
  rememberEncryptedProject,
  rememberProjectFormats,
  treatProjectAsNotEncrypted
} from '../lib/api';
import {
  ENCRYPTED_PROJECT_PIN_FAILED_KEY,
  encryptedProjectPinKey
} from '../lib/e2ee/encryptedProjectPins';
import { EncryptedPinRecovery, PinResetDialog } from './EncryptedPinReset';

const OWNER = { confirmedByOwner: true } as const;

afterEach(() => {
  window.localStorage.removeItem(ENCRYPTED_PROJECT_PIN_FAILED_KEY);
});

/** A project this device pinned, which the account now lists as plaintext. */
function disagreeing(projectId: string, name: string) {
  rememberProjectFormats([
    { projectId: toProjectId(projectId), storageFormat: 2 }
  ]);
  rememberProjectFormats([
    { projectId: toProjectId(projectId), storageFormat: 1, name } as never
  ]);
}

describe('Settings › Encryption › On this device', () => {
  it('shows nothing while no project is stuck', () => {
    const { container } = render(<EncryptedPinRecovery />);
    expect(container.textContent).toBe('');
  });

  it('resets a project the account lists as not encrypted only once confirmed', () => {
    const projectId = 'proj_reset_mismatch';
    disagreeing(projectId, 'Decrypted bracket');
    try {
      render(<EncryptedPinRecovery />);
      const row = screen.getByRole('group', { name: 'Decrypted bracket' });
      expect(
        within(row).getByText(
          'Your account lists it as not encrypted, but this device keeps it encrypted.'
        )
      ).toBeTruthy();
      fireEvent.click(
        within(row).getByRole('button', {
          name: 'Treat as not encrypted on this device'
        })
      );
      // The risk, in plain words, before anything changes.
      expect(
        within(row).getByText(/your changes are saved readable by the server/)
      ).toBeTruthy();
      const confirm = within(row).getByRole<HTMLButtonElement>('button', {
        name: 'Treat as not encrypted'
      });
      expect(confirm.disabled).toBe(true);
      fireEvent.click(confirm);
      expect(isEncryptedProject(projectId)).toBe(true);

      fireEvent.click(within(row).getByRole('checkbox'));
      fireEvent.click(confirm);
      expect(isEncryptedProject(projectId)).toBe(false);
      expect(
        screen.getByText(
          'Decrypted bracket now follows your account on this device.'
        )
      ).toBeTruthy();
      expect(screen.queryByRole('group', { name: 'Decrypted bracket' })).toBe(
        null
      );
    } finally {
      treatProjectAsNotEncrypted(projectId, OWNER);
    }
  });

  it('resets pins it could not save, keeping the saved ones, once confirmed', () => {
    const kept = 'proj_reset_kept';
    expect(rememberEncryptedProject(kept)).toBe(true);
    // A pin could not be saved (in another tab).
    window.localStorage.setItem(ENCRYPTED_PROJECT_PIN_FAILED_KEY, '1');
    try {
      render(<EncryptedPinRecovery />);
      expect(
        screen.getByText('Every project is treated as encrypted')
      ).toBeTruthy();
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Stop treating every project as encrypted'
        })
      );
      expect(
        screen.getByText(/Resetting keeps every project already on the list/)
      ).toBeTruthy();
      const confirm = screen.getByRole<HTMLButtonElement>('button', {
        name: 'Reset the list'
      });
      expect(confirm.disabled).toBe(true);
      fireEvent.click(
        screen.getByRole('button', { name: 'Keep everything encrypted' })
      );
      expect(encryptedProjectPinsUnavailable()).toBe(true);

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Stop treating every project as encrypted'
        })
      );
      fireEvent.click(screen.getByRole('checkbox'));
      fireEvent.click(screen.getByRole('button', { name: 'Reset the list' }));
      expect(encryptedProjectPinsUnavailable()).toBe(false);
      expect(
        window.localStorage.getItem(ENCRYPTED_PROJECT_PIN_FAILED_KEY)
      ).toBeNull();
      expect(window.localStorage.getItem(encryptedProjectPinKey(kept))).toBe(
        '1'
      );
      expect(isEncryptedProject(kept)).toBe(true);
      expect(
        screen.getByText(/This device’s list of encrypted projects works again/)
      ).toBeTruthy();
    } finally {
      treatProjectAsNotEncrypted(kept, OWNER);
    }
  });
});

describe('the reset dialog', () => {
  it('explains the risk and resets nothing until confirmed', () => {
    const projectId = 'proj_reset_dialog';
    disagreeing(projectId, 'Dialog bracket');
    const onClose = vi.fn();
    const onReset = vi.fn();
    try {
      render(
        <PinResetDialog
          target={{
            kind: 'project',
            projectId,
            name: 'Dialog bracket',
            reason: 'unresolved'
          }}
          onClose={onClose}
          onReset={onReset}
        />
      );
      const dialog = screen.getByRole('dialog', {
        name: 'Treat as not encrypted on this device?'
      });
      expect(
        within(dialog).getByText(/Retrying the encryption is safer/)
      ).toBeTruthy();
      fireEvent.keyDown(dialog, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledOnce();
      expect(onReset).not.toHaveBeenCalled();
      expect(isEncryptedProject(projectId)).toBe(true);

      fireEvent.click(within(dialog).getByRole('checkbox'));
      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Treat as not encrypted' })
      );
      expect(onReset).toHaveBeenCalledWith({
        ok: true,
        message: 'Dialog bracket now follows your account on this device.'
      });
      expect(isEncryptedProject(projectId)).toBe(false);
    } finally {
      treatProjectAsNotEncrypted(projectId, OWNER);
    }
  });
});
