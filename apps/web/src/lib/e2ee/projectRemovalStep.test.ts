import { describe, expect, it, vi } from 'vitest';
import type { E2eeContext } from './accountKeys';

const page = vi.hoisted(() => ({
  prepare: vi.fn(async () => undefined),
  written: vi.fn(async () => undefined),
  complete: vi.fn(async () => ({ rotated: [], left: [], cutoffsStored: true }))
}));
vi.mock('./pageDeviceRemoval', () => ({
  pageRemovalParticipant: () => page
}));

const { projectRemovalStep } = await import('./projectRemovalStep');

describe('the removal step Settings hands a rotation (#894 review)', () => {
  it('forwards every participant step, written included', async () => {
    const step = projectRemovalStep({} as E2eeContext, () => undefined);
    const account = {} as never;
    await step.prepare(account);
    const written = {
      kind: 'device' as const,
      identityPrivateKey: {} as CryptoKey,
      userId: 'user_1',
      generation: 1,
      written: { sequence: 2, hash: new Uint8Array(32) }
    };
    await step.written!(written);
    await step.complete({
      kind: 'device',
      identityPrivateKey: written.identityPrivateKey,
      account,
      written: written.written
    });
    expect(page.prepare).toHaveBeenCalledWith(account);
    expect(page.written).toHaveBeenCalledWith(written);
    expect(page.complete).toHaveBeenCalledTimes(1);
  });
});
