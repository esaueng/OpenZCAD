import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import type * as FsModule from 'node:fs';
import { EventEmitter } from 'node:events';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import prepareUnitFixtures from './unit-global-setup';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn()
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof FsModule>();
  return { ...fs, rmSync: vi.fn(fs.rmSync) };
});
vi.mock('./support/testTools', () => ({
  pythonExecutable: () => 'fixture-python',
  pythonEnvironment: () => ({ ...process.env, PYTHONUTF8: '1' })
}));

const originalArgv = process.argv;
const realFs = await vi.importActual<typeof FsModule>('node:fs');
let child: ChildProcess;
beforeEach(() => {
  process.argv = ['node', 'vitest', 'run', 'test/unrelated.test.ts'];
  child = Object.assign(new EventEmitter(), {
    pid: 424242,
    kill: vi.fn()
  }) as unknown as ChildProcess;
  vi.mocked(spawn).mockImplementation(() => {
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  });
  vi.mocked(rmSync).mockImplementation(realFs.rmSync);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
  process.argv = originalArgv;
});

describe('pre-worker Git fixture acquisition', () => {
  it('does no network acquisition for ordinary local runs', async () => {
    vi.stubEnv('CI', '');
    await prepareUnitFixtures();
    expect(execFileSync).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fails CI when acquiring the immutable evidence fails', async () => {
    vi.stubEnv('CI', 'true');
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('fixture fetch refused');
    });
    await expect(prepareUnitFixtures()).rejects.toThrow(
      'fixture fetch refused'
    );
  });

  it('bounds the acquisition separately from the unchanged policy hook deadline', async () => {
    vi.stubEnv('CI', 'true');
    await prepareUnitFixtures();
    expect(execFileSync).toHaveBeenCalledWith(
      'fixture-python',
      ['scripts/prepare-fleet-test-fixtures.py'],
      expect.objectContaining({ timeout: 60_000, stdio: 'inherit' })
    );
  });

  it.each([[], ['test/fleet-checkout-fixtures.test.ts']])(
    'prepares selected disposable history before workers and cleans only its owned directory (%j)',
    async (...files) => {
      vi.stubEnv('CI', '');
      vi.stubEnv('OPENZCAD_UNIT_SUITE', 'full');
      vi.stubEnv('OPENZCAD_FLEET_CHECKOUT_HISTORY', 'caller-owned-history');
      process.argv = ['node', 'vitest', 'run', ...files];
      const cleanup = await prepareUnitFixtures();
      const history = process.env.OPENZCAD_FLEET_CHECKOUT_HISTORY!;
      try {
        expect(spawn).toHaveBeenCalledWith(
          'fixture-python',
          ['scripts/test-fleet-checkout-fixtures.py', '--prepare', history],
          expect.objectContaining({
            stdio: ['ignore', 'inherit', 'inherit'],
            windowsHide: true,
            detached: process.platform !== 'win32'
          })
        );
        expect(history).not.toBe('caller-owned-history');
        expect(existsSync(history)).toBe(true);
      } finally {
        cleanup!();
      }
      expect(existsSync(history)).toBe(false);
      expect(process.env.OPENZCAD_FLEET_CHECKOUT_HISTORY).toBe(
        'caller-owned-history'
      );
    }
  );

  it('does not construct checkout histories when CI smoke is filtered to another file', async () => {
    vi.stubEnv('CI', 'true');
    vi.stubEnv('OPENZCAD_UNIT_SUITE', 'smoke');
    process.argv = ['node', 'vitest', 'run', 'test/unrelated.test.ts'];
    await prepareUnitFixtures();
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('bounds normal-hook history provisioning at two minutes and retires only its owned process tree', async () => {
    vi.stubEnv('CI', '');
    vi.stubEnv('OPENZCAD_FLEET_CHECKOUT_HISTORY', 'caller-owned-history');
    process.argv = [
      'node',
      'vitest',
      'run',
      'test/fleet-checkout-fixtures.test.ts'
    ];
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.mocked(spawn).mockReturnValue(child);
    const preparation = prepareUnitFixtures();
    let settled = false;
    void preparation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    const failure = expect(preparation).rejects.toThrow('exceeded 120000ms');
    const history = (vi.mocked(spawn).mock.calls[0]![1] as string[])[2]!;
    await vi.advanceTimersByTimeAsync(119_999);
    expect(settled).toBe(false);
    expect(existsSync(history)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await failure;
    if (process.platform === 'win32') {
      expect(execFileSync).toHaveBeenCalledWith(
        'taskkill',
        ['/PID', '424242', '/T', '/F'],
        expect.objectContaining({ timeout: 5_000, stdio: 'ignore' })
      );
    } else {
      expect(kill).toHaveBeenCalledWith(-424242, 'SIGKILL');
    }
    expect(existsSync(history)).toBe(false);
    expect(process.env.OPENZCAD_FLEET_CHECKOUT_HISTORY).toBe(
      'caller-owned-history'
    );
  });

  it('preserves both the preparation error and a failed owned-directory cleanup', async () => {
    vi.stubEnv('CI', '');
    process.argv = [
      'node',
      'vitest',
      'run',
      'test/fleet-checkout-fixtures.test.ts'
    ];
    const preparationError = new Error('history preparation refused');
    const cleanupError = Object.assign(new Error('owned directory is busy'), {
      code: 'EPERM'
    });
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit('error', preparationError));
      return child;
    });
    vi.mocked(rmSync).mockImplementation(() => {
      throw cleanupError;
    });
    const failure = await prepareUnitFixtures().catch(
      (error: unknown) => error
    );
    const history = (vi.mocked(spawn).mock.calls[0]![1] as string[])[2]!;
    try {
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([
        preparationError,
        cleanupError
      ]);
      expect((failure as AggregateError).cause).toBe(preparationError);
    } finally {
      expect(dirname(history)).toBe(tmpdir());
      realFs.rmSync(history, { recursive: true, force: true });
    }
  });
});
