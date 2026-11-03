import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unitTestInclude } from '../scripts/unit-suites.mjs';
import { pythonEnvironment, pythonExecutable } from './support/testTools';

/** Acquire immutable Git fixtures once, before the timed policy hooks run. */
export default function prepareUnitFixtures() {
  if (process.env.CI)
    execFileSync(
      pythonExecutable(),
      ['scripts/prepare-fleet-test-fixtures.py'],
      {
        env: pythonEnvironment(),
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        stdio: 'inherit',
        timeout: 60_000
      }
    );
  const files = process.argv.filter((argument) =>
    /\.test\.tsx?$/.test(argument)
  );
  if (
    files.length &&
    !files.some((file) => file.endsWith('fleet-checkout-fixtures.test.ts'))
  )
    return;
  const included = unitTestInclude('root');
  if (!included) throw new Error('Root unit suite selection is missing.');
  if (
    !files.length &&
    !included.includes('test/**/*.test.ts') &&
    !included.includes('test/fleet-checkout-fixtures.test.ts')
  )
    return;
  const history = mkdtempSync(join(tmpdir(), 'fleet-checkout-history-'));
  const previousHistory = process.env.OPENZCAD_FLEET_CHECKOUT_HISTORY;
  try {
    execFileSync(
      pythonExecutable(),
      ['scripts/test-fleet-checkout-fixtures.py', '--prepare', history],
      {
        env: pythonEnvironment(),
        stdio: 'inherit',
        timeout: 60_000
      }
    );
    process.env.OPENZCAD_FLEET_CHECKOUT_HISTORY = history;
  } catch (error) {
    rmSync(history, { recursive: true, force: true });
    throw error;
  }
  return () => {
    if (previousHistory === undefined)
      delete process.env.OPENZCAD_FLEET_CHECKOUT_HISTORY;
    else process.env.OPENZCAD_FLEET_CHECKOUT_HISTORY = previousHistory;
    rmSync(history, { recursive: true, force: true });
  };
}
