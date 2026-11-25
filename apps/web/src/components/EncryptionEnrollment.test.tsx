import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AccountView,
  E2eeContext,
  EncryptionState
} from '../lib/e2ee/accountKeys';
import type * as KeysModule from '../lib/e2ee/accountKeys';

const advance = vi.hoisted(() => vi.fn());
vi.mock('../lib/e2ee/accountKeys', async (original) => ({
  ...(await original<typeof KeysModule>()),
  advanceApprovalAsNewDevice: advance
}));
const { EncryptionFlowError } = await import('../lib/e2ee/accountKeys');
const { EnrollPanel, UNLOCK_FRESHNESS_NOTE } =
  await import('./EncryptionSettings');

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('device approval polling', () => {
  it.each(['waiting', 'compare'] as const)(
    'reports a contacts conflict while %s and stops retrying',
    async (step) => {
      vi.useFakeTimers();
      const conflict = new EncryptionFlowError(
        'grant-invalid',
        'The contacts lists conflict.'
      );
      advance.mockRejectedValue(conflict);
      const errors: unknown[] = [];
      const run = vi.fn(async (work: () => Promise<EncryptionState | void>) => {
        try {
          await work();
          return true;
        } catch (error) {
          errors.push(error);
          return false;
        }
      });
      const setStep = vi.fn();
      render(
        <EnrollPanel
          account={{ device: { label: 'Phone' } } as unknown as AccountView}
          ctx={{ userId: 'user_alice' } as E2eeContext}
          busy={false}
          run={run}
          setStep={setStep}
          passkey={false}
          onUnlock={vi.fn()}
          step={{
            step,
            approval: {} as never,
            scanCode: 'OZD1:000000',
            code: '123456',
            confirmed: true
          }}
        />
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(errors).toEqual([conflict]);
      expect(run).toHaveBeenCalledOnce();
      expect(setStep).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(advance).toHaveBeenCalledOnce();
    }
  );
});

describe('the unlock panel', () => {
  function panel(passkey: boolean) {
    const onUnlock = vi.fn();
    render(
      <EnrollPanel
        account={
          {
            device: { label: 'Laptop' },
            deviceStatus: 'none'
          } as unknown as AccountView
        }
        ctx={{ userId: 'user_alice' } as E2eeContext}
        busy={false}
        run={vi.fn()}
        setStep={vi.fn()}
        passkey={passkey}
        onUnlock={onUnlock}
        step={null}
      />
    );
    return onUnlock;
  }
  const actions = () =>
    screen
      .getAllByRole('button')
      .map((button) => [button.textContent, button.className]);

  it('puts the passkey first when the account has one this browser can use (D3)', () => {
    const onUnlock = panel(true);
    expect(actions()).toEqual([
      ['Unlock with passkey', 'primary'],
      ['Ask for approval', 'secondary'],
      ['Enter recovery key', 'secondary']
    ]);
    // The freshness limit it accepts is still said, once.
    expect(screen.getByText(UNLOCK_FRESHNESS_NOTE)).toBeVisible();
    fireEvent.click(
      screen.getByRole('button', { name: 'Unlock with passkey' })
    );
    expect(onUnlock).toHaveBeenCalledWith('passkey');
  });

  it('keeps approval first without a usable passkey', () => {
    panel(false);
    expect(actions()).toEqual([
      ['Ask for approval', 'primary'],
      ['Enter recovery key', 'secondary']
    ]);
    expect(screen.getByText(/^Recommended\./)).toBeVisible();
  });
});
