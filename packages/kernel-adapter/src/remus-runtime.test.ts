import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('remus-wasm-io');
  vi.resetModules();
});

describe('loadRemusTranslators', () => {
  it('retries a transient translator load failure on the next call', async () => {
    vi.resetModules();
    let attempts = 0;
    vi.doMock('remus-wasm-io', () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('Failed to fetch dynamically imported module');
      }
      return {
        RemusIo: class {
          readonly fake = true;
        }
      };
    });
    const { loadRemusTranslators, remusTranslators } =
      await import('./remus-runtime');

    // A rejected load must not be memoized for the worker's life: every
    // import, export and imported-body sync would replay it until reload.
    await expect(loadRemusTranslators()).rejects.toThrow(
      /Failed to fetch|error when mocking/
    );
    expect(() => remusTranslators()).toThrow(/not loaded/);

    // The network is back; the next call loads afresh and then stays loaded.
    const io = await loadRemusTranslators();
    expect(io).toMatchObject({ fake: true });
    expect(remusTranslators()).toBe(io);
    await expect(loadRemusTranslators()).resolves.toBe(io);
    expect(attempts).toBe(2);
  });

  it('marks translator initialization failures without losing their cause', async () => {
    const failure = new Error('Translator WASM fetch failed.');
    vi.doMock('remus-wasm-io', () => ({
      RemusIo: class {
        constructor() {
          throw failure;
        }
      }
    }));
    const { loadRemusTranslators } = await import('./remus-runtime');
    await expect(loadRemusTranslators()).rejects.toMatchObject({
      name: 'RemusTranslatorLoadError',
      category: 'environment-load',
      message: failure.message,
      cause: failure
    });
  });
});
