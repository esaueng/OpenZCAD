import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseFlags } from './cli-flags.mjs';

/**
 * The database and config to migrate: beta's by default; stable's deploy
 * passes both --database openzcad-stable and --config
 * ../../wrangler.stable.jsonc. One without the other is refused, so a
 * half-written command cannot migrate one database with another's config.
 */
export function migrationTarget(argv) {
  const flags = parseFlags(argv, ['--database', '--config']);
  const database = flags['--database'];
  const config = flags['--config'];
  if ((database === undefined) !== (config === undefined)) {
    throw new Error('Pass --database and --config together, or neither');
  }
  return {
    database: database ?? 'openzcad-beta',
    config: config ?? '../../wrangler.jsonc'
  };
}

function runWrangler({ database, config }) {
  const result = spawnSync(
    'wrangler',
    ['d1', 'migrations', 'apply', database, '--remote', '--config', config],
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
  target = { database: 'openzcad-beta', config: '../../wrangler.jsonc' },
  run = () => runWrangler(target),
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
  try {
    const target = migrationTarget(process.argv.slice(2));
    process.exitCode = await applyBetaMigrations({ target });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
