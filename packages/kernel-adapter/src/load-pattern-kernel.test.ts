import { afterEach, describe, expect, it, vi } from 'vitest';

const wasm = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);

describe('worker core kernel loading', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each(['application/wasm', 'application/octet-stream'])(
    'captures compiled code and instantiates a fresh kernel for %s',
    async (contentType) => {
      const fetch = vi.fn(
        async () =>
          new Response(wasm.slice(), {
            headers: { 'Content-Type': contentType }
          })
      );
      vi.stubGlobal('fetch', fetch);
      const { default: load } = await import('./load-pattern-kernel');
      const { patternKernelModule } = await import('./pattern-kernel-module');
      const first = await load({}, '/kernel.wasm');
      expect(patternKernelModule()).toBeInstanceOf(WebAssembly.Module);
      const second = await load({}, '/kernel.wasm');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(second).not.toBe(first);
    }
  );
});
