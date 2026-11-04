import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import {
  bashExecutable,
  pythonEnvironment,
  pythonExecutable,
  recoveryTestCommand
} from './support/testTools';

afterEach(() => vi.unstubAllEnvs());

it('passes Unicode and shell metacharacters as Python arguments without a shell', () => {
  const values = ['a b', 'λ測試', '$(literal); & "quotes"'];
  const result = execFileSync(
    pythonExecutable(),
    ['-c', 'import json,sys; print(json.dumps(sys.argv[1:]))', ...values],
    {
      encoding: 'utf8',
      env: pythonEnvironment()
    }
  );
  expect(JSON.parse(result)).toEqual(values);
});

it('fails closed on an explicitly configured executable that is not Python', () => {
  pythonExecutable();
  vi.stubEnv('OPENZCAD_PYTHON', process.execPath);
  expect(() => pythonExecutable()).toThrow('must name a working Python');
});

it('preserves the runner environment in the actual policy shell', () => {
  const value = 'fixture runner with spaces';
  expect(
    execFileSync(
      bashExecutable(),
      ['-eu', '-c', 'printf "%s" "$RUNNER_NAME"'],
      {
        encoding: 'utf8',
        env: { ...process.env, RUNNER_NAME: value }
      }
    )
  ).toBe(value);
});

it('runs Linux-only recovery assertions in Linux without changing their arguments', () => {
  const args = [
    '-m',
    'unittest',
    'discover',
    '-s',
    'scripts/recovery',
    '-p',
    'test_*.py'
  ];
  const [command, actual] = recoveryTestCommand(args);
  if (process.platform === 'win32') {
    expect(command).toBe('wsl.exe');
    expect(actual).toEqual([
      '--cd',
      process.cwd(),
      '--exec',
      'python3',
      ...args
    ]);
  } else {
    expect(command).toBe(pythonExecutable());
    expect(actual).toEqual(args);
  }
});
