import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

it('checks H02 pairing, percentile, overlapping-stage and acceptance reporting contracts', () => {
  execFileSync(
    process.execPath,
    [
      '--test',
      fileURLToPath(
        new URL('../scripts/h02-cache-benchmark.test.mjs', import.meta.url)
      )
    ],
    { stdio: 'pipe' }
  );
});
