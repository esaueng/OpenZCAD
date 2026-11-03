import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unitTestInclude } from '../scripts/unit-suites.mjs';
import { pythonEnvironment, pythonExecutable } from './support/testTools';

function prepareCheckoutHistory(history: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      pythonExecutable(),
      ['scripts/test-fleet-checkout-fixtures.py', '--prepare', history],
      {
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        env: pythonEnvironment(),
        stdio: ['ignore', 'inherit', 'inherit'],
        windowsHide: true,
        detached: process.platform !== 'win32'
      }
    );
    const timer = setTimeout(() => {
      const timeout = new Error(
        'Checkout-history preparation exceeded 120000ms'
      );
      try {
        if (!child.pid) throw new Error('Fixture preparation has no owned PID');
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
            timeout: 5_000
          });
        } else {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch (error) {
        reject(
          new AggregateError(
            [timeout, error],
            'Fixture process-tree cleanup failed',
            { cause: error }
          )
        );
        try {
          child.kill('SIGKILL');
        } catch {
          // The rejected preparation already retains the tree-cleanup error.
        }
        return;
      }
      reject(timeout);
    }, 120_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Checkout-history preparation exited with ${code ?? signal}`
          )
        );
    });
  });
}

const removeOwnedHistory = (history: string) =>
  rmSync(history, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200
  });

/** Acquire immutable Git fixtures once, before the timed policy hooks run. */
export default async function prepareUnitFixtures() {
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
    await prepareCheckoutHistory(history);
    process.env.OPENZCAD_FLEET_CHECKOUT_HISTORY = history;
  } catch (error) {
    const failures = [error];
    try {
      removeOwnedHistory(history);
    } catch (cleanup) {
      failures.push(cleanup);
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        'Fixture preparation and owned-directory cleanup failed',
        { cause: error }
      );
    }
    throw error;
  }
  return () => {
    if (previousHistory === undefined)
      delete process.env.OPENZCAD_FLEET_CHECKOUT_HISTORY;
    else process.env.OPENZCAD_FLEET_CHECKOUT_HISTORY = previousHistory;
    removeOwnedHistory(history);
  };
}
