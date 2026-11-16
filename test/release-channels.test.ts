import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  OFFICIAL,
  OFFICIAL_STABLE,
  validateDeploymentConfig
} from '../scripts/validate-deployment-config.mjs';
import { planPromotion, promote } from '../scripts/promote-stable.mjs';
import { migrationTarget } from '../scripts/apply-beta-migrations.mjs';
import { verificationOrigin } from '../scripts/verify-beta-deployment.mjs';

interface RateLimit {
  name: string;
  namespace_id: string;
  simple: unknown;
}
interface Config {
  name?: string;
  vars: Record<string, string>;
  ratelimits: RateLimit[];
  services?: { binding: string; service: string }[];
  d1_databases: {
    binding: string;
    database_name: string;
    database_id: string;
  }[];
  r2_buckets: { binding: string; bucket_name: string }[];
  previews?: { ratelimits?: RateLimit[] } & Record<string, unknown>;
  [key: string]: unknown;
}

function read(path: string): Config {
  return ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8'))
    .config as Config;
}

const options = {
  target: 'stable' as const,
  originUrl: 'https://github.com/esaueng/OpenZCAD.git',
  configOnly: true,
  betaConfig: read('wrangler.jsonc')
};

describe('stable channel configuration', () => {
  it('validates the shipped stable config, and only for its own target', () => {
    const stable = read('wrangler.stable.jsonc');
    expect(validateDeploymentConfig(stable, options)).toEqual([]);
    expect(
      validateDeploymentConfig(stable, { ...options, target: 'official' })
    ).toContain('Worker name changed from the official deployment value');
    expect(validateDeploymentConfig(read('wrangler.jsonc'), options)).toContain(
      'Worker name changed from the official deployment value'
    );
  });

  it('matches beta except for the differences a channel needs', () => {
    const beta = read('wrangler.jsonc');
    const stable = read('wrangler.stable.jsonc');
    const strip = (config: Config) => {
      const copy = structuredClone(config);
      for (const key of [
        'name',
        'routes',
        'previews',
        'services',
        'd1_databases',
        'r2_buckets',
        'ratelimits'
      ])
        delete copy[key];
      for (const key of [
        'GLIMPSE_BASIC_ENABLED',
        'GLIMPSE_USAGE_ENABLED',
        'PUBLIC_APP_ORIGIN'
      ])
        delete copy.vars[key];
      return copy;
    };
    expect(strip(stable)).toEqual(strip(beta));
    const limits = (config: Config) =>
      config.ratelimits.map(({ name, simple }) => ({ name, simple }));
    expect(limits(stable)).toEqual(limits(beta));
  });

  it('shares no data, rate-limit budget or analytics with beta', () => {
    const beta = read('wrangler.jsonc');
    const stable = read('wrangler.stable.jsonc');
    const ids = (config: Config) =>
      new Set(
        [...config.ratelimits, ...(config.previews?.ratelimits ?? [])].map(
          (limit: { namespace_id: string }) => limit.namespace_id
        )
      );
    const betaIds = ids(beta);
    for (const id of ids(stable)) expect(betaIds.has(id), id).toBe(false);
    expect(stable.d1_databases[0]!.database_id).not.toBe(OFFICIAL.databaseId);
    expect(stable.r2_buckets[0]!.bucket_name).not.toBe(OFFICIAL.bucketName);
    expect(stable.services).toBeUndefined();
    expect(stable.vars.GLIMPSE_BASIC_ENABLED).toBe('false');
    expect(stable.vars.GLIMPSE_USAGE_ENABLED).toBe('false');
  });

  it('refuses beta resources, Previews and a foreign origin on stable', () => {
    const stable = read('wrangler.stable.jsonc');
    stable.d1_databases[0]!.database_id = OFFICIAL.databaseId;
    stable.d1_databases[0]!.database_name = OFFICIAL.databaseName;
    stable.previews = {};
    stable.vars.PUBLIC_APP_ORIGIN = 'https://beta.zcad.app';
    expect(validateDeploymentConfig(stable, options)).toEqual(
      expect.arrayContaining([
        'D1 database ID changed from the official deployment value',
        `public origin must be one of ${OFFICIAL_STABLE.publicOrigins.join(', ')}`,
        'stable must not define previews; Previews belong to beta',
        'stable references a beta resource'
      ])
    );
  });

  it('refuses beta analytics and rate-limit budgets on stable', () => {
    const beta = read('wrangler.jsonc');
    const stable = read('wrangler.stable.jsonc');
    stable.services = beta.services;
    stable.ratelimits = beta.ratelimits;
    stable.vars.GLIMPSE_BASIC_ENABLED = 'true';
    stable.vars.GLIMPSE_USAGE_ENABLED = 'true';
    const errors = validateDeploymentConfig(stable, options);
    expect(errors).toEqual(
      expect.arrayContaining([
        "stable service binding GLIMPSE would share beta's",
        'vars.GLIMPSE_BASIC_ENABLED must be off on stable until the cutover',
        'vars.GLIMPSE_USAGE_ENABLED must be off on stable until the cutover',
        `stable rate limit ${beta.ratelimits[0]!.name} shares beta namespace ${beta.ratelimits[0]!.namespace_id}`
      ])
    );
    const { betaConfig: _beta, ...withoutBeta } = options;
    expect(
      validateDeploymentConfig(read('wrangler.stable.jsonc'), withoutBeta)
    ).toEqual([
      'stable validation needs the beta config (wrangler.jsonc) to compare rate-limit namespaces'
    ]);
  });

  it('deploys stable from the stable branch only', () => {
    const stable = read('wrangler.stable.jsonc');
    expect(
      validateDeploymentConfig(stable, {
        target: 'stable',
        originUrl: 'https://github.com/esaueng/OpenZCAD.git',
        betaConfig: read('wrangler.jsonc'),
        environment: {
          GITHUB_ACTIONS: 'true',
          GITHUB_REPOSITORY: 'esaueng/OpenZCAD',
          GITHUB_REF: 'refs/heads/main'
        }
      })
    ).toContain(
      'official deployment is not allowed from GitHub ref refs/heads/main'
    );
  });

  it('keeps self-hosting and dev configs off stable resources', () => {
    const dev = read('apps/web/wrangler.jsonc');
    dev.d1_databases[0]!.database_id = OFFICIAL_STABLE.databaseId;
    expect(validateDeploymentConfig(dev, { target: 'dev' })).toContain(
      'Development configuration references an official resource.'
    );
  });

  it('deploys stable with its own migrations, config and origin', () => {
    const { scripts } = JSON.parse(
      readFileSync('apps/web/package.json', 'utf8')
    ) as { scripts: Record<string, string> };
    const command = scripts['deploy:stable']!;
    expect(scripts['predeploy:stable']).toContain(
      '--config ../../wrangler.stable.jsonc --target stable'
    );
    expect(command).toContain(
      'apply-beta-migrations.mjs --database openzcad-stable --config ../../wrangler.stable.jsonc && wrangler deploy --config ../../wrangler.stable.jsonc'
    );
    expect(command).toContain('--origin https://stable.zcad.app');
    expect(command).not.toMatch(
      /openzcad-beta\b|--config \.\.\/\.\.\/wrangler\.jsonc/
    );
  });
});

