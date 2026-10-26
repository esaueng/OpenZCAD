import { beforeEach, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({ fetch: vi.fn(), load: vi.fn() }));
vi.mock('../desktopBridge', async (original) => ({
  ...(await original<typeof import('../desktopBridge')>()),
  desktopFetch: fakes.fetch
}));
vi.mock('./accountKeys', async (original) => ({
  ...(await original<typeof import('./accountKeys')>()),
  loadEncryption: fakes.load
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

it('refuses a different session account before opening migration keys', async () => {
  const { openMigrationStaging } = await import('./encryptedProjects');
  fakes.fetch.mockResolvedValue(Response.json({ userId: 'new-account' }));
  await expect(openMigrationStaging('old-account')).rejects.toMatchObject({
    code: 'E2EE_KEYS_LOCKED'
  });
  expect(fakes.load).not.toHaveBeenCalled();
});

it('refuses a session response arriving after key teardown before opening keys', async () => {
  const { openMigrationStaging } = await import('./encryptedProjects');
  const session = await import('./keySession');
  let release!: (response: Response) => void;
  fakes.fetch.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      })
  );
  const staging = openMigrationStaging('account');
  session.beginKeySessionTeardown();
  release(Response.json({ userId: 'account' }));
  await expect(staging).rejects.toMatchObject({ code: 'E2EE_KEYS_LOCKED' });
  expect(fakes.load).not.toHaveBeenCalled();
});
