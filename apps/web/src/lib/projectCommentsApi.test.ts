import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('./api');
  vi.unstubAllGlobals();
});

describe('projectCommentsApi', () => {
  it('sends nothing for an encrypted project', async () => {
    vi.doMock('./api', () => ({ isEncryptedProject: () => true }));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { projectCommentsApi, ENCRYPTED_COMMENTS_UNAVAILABLE } =
      await import('./projectCommentsApi');
    await expect(projectCommentsApi.list('proj_e')).rejects.toThrow(
      ENCRYPTED_COMMENTS_UNAVAILABLE
    );
    await expect(
      projectCommentsApi.create('proj_e', {
        anchor: { point: [0, 0, 0], documentVersion: 1 },
        text: 'Secret'
      })
    ).rejects.toThrow(ENCRYPTED_COMMENTS_UNAVAILABLE);
    expect(fetch).not.toHaveBeenCalled();
  });
});
