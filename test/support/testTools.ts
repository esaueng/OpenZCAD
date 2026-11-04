import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

let python: { request: string | undefined; executable: string } | undefined;
export const pythonEnvironment = () => ({ ...process.env, PYTHONUTF8: '1' });
/** Reject Windows Store aliases; use a real interpreter, including custom installs. */
export function pythonExecutable(): string {
  const request = process.env.OPENZCAD_PYTHON;
  if (python && python.request === request) return python.executable;
  for (const command of [request, 'python3', 'python', 'py']) {
    if (!command) continue;
    const probe = spawnSync(
      command,
      [
        ...(command === 'py' ? ['-3'] : []),
        '-c',
        'import sys; assert sys.version_info >= (3, 10); print(sys.executable)'
      ],
      { encoding: 'utf8', windowsHide: true, env: pythonEnvironment() }
    );
    if (probe.status === 0 && probe.stdout.trim()) {
      python = { request, executable: probe.stdout.trim() };
      return python.executable;
    }
    if (command === process.env.OPENZCAD_PYTHON)
      throw new Error(
        'OPENZCAD_PYTHON must name a working Python 3.10+ executable.'
      );
  }
  throw new Error(
    'Python 3.10+ is required for policy tests. Install Python or set OPENZCAD_PYTHON to its executable.'
  );
}

/** WSL bash does not inherit arbitrary Windows variables; use Git Bash on Windows. */
export function bashExecutable(): string {
  if (process.env.OPENZCAD_BASH) return process.env.OPENZCAD_BASH;
  if (process.platform !== 'win32') return 'bash';
  let directory = execFileSync('git', ['--exec-path'], {
    encoding: 'utf8'
  }).trim();
  while (directory !== parse(directory).root) {
    for (const folder of ['bin', 'usr/bin']) {
      const candidate = join(directory, folder, 'bash.exe');
      if (existsSync(candidate)) return candidate;
    }
    directory = dirname(directory);
  }
  throw new Error(
    'Git Bash is required for shell policy tests. Set OPENZCAD_BASH to its executable.'
  );
}

/** The recovery tool requires Linux tmpfs, POSIX descriptors and GnuPG. */
export function recoveryTestCommand(args: string[]): [string, string[]] {
  return process.platform === 'win32'
    ? ['wsl.exe', ['--cd', process.cwd(), '--exec', 'python3', ...args]]
    : [pythonExecutable(), args];
}
