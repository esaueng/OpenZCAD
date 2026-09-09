import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

function runWrangler() {
  const result = spawnSync(
    'wrangler',
    [
      'd1',
      'migrations',
      'apply',
      'openzcad-beta',
      '--remote',
      '--config',
      '../../wrangler.jsonc'
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  );
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) console.error(result.error.message);
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    interrupted: Boolean(result.error || result.signal)
  };
}

export async function applyBetaMigrations({
  run = runWrangler,
  sleep = setTimeout,
  random = Math.random,
  warn = console.warn
} = {}) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = run();
    if (result.status === 0) return 0;
    // Wrangler rolls back failed migrations and skips recorded successes on retry.
    const retryable =
      !result.interrupted &&
      /\[code:\s*7429\]/.test(result.output) &&
      result.output.includes('D1 DB storage operation exceeded timeout');
    if (!retryable || attempt === 3) return result.status;
    const delay = 2000 * 2 ** (attempt - 1) + Math.floor(random() * 1000);
    warn(
      `D1 storage timeout; retrying migrations (${attempt + 1}/3) in ${delay}ms.`
    );
    await sleep(delay);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await applyBetaMigrations();
}