describe('deploy script flags', () => {
  it('migrates beta by default and stable only when both flags name it', () => {
    expect(migrationTarget([])).toEqual({
      database: 'openzcad-beta',
      config: '../../wrangler.jsonc'
    });
    expect(
      migrationTarget([
        '--database',
        'openzcad-stable',
        '--config',
        '../../wrangler.stable.jsonc'
      ])
    ).toEqual({
      database: 'openzcad-stable',
      config: '../../wrangler.stable.jsonc'
    });
  });

  it.each([
    [
      ['--database=openzcad-stable', '--config=../../wrangler.stable.jsonc'],
      /Unknown argument/
    ],
    [['--database'], /needs a value/],
    [['--database', '--config', 'x'], /needs a value/],
    [['--database', 'openzcad-stable'], /together, or neither/],
    [['--database', 'a', '--database', 'b', '--config', 'c'], /given twice/]
  ])('refuses %j instead of falling back to beta', (argv, message) => {
    expect(() => migrationTarget(argv)).toThrow(message);
  });

  it('verifies the named origin and refuses a malformed one', () => {
    expect(verificationOrigin([], {})).toBe('https://zcad.app');
    expect(
      verificationOrigin(['--origin', 'https://stable.zcad.app'], {})
    ).toBe('https://stable.zcad.app');
    expect(() =>
      verificationOrigin(['--origin=https://stable.zcad.app'], {})
    ).toThrow(/Unknown argument/);
    expect(() =>
      verificationOrigin(['--origin', 'stable.zcad.app'], {})
    ).toThrow(/https origin/);
  });
});

