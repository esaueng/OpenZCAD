import { expect, vi } from 'vitest';

(globalThis as Record<string, unknown>).DurableObject ??=
  class DurableObject {};

// These files run complete encrypted-project flows with real cryptography.
// Keep the unit default and explicit deadline controls unchanged. Vitest
// restores configuration after each file, including when workers are reused.
if (
  /[/\\]test[/\\]e2ee-[^/\\]+\.test\.ts$/.test(expect.getState().testPath ?? '')
) {
  vi.setConfig({ testTimeout: 30_000 });
}
