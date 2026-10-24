/**
 * The `@openzcad/crypto` real-browser scenarios, run in Node. The browsers
 * themselves need Playwright downloads and run only through
 * `pnpm --filter @openzcad/crypto test:browser`; this keeps the same steps
 * passing in `pnpm test`, so a format or API change cannot leave the browser
 * run stale.
 */
import { describe, expect, it } from 'vitest';
import { cryptoScenarios } from '../packages/crypto/browser/scenarios';

describe('crypto browser scenarios (in Node)', () => {
  it.each(cryptoScenarios.map((s) => [`${s.suite} › ${s.name}`, s] as const))(
    '%s',
    async (_name, scenario) => {
      expect(typeof (await scenario.run())).toBe('string');
    },
    // Each step takes well under a second alone; leave room on a busy runner.
    30_000
  );
});
