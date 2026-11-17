import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { toProjectId } from '@openzcad/shared';
import {
  encryptedProjectPinsUnavailable,
  isEncryptedProject,
  rememberEncryptedProject,
  rememberProjectFormats,
  resetEncryptedProjectPins,
  treatProjectAsNotEncrypted
} from '../lib/api';
import {
  ENCRYPTED_PROJECT_PIN_FAILED_KEY,
  ENCRYPTED_PROJECT_RESET_PREFIX,
  encryptedProjectPinKey,
  localStorageEncryptedProjectPins
} from '../lib/e2ee/encryptedProjectPins';
import {
  EncryptedPinRecovery,
  PIN_RESET_NOT_SAVED,
  PIN_RESET_UNCONFIRMED,
  PinResetDialog
} from './EncryptedPinReset';

const OWNER = { confirmedByOwner: true } as const;

afterEach(() => {
  resetGenerationsFit = true;
  resetReadBackFails = false;
  window.localStorage.removeItem(ENCRYPTED_PROJECT_PIN_FAILED_KEY);
});

/**
 * This page's storage, with a switch that leaves no room for a new reset
 * generation. Installed before the pin store first reads it.
 */
const realStorage = window.localStorage;
const storageDescriptor = Object.getOwnPropertyDescriptor(
  window,
  'localStorage'
);
let resetGenerationsFit = true;
/** Set: a reset generation is saved, but reading it back throws once. */
let resetReadBackFails = false;
let unreadable: string | null = null;
const gatedStorage = {
  getItem: (key: string) => {
    if (key === unreadable) {
      unreadable = null;
      throw new DOMException('blocked', 'SecurityError');
    }
    return realStorage.getItem(key);
  },
  setItem: (key: string, value: string) => {
    if (resetReadBackFails && key.startsWith(ENCRYPTED_PROJECT_RESET_PREFIX)) {
      resetReadBackFails = false;
      unreadable = key;
    }
    if (
      !resetGenerationsFit &&
      key.startsWith(ENCRYPTED_PROJECT_RESET_PREFIX)
    ) {
      throw new DOMException('full', 'QuotaExceededError');
    }
    realStorage.setItem(key, value);
  },
  removeItem: (key: string) => realStorage.removeItem(key),
  key: (index: number) => realStorage.key(index),
  clear: () => realStorage.clear(),
  get length() {
    return realStorage.length;
  }
};
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  get: () => gatedStorage
});
afterAll(() => {
  if (storageDescriptor) {
    Object.defineProperty(window, 'localStorage', storageDescriptor);
  }
});

function resetGenerationsRefused() {
  resetGenerationsFit = false;
}

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

  // PR #1418 review: a reset whose new generation could not be saved
  // reported success, and the project was still locked after a reload.
  it('says a project reset was not saved, and changes nothing, when storage is full', () => {
    const projectId = 'proj_reset_full';
    disagreeing(projectId, 'Full bracket');
    try {
      render(<EncryptedPinRecovery />);
      const row = screen.getByRole('group', { name: 'Full bracket' });
      fireEvent.click(
        within(row).getByRole('button', {
          name: 'Treat as not encrypted on this device'
        })
      );
      fireEvent.click(within(row).getByRole('checkbox'));
      resetGenerationsRefused();
      fireEvent.click(
        within(row).getByRole('button', { name: 'Treat as not encrypted' })
      );
      expect(screen.getByText(PIN_RESET_NOT_SAVED)).toBeTruthy();
      expect(PIN_RESET_NOT_SAVED).toMatch(/Free up browser storage/);
      expect(
        screen.queryByText(
          'Full bracket now follows your account on this device.'
        )
      ).toBeNull();
      expect(isEncryptedProject(projectId)).toBe(true);
      expect(
        localStorageEncryptedProjectPins(window.localStorage).has(projectId)
      ).toBe(true);
      // Still offered, so the owner can retry once storage has room.
      expect(screen.getByRole('group', { name: 'Full bracket' })).toBeTruthy();
    } finally {
      resetGenerationsFit = true;
      treatProjectAsNotEncrypted(projectId, OWNER);
    }
  });
});

// PR #1418 review: a reset saved but not read back was reported as
// changing nothing, while a reload dropped the project's protections.
describe('a project reset that cannot be confirmed', () => {
  it('says so, and keeps the project encrypted here and after a reload', () => {
    const projectId = 'proj_reset_unsure';
    disagreeing(projectId, 'Unsure bracket');
    try {
      render(<EncryptedPinRecovery />);
      const row = screen.getByRole('group', { name: 'Unsure bracket' });
      fireEvent.click(
        within(row).getByRole('button', {
          name: 'Treat as not encrypted on this device'
        })
      );
      fireEvent.click(within(row).getByRole('checkbox'));
      resetReadBackFails = true;
      fireEvent.click(
        within(row).getByRole('button', { name: 'Treat as not encrypted' })
      );
      expect(screen.getByText(PIN_RESET_UNCONFIRMED)).toBeTruthy();
      expect(PIN_RESET_UNCONFIRMED).toMatch(/still treated as encrypted/);
      expect(PIN_RESET_UNCONFIRMED).toMatch(/reload/);
      expect(PIN_RESET_UNCONFIRMED).toMatch(/Settings › Encryption/);
      expect(screen.queryByText(PIN_RESET_NOT_SAVED)).toBeNull();
      expect(isEncryptedProject(projectId)).toBe(true);
      expect(encryptedProjectPinsUnavailable()).toBe(true);
      // A fresh load, even without the failure key, still holds the pin.
      window.localStorage.removeItem(ENCRYPTED_PROJECT_PIN_FAILED_KEY);
      expect(
        localStorageEncryptedProjectPins(window.localStorage).has(projectId)
      ).toBe(true);
    } finally {
      resetReadBackFails = false;
      unreadable = null;
      resetEncryptedProjectPins(OWNER);
      treatProjectAsNotEncrypted(projectId, OWNER);
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

  it('hands a reset that was not saved to its caller as a failure', () => {
    const projectId = 'proj_reset_dialog_full';
    disagreeing(projectId, 'Full dialog bracket');
    const onReset = vi.fn();
    try {
      render(
        <PinResetDialog
          target={{
            kind: 'project',
            projectId,
            name: 'Full dialog bracket',
            reason: 'mismatch'
          }}
          onClose={() => {}}
          onReset={onReset}
        />
      );
      const dialog = screen.getByRole('dialog');
      fireEvent.click(within(dialog).getByRole('checkbox'));
      resetGenerationsRefused();
      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Treat as not encrypted' })
      );
      expect(onReset).toHaveBeenCalledWith({
        ok: false,
        message: PIN_RESET_NOT_SAVED
      });
      expect(isEncryptedProject(projectId)).toBe(true);
    } finally {
      resetGenerationsFit = true;
      treatProjectAsNotEncrypted(projectId, OWNER);
    }
  });
});
