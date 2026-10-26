import { act, render } from '@testing-library/react';
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
const { EnrollPanel } = await import('./EncryptionSettings');

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
      const setFlow = vi.fn();
      render(
        <EnrollPanel
          account={{ device: { label: 'Phone' } } as unknown as AccountView}
          ctx={{ userId: 'user_alice' } as E2eeContext}
          busy={false}
          run={run}
          setFlow={setFlow}
          flow={{
            kind: 'request',
            step: {
              step,
              approval: {} as never,
              scanCode: 'OZD1:000000',
              code: '123456',
              confirmed: true
            }
          }}
        />
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(errors).toEqual([conflict]);
      expect(run).toHaveBeenCalledOnce();
      expect(setFlow).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(advance).toHaveBeenCalledOnce();
    }
  );
});
