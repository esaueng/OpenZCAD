import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Acquire immutable Git fixtures once, before the timed policy hooks run. */
export default function prepareUnitFixtures() {
  if (!process.env.CI) return;
  execFileSync('python3', ['scripts/prepare-fleet-test-fixtures.py'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    stdio: 'inherit',
    timeout: 60_000
  });
}
