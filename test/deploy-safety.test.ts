import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PackageJson {
  scripts?: Record<string, string>;
}

function packageJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
}

/**
 * Reads the `Cache-Control` each rule in the asset `_headers` file sets, keyed
 * by the URL pattern the rule matches. Rules are an unindented path followed by
 * indented `Name: value` lines; blank and `#` lines carry nothing.
 */
function cacheControlByRule(path: string): Map<string, string> {
  const cacheControl = new Map<string, string>();
  let rule: string | null = null;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      rule = line.trim();
      continue;
    }
    const header = line.trim().match(/^cache-control:\s*(.+)$/i);
    if (rule && header) cacheControl.set(rule, header[1]!.trim());
  }
  return cacheControl;
}

describe('beta deployment safety', () => {
  it('applies remote D1 migrations before publishing the Worker', () => {
    const command = packageJson('apps/web/package.json').scripts?.[
      'deploy:beta'
    ];

    expect(command).toBeDefined();
    expect(command).toContain('wrangler d1 migrations apply');
    expect(command).toContain('wrangler deploy');
    expect(command).toContain('verify-beta-deployment.mjs');
    expect(command!.indexOf('wrangler d1 migrations apply')).toBeLessThan(
      command!.indexOf('wrangler deploy')
    );
    expect(command!.indexOf('wrangler deploy')).toBeLessThan(
      command!.indexOf('verify-beta-deployment.mjs')
    );
  });

  it('fails production health when measurement or erasure is unavailable', () => {
    const workflow = readFileSync(
      '.github/workflows/production-health.yml',
      'utf8'
    );

    for (const field of [
      'documentStorageAccountingReady',
      'projectObjectStorageReady',
      'projectMeasurementStorageReady',
      'accountErasureReady',
      'projectErasureReady',
      'projectMeasurementSyncEnabled'
    ]) {
      expect(workflow).toContain(`.${field} == true`);
    }
    expect(workflow).toContain('/api/health?cb=');
  });

  it('keeps the root release command delegated to the guarded web script', () => {
    expect(packageJson('package.json').scripts?.['deploy:beta']).toBe(
      'pnpm --filter @openzcad/web deploy:beta'
    );
    expect(
      packageJson('apps/web/package.json').scripts?.['predeploy:beta']
    ).toContain('--target official');
  });

  it('keeps self-hosting on an explicit local configuration', () => {
    const scripts = packageJson('package.json').scripts;

    expect(scripts?.['selfhost:check']).toContain(
      '--config wrangler.selfhost.jsonc --target selfhost'
    );
    expect(scripts?.['deploy:selfhost']).toContain(
      'wrangler d1 migrations apply DB --remote --config ../../wrangler.selfhost.jsonc'
    );
    expect(scripts?.['deploy:selfhost']).toContain(
      'wrangler deploy --config ../../wrangler.selfhost.jsonc'
    );
  });

  it('opens all collaboration capabilities to authenticated beta accounts', () => {
    const config = readFileSync('wrangler.jsonc', 'utf8');

    expect(config).toContain('"PROJECT_SHARING_ENABLED": "true"');
    expect(config).toContain('"PROJECT_EDIT_LEASES_ENFORCED": "true"');
    expect(config).toContain('"PROJECT_PERSONAL_SYNC_ENABLED": "true"');
  });

  it('caches only fingerprinted assets beyond a revalidation', () => {
    // Vite emits every fingerprinted file into /assets/, so only that prefix
    // may carry a lifetime: any other URL is stable across builds and would
    // strand clients on a superseded file. index.html is the one that matters,
    // since it names the hashed bundles a client should be loading.
    const rules = cacheControlByRule('apps/web/public/_headers');

    expect(rules.get('/assets/*')).toBe('public, max-age=31536000, immutable');
    for (const [rule, value] of rules) {
      if (rule === '/assets/*') continue;
      expect(value).not.toMatch(/immutable|max-age=[1-9]/i);
    }
  });

  it('ships baseline security headers on every served path', () => {
    const text = readFileSync('apps/web/public/_headers', 'utf8');
    const lines = text.split('\n');
    const catchAll = lines.findIndex((line) => line.trim() === '/*');
    expect(catchAll).toBeGreaterThanOrEqual(0);
    const ruleLines = lines
      .slice(catchAll + 1)
      .filter((line) => /^\s+\S/.test(line));
    const headers = new Map(
      ruleLines.map((line) => {
        const [name, ...value] = line.trim().split(':');
        return [name!.toLowerCase(), value.join(':').trim()];
      })
    );

    const csp = headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('referrer-policy')).toBe(
      'strict-origin-when-cross-origin'
    );
  });

  it('uses the onboarded noreply sender for authentication and project invitations', () => {
    const config = readFileSync('wrangler.jsonc', 'utf8');

    expect(config).toContain('"AUTH_EMAIL_FROM": "noreply@zcad.esau.app"');
    expect(config).toContain(
      '"PROJECT_INVITATION_EMAIL_FROM": "noreply@zcad.esau.app"'
    );
    expect(config).toContain('"PUBLIC_APP_ORIGIN": "https://zcad.app"');
    expect(config).toMatch(
      /"allowed_sender_addresses":\s*\[\s*"noreply@zcad\.esau\.app"\s*\]/
    );
  });
});

