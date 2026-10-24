// Run the @openzcad/crypto scenarios (browser/scenarios.ts) on a page in
// Chromium, WebKit and Firefox, against each engine's own WebCrypto and web
// streams. From the repository root:
//   pnpm --filter @openzcad/crypto test:browser
//     [-- --chromium-only | --browsers=chromium,firefox] [--verbose]
// Needs the Playwright browsers
// (pnpm exec playwright install chromium webkit firefox). Exits non-zero
// only for failures; an engine-probe warning (scenarios.ts) is printed and
// does not fail the run.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from '@playwright/test';

const here = fileURLToPath(new URL('.', import.meta.url));
const web = join(here, '../../../apps/web');
const dist = join(here, 'dist');
const engines = { chromium, webkit, firefox };
const verbose = process.argv.includes('--verbose');
const listed = process.argv
  .find((arg) => arg.startsWith('--browsers='))
  ?.slice('--browsers='.length)
  .split(',')
  .filter(Boolean);
const names = process.argv.includes('--chromium-only')
  ? ['chromium']
  : (listed ?? Object.keys(engines));
const unknown = names.filter((name) => !Object.hasOwn(engines, name));
if (unknown.length > 0 || names.length === 0) {
  throw new Error(
    `--browsers takes a comma-separated list of ${Object.keys(engines).join(', ')}`
  );
}

// The web app's Vite, run by Node itself so no shell or .cmd shim is involved
// (Windows cannot spawn pnpm's shim without one).
execFileSync(
  process.execPath,
  [
    join(web, 'node_modules/vite/bin/vite.js'),
    'build',
    '--config',
    join(here, 'vite.config.mjs')
  ],
  { stdio: 'inherit', cwd: web }
);

const types = { '.html': 'text/html', '.js': 'text/javascript' };
const server = createServer(async (req, res) => {
  const requested = join(
    dist,
    decodeURIComponent(new URL(req.url, 'http://x').pathname)
  );
  const path = /[\\/]$/.test(requested)
    ? join(requested, 'index.html')
    : requested;
  try {
    const file = await readFile(path);
    res.writeHead(200, {
      'content-type': types[extname(path)] ?? 'application/octet-stream'
    });
    res.end(file);
  } catch {
    res.writeHead(404).end();
  }
});
// 127.0.0.1 is a secure context in every engine, so crypto.subtle exists.
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
for (const name of names) {
  const browser = await engines[name].launch();
  const page = await browser.newPage();
  const started = Date.now();
  await page.goto(`${origin}/`);
  await page.waitForFunction(() => window.cryptoRun?.done, null, {
    timeout: 180_000
  });
  const run = await page.evaluate(() => window.cryptoRun);
  await browser.close();
  const count = (status) =>
    run.results.filter((r) => r.status === status).length;
  failures += count('fail') + (run.error ? 1 : 0);
  console.log(
    `${name} (${run.userAgent}): ${count('pass')} passed, ${count('warn')} warnings, ${count('fail')} failed of ${run.results.length} steps in ${Date.now() - started} ms`
  );
  if (run.error) console.log(`  error: ${run.error}`);
  for (const r of run.results.filter((r) => verbose || r.status !== 'pass'))
    console.log(
      `  ${r.status.toUpperCase()} ${r.suite} › ${r.step}: ${r.detail}`
    );
}
server.close();
process.exit(failures ? 1 : 0);
