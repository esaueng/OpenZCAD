/**
 * The `@openzcad/crypto` real-browser scenarios, run in Node. The browsers
 * themselves need Playwright downloads and run only through
 * `pnpm --filter @openzcad/crypto test:browser`; this keeps the same steps
 * passing in `pnpm test`, so a format or API change cannot leave the browser
 * run stale.
 */
import { describe, expect, it } from 'vitest';
import {
  cryptoScenarios,
  runCryptoScenarios,
  type CryptoScenario,
  type StepResult
} from '../packages/crypto/browser/scenarios';

describe('crypto browser scenarios (in Node)', () => {
  it.each(cryptoScenarios.map((s) => [`${s.suite} › ${s.name}`, s] as const))(
    '%s',
    async (_name, scenario) => {
      // A detail line, never a warning: Node's WebCrypto enforces RFC 3394,
      // so even the engine probes pass here.
      expect(await scenario.run()).toBeTypeOf('string');
    },
    // Each step takes well under a second alone; leave room on a busy runner.
    30_000
  );

  it('may warn only from raw-engine probes', () => {
    const probes = cryptoScenarios.filter((s) => s.engineProbe);
    expect(probes.map((s) => s.suite)).toEqual(['engine']);
    expect(
      cryptoScenarios.filter((s) => s.suite === 'engine' && !s.engineProbe)
    ).toEqual([]);
  });

  it('covers the project data formats and the engine-independent KW refusal', () => {
    const names = cryptoScenarios.map((s) => `${s.suite} › ${s.name}`);
    for (const pattern of [
      /^wrap › with the engine's AES-KW integrity check bypassed/,
      /^wrap › rejoin-psk, archived-project-key and previous-account-key/,
      /^project data › a project-info envelope/,
      /^project data › a key-archive envelope/,
      /^version log › a signed version log verifies/,
      /^vectors › the rejoin-psk, archived-project-key and previous-account-key wraps are fixed/,
      /^vectors › the version log record/
    ]) {
      expect(
        names.some((name) => pattern.test(name)),
        String(pattern)
      ).toBe(true);
    }
  });

  it('reports a probe warning as a warning, and any other warning or throw as a failure', async () => {
    const steps: CryptoScenario[] = [
      { suite: 's', name: 'pass', run: async () => 'fine' },
      {
        suite: 's',
        name: 'probe',
        engineProbe: true,
        run: async () => ({ warning: 'engine skips a check' })
      },
      {
        suite: 's',
        name: 'package',
        run: async () => ({ warning: 'not allowed here' })
      },
      {
        suite: 's',
        name: 'throws',
        run: async () => {
          throw new Error('refusal missing');
        }
      }
    ];
    const results: StepResult[] = [];
    await runCryptoScenarios((result) => results.push(result), steps);
    expect(results.map((r) => [r.step, r.status])).toEqual([
      ['pass', 'pass'],
      ['probe', 'warn'],
      ['package', 'fail'],
      ['throws', 'fail']
    ]);
    expect(results[2]!.detail).toContain('may not warn');
    expect(results[3]!.detail).toBe('Error: refusal missing');
  });
});
