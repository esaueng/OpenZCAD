import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as crypto from './index';

it('keeps key/randomness injectors out of the public crypto entry', () => {
  expect(
    Object.keys(crypto).filter((name) =>
      /With$|ForTests$|^envelopeKeyFromBytes$/.test(name)
    )
  ).toEqual([]);
  expect(crypto.signMlsAuthorityManifest).toBeTypeOf('function');
  expect(crypto.verifyMlsAuthorityManifest).toBeTypeOf('function');
  // New module exports must be consciously added to the public contract.
  expect(
    readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  ).not.toMatch(/export\s+\*\s+from/);
});
