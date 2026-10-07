import { afterEach, describe, expect, it, vi } from 'vitest';

async function load(osPrefersReduced: boolean) {
  vi.resetModules();
  vi.stubGlobal(
    'matchMedia',
    vi.fn((media: string) => ({
      media,
      matches: osPrefersReduced && media === '(prefers-reduced-motion: reduce)'
    }))
  );
  return (await import('./reducedMotion')).reducesMotion;
}

describe('reducesMotion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('follows the OS preference when the in-app setting is off', async () => {
    expect((await load(true))(false)).toBe(true);
    expect((await load(true))(undefined)).toBe(true);
  });

  it('reduces motion when the in-app setting is on, whatever the OS says', async () => {
    expect((await load(false))(true)).toBe(true);
  });

  it('eases when neither asks for less motion', async () => {
    expect((await load(false))(false)).toBe(false);
  });
});
