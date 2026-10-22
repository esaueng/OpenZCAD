import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Mls } from './client';
import { scenarioSuites } from './scenarios';
import { inProcessMls, protocolMls } from './test-support';

const transports: [string, () => Mls][] = [
  ['in-process', inProcessMls],
  ['worker protocol', protocolMls]
];

describe.each(transports)('MLS scenarios (%s)', (_, make) => {
  const mls = make();
  afterAll(() => mls.close());

  it('reports the pinned build', async () => {
    expect(await mls.buildInfo()).toEqual({
      crate: 'openzcad-mls 0.1.0',
      mls: 'mls-rs 0.56.0',
      crypto: 'mls-rs-crypto-rustcrypto 0.22.1',
      cipherSuite: 2
    });
  });

  for (const suite of scenarioSuites) {
    describe(suite.name, () => {
      let context: unknown;
      beforeAll(async () => {
        context = await suite.setup(mls);
      });
      for (const step of suite.steps) {
        it(step.name, async () => {
          const detail = await step.run(context);
          expect(typeof detail).toBe('string');
        });
      }
    });
  }
});