describe('stable promotion', () => {
  const MAIN = 'a'.repeat(40);
  const OLD = 'b'.repeat(40);
  const OFF_MAIN = 'c'.repeat(40);

  function fakeGit({
    stable = OLD,
    onMain = [MAIN, OLD],
    ancestry = [[OLD, MAIN]] as [string, string][]
  } = {}) {
    const calls: string[][] = [];
    const git = vi.fn((args: string[], opts?: { allowFailure?: boolean }) => {
      calls.push(args);
      const [command] = args;
      if (command === 'fetch') return '';
      if (command === 'rev-parse') {
        const ref = args[2]!.replace('^{commit}', '');
        if (ref === 'origin/stable') return stable;
        return [MAIN, OLD, OFF_MAIN].includes(ref) ? ref : null;
      }
      if (command === 'merge-base') {
        const [, , ancestor, descendant] = args;
        const ok =
          (descendant === 'origin/main' && onMain.includes(ancestor!)) ||
          ancestry.some(([a, d]) => a === ancestor && d === descendant);
        if (!ok && opts?.allowFailure) return null;
        return '';
      }
      if (command === 'log') return 'aaaaaaa feat: newer\nddddddd fix: older';
      if (command === 'diff') return 'apps/web/migrations/0058_new.sql';
      if (command === 'push') return '';
      throw new Error(`unexpected git ${args.join(' ')}`);
    });
    return { git, calls };
  }

  it('fast-forwards to a commit on main and lists the migrations it applies', () => {
    const { git, calls } = fakeGit();
    const lines: string[] = [];
    const plan = promote(MAIN, { git, log: (line) => lines.push(line) });
    expect(plan.migrations).toEqual(['apps/web/migrations/0058_new.sql']);
    expect(lines.join('\n')).toContain('0058_new.sql');
    expect(calls).toContainEqual([
      'push',
      'origin',
      `${MAIN}:refs/heads/stable`
    ]);
  });

  it('refuses a commit that is not on main', () => {
    const { git } = fakeGit();
    expect(() => planPromotion(OFF_MAIN, { git })).toThrow(
      /not on origin\/main/
    );
  });

  it('refuses anything but a fast-forward', () => {
    const { git } = fakeGit({ ancestry: [] });
    expect(() => planPromotion(MAIN, { git })).toThrow(/only fast-forwards/);
  });

  it('pushes nothing on a dry run or when stable is already there', () => {
    const dry = fakeGit();
    promote(MAIN, { git: dry.git, dryRun: true, log: () => {} });
    expect(dry.calls.some(([command]) => command === 'push')).toBe(false);
    const same = fakeGit({ stable: MAIN });
    expect(promote(MAIN, { git: same.git, log: () => {} }).commits).toEqual([]);
    expect(same.calls.some(([command]) => command === 'push')).toBe(false);
  });

  it('requires an explicit commit', () => {
    expect(() => planPromotion(undefined, { git: fakeGit().git })).toThrow(
      /Name the commit/
    );
  });
});
