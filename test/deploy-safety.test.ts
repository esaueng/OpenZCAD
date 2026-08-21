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
