// Serve the built spike page, run both libraries in desktop Chrome and
// Playwright WebKit, optionally collect a real Safari run, and record the
// lazy-chunk sizes. Run from the repository root after build.sh and the
// Vite build:
//   node spikes/mls/web/run-browsers.mjs [--safari] [--rounds 12]
import { execFile } from 'node:child_process';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { chromium, webkit } from '@playwright/test';

const DIST = new URL('./dist/', import.meta.url).pathname;
const RESULTS = new URL('../results/', import.meta.url).pathname;
const args = process.argv.slice(2);
const roundsAt = args.indexOf('--rounds');
const ROUNDS = roundsAt >= 0 ? Number(args[roundsAt + 1]) : 12;
const RUNS = 3; // per browser and library; the first includes cold WASM compile
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm'
};

await mkdir(RESULTS, { recursive: true });

let safariResolve;
const safariResult = new Promise((resolve) => (safariResolve = resolve));

const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/results') {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.end('ok');
    safariResolve(JSON.parse(body));
    return;
  }
  const path = join(
    DIST,
    decodeURIComponent(new URL(req.url, 'http://x').pathname)
  );
  try {
    const file = await readFile(
      path.endsWith('/') ? join(path, 'index.html') : path
    );
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'text/html' });
    res.end(file);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// --- Bundle sizes ---------------------------------------------------------
const assets = await readdir(join(DIST, 'assets'));
const html = await readFile(join(DIST, 'index.html'), 'utf8');
const entry = assets.find((f) => html.includes(f) && f.endsWith('.js'));
const entrySource = await readFile(join(DIST, 'assets', entry), 'utf8');
const files = {};
for (const f of assets) {
  const buf = await readFile(join(DIST, 'assets', f));
  files[f] = {
    raw: buf.length,
    gzip9: gzipSync(buf, { level: 9 }).length,
    brotli11: brotliCompressSync(buf, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
    }).length
  };
}
const bundle = {
  entry,
  entryBytes: files[entry],
  entryReferencesWasm: /\.wasm/.test(entrySource),
  entryReferencesLibraries: /openzcad_mls_spike/.test(entrySource),
  files
};
await writeFile(
  join(RESULTS, 'bundle.json'),
  JSON.stringify(bundle, null, 2) + '\n'
);
console.log(
  'entry',
  entry,
  bundle.entryBytes,
  'wasm in entry:',
  bundle.entryReferencesWasm
);

// --- Browsers -------------------------------------------------------------
const browsers = args.includes('--safari-only')
  ? []
  : [
      ['chrome', () => chromium.launch({ channel: 'chrome' })],
      ['webkit', () => webkit.launch()]
    ];
for (const [name, launch] of browsers) {
  const browser = await launch();
  const page = await browser.newPage();
  await page.goto(`${origin}/`);
  const runs = {};
  for (const lib of ['mls-rs', 'mls-rs-rustcrypto', 'openmls']) {
    runs[lib] = [];
    for (let i = 0; i < RUNS; i++) {
      const result = await page.evaluate(
        ([l, r]) =>
          window.runSpike(l, r).catch((e) => ({ lib: l, error: String(e) })),
        [lib, ROUNDS]
      );
      runs[lib].push(result.summary ?? result);
      if (result.error) console.log(name, lib, result.error);
    }
  }
  const rejoin = {};
  for (const lib of ['mls-rs', 'mls-rs-rustcrypto', 'openmls']) {
    const result = await page.evaluate(
      (l) =>
        window
          .runSpike(l, 0, 'rejoin')
          .catch((e) => ({ lib: l, error: String(e) })),
      lib
    );
    rejoin[lib] = result.report
      ? result.report.steps.map(
          (s) => `${s.ok ? 'pass' : 'FAIL'}: ${s.name} — ${s.detail}`
        )
      : result.error;
    const failed = result.report
      ? result.report.steps.filter((s) => !s.ok).length
      : 'error';
    console.log(name, lib, 'rejoin failures:', failed);
  }
  const out = { browser: name, version: browser.version(), runs, rejoin };
  await writeFile(
    join(RESULTS, `browser-${name}.json`),
    JSON.stringify(out, null, 2) + '\n'
  );
  for (const lib of Object.keys(runs)) {
    const last = runs[lib].at(-1);
    console.log(
      name,
      browser.version(),
      lib,
      JSON.stringify(last.medianMs ?? last),
      last.failedSteps ?? ''
    );
  }
  await browser.close();
}

// --- Real Safari (no automation: open the page, it posts results back) ----
if (args.includes('--safari') || args.includes('--safari-only')) {
  execFile('open', ['-a', 'Safari', `${origin}/?auto=1`]);
  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve(null), 180_000)
  );
  const result = await Promise.race([safariResult, timeout]);
  if (result) {
    await writeFile(
      join(RESULTS, 'browser-safari.json'),
      JSON.stringify(result, null, 2) + '\n'
    );
    for (const r of result.results) {
      console.log(
        'safari',
        r.lib,
        JSON.stringify(r.summary?.medianMs ?? r.error),
        r.summary?.failedSteps ?? ''
      );
    }
  } else {
    console.log('safari: no result within 180 s');
  }
}

server.close();