/**
 * Guards that exist so a green check means what a human reads it to mean.
 * Both defend gates rather than product behaviour, so nothing else fails when
 * they regress — which is exactly why they need a test of their own.
 */
describe('CI gates cannot silently stop testing', () => {
  it('forbids test.only in CI so a shard cannot report green on one test', () => {
    // Playwright's focus is run-wide, not file-wide: one stray `test.only`
    // makes all four shards run that single test, three run zero, every shard
    // exits 0, and the `e2e` aggregate prints green having exercised 1 of 161.
    // Root Vitest is safe by default (`allowOnly` defaults to `!CI`).
    expect(readFileSync('playwright.config.ts', 'utf8')).toMatch(
      /forbidOnly:\s*!!process\.env\.CI/
    );
  });

  it('refuses a geometry kernel bump that rides along with another change', () => {
    // `remus-wasm` is a production dependency on a moving branch, so ANY
    // lockfile regeneration re-resolves it — it has landed on main four times
    // inside unrelated dependency PRs. `update-remus.yml` refuses a diff that
    // touches anything but the lockfile precisely so a kernel change gets its
    // own parity-tested review; without this guard, a Dependabot bump bypasses
    // that entirely and no commit message mentions the kernel.
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(ci).toContain('Refuse an unannounced geometry kernel bump');
    expect(ci).toContain('automation/remus-');
    // The default checkout is shallow, so the guard has to fetch the one base
    // commit it compares against or it silently compares nothing.
    expect(ci).toMatch(/git fetch --no-tags --depth=1 origin "\$BASE_REF"/);
    // A guard that reads nothing and passes is the failure this repo already
    // names elsewhere, and the first CI run of this one passed in silence. It
    // has to refuse an empty baseline and say what it compared.
    expect(ci).toContain('Kernel baseline missing');
    expect(ci).toContain('Kernel pin unchanged at $head.');
  });

  it('keeps the kernel resolved to exactly one commit', () => {
    // Two different resolutions in one lockfile would mean two kernels in one
    // build, and the guard above compares a single SHA.
    const shas = new Set(
      Array.from(
        readFileSync('pnpm-lock.yaml', 'utf8').matchAll(
          /codeload\.github\.com\/esaueng\/remus\/tar\.gz\/([0-9a-f]{40})/g
        ),
        (match) => match[1]
      )
    );
    expect(shas.size).toBe(1);
  });
});

/**
 * The repo's own orientation documents, checked against the code they
 * describe.
 *
 * AGENTS.md points contributors and agents at `architecture.md` and `TODO.md`
 * first, so a wrong number there is read as fact and reasoned from. Both had
 * drifted badly: the schema version was recorded as v6 and v8 while the
 * constant said 13, and `architecture.md` said sharing and lease enforcement
 * were disabled in checked-in configuration while the deployed `wrangler.jsonc`
 * enabled both. Nothing failed when they drifted, which is why they did.
 */
describe('documented facts match the code', () => {
  const read = (path: string) => readFileSync(path, 'utf8');

  it('names the schema version the code actually declares', () => {
    const declared = /PROJECT_DOCUMENT_SCHEMA_VERSION = (\d+)/.exec(
      read('packages/shared/src/index.ts')
    )?.[1];
    expect(declared).toBeDefined();

    for (const path of ['architecture.md', 'TODO.md']) {
      const claimed = Array.from(
        read(path).matchAll(/schema[- ]v(\d+)/gi),
        (match) => match[1]
      );
      // A doc may mention older schema versions in historical context; what it
      // must not do is name a *current* version that is not the current one.
      expect(claimed, path).toContain(declared);
    }
  });

  it('does not claim sharing is disabled while the deployment enables it', () => {
    const config = read('wrangler.jsonc');
    const sharingEnabled = /"PROJECT_SHARING_ENABLED":\s*"true"/.test(config);
    const architecture = read('architecture.md');
    if (sharingEnabled) {
      expect(architecture).not.toMatch(
        /[Ss]haring and lease\s+enforcement remain disabled/
      );
    }
  });

  it('states the import ceiling the code enforces', () => {
    const bytes = /MAX_SOURCE_IMPORT_BYTES = (\d+) \* 1024 \* 1024/.exec(
      read('apps/web/src/lib/stepImportRun.ts')
    )?.[1];
    expect(bytes).toBeDefined();
    const megabytes = `${bytes} MB`;
    // The refusal message used to say 250 MB against a 128 MB cap, so a file
    // was rejected by a sentence saying it was allowed.
    for (const path of ['README.md', 'architecture.md']) {
      expect(read(path), path).toContain(megabytes);
    }
  });
});
