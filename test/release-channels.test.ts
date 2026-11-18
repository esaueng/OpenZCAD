import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  OFFICIAL,
  OFFICIAL_STABLE,
  validateDeploymentConfig
} from '../scripts/validate-deployment-config.mjs';
import { gitAt, planPromotion, promote } from '../scripts/promote-stable.mjs';
import { migrationTarget } from '../scripts/apply-beta-migrations.mjs';
import { verificationOrigin } from '../scripts/verify-beta-deployment.mjs';

interface RateLimit {
  name: string;
  namespace_id: string;
  simple: unknown;
}
interface Config {
  name?: string;
  send_email?: unknown;
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
    expect(beta.vars.ACCOUNT_READ_LIMIT_PER_MINUTE).toBe('3000');
    expect(stable.vars.ACCOUNT_READ_LIMIT_PER_MINUTE).toBeUndefined();
    const strip = (config: Config) => {
      const copy = structuredClone(config);
      for (const key of [
        'name',
        'routes',
        'previews',
        'services',
        'd1_databases',
        'r2_buckets',
        'ratelimits',
        'send_email'
      ])
        delete copy[key];
      for (const key of [
        'ACCOUNT_READ_LIMIT_PER_MINUTE',
        'GLIMPSE_BASIC_ENABLED',
        'GLIMPSE_USAGE_ENABLED',
        'PUBLIC_APP_ORIGIN',
        'AUTH_EMAIL_FROM',
        'PROJECT_INVITATION_EMAIL_FROM'
      ])
        delete copy.vars[key];
      return copy;
    };
    expect(strip(stable)).toEqual(strip(beta));
    const limits = (config: Config) =>
      config.ratelimits.map(({ name, simple }) => ({ name, simple }));
    expect(
      beta.ratelimits.find(({ name }) => name === 'ACCOUNT_READ_LIMITER')
        ?.simple
    ).toEqual({ limit: 3000, period: 60 });
    expect(limits(stable)).toEqual(
      limits(beta).map((entry) =>
        entry.name === 'ACCOUNT_READ_LIMITER'
          ? { ...entry, simple: { limit: 1200, period: 60 } }
          : entry
      )
    );
  });

  it('mails sign-in codes and invitations from each channel’s own domain', () => {
    const beta = read('wrangler.jsonc');
    const stable = read('wrangler.stable.jsonc');
    for (const [config, sender] of [
      [beta, 'noreply@beta.zcad.app'],
      [stable, 'noreply@zcad.app']
    ] as const) {
      expect(config.vars.AUTH_EMAIL_FROM).toBe(sender);
      expect(config.vars.PROJECT_INVITATION_EMAIL_FROM).toBe(sender);
      expect(config.send_email).toEqual([
        { name: 'EMAIL', allowed_sender_addresses: [sender] }
      ]);
    }
    const previews = beta.previews as unknown as {
      vars: Record<string, string>;
      send_email: unknown;
    };
    expect(previews.vars.AUTH_EMAIL_FROM).toBe('noreply@beta.zcad.app');
    expect(previews.send_email).toEqual(beta.send_email);

    const crossed = read('wrangler.stable.jsonc');
    crossed.vars.AUTH_EMAIL_FROM = 'noreply@beta.zcad.app';
    expect(validateDeploymentConfig(crossed, options)).toContain(
      'authentication sender changed from the official deployment value'
    );
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
    expect(command).toContain('--origin https://zcad.app');
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
    expect(verificationOrigin([], {})).toBe('https://beta.zcad.app');
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
  const ACTIONS = { GITHUB_ACTIONS: 'true' };

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
      if (command === 'rev-parse' && args[1]!.startsWith('--disambiguate=')) {
        const prefix = args[1]!.slice('--disambiguate='.length);
        return [MAIN, OLD, OFF_MAIN]
          .filter((sha) => sha.startsWith(prefix))
          .join('\n');
      }
      if (command === 'cat-file') return 'commit';
      if (command === 'rev-parse') {
        const ref = args[2]!.replace('^{commit}', '');
        if (ref === 'refs/remotes/origin/stable') return stable;
        throw new Error(`unexpected rev-parse ${ref}`);
      }
      if (command === 'merge-base') {
        const [, , ancestor, descendant] = args;
        const ok =
          (descendant === 'refs/remotes/origin/main' &&
            onMain.includes(ancestor!)) ||
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
    const plan = promote(MAIN, {
      git,
      log: (line) => lines.push(line),
      environment: ACTIONS
    });
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
    expect(
      promote(MAIN, { git: same.git, log: () => {}, environment: ACTIONS })
        .commits
    ).toEqual([]);
    expect(same.calls.some(([command]) => command === 'push')).toBe(false);
  });

  it('pushes only from GitHub Actions; a local run may only dry-run', () => {
    const local = fakeGit();
    expect(() =>
      promote(MAIN, { git: local.git, log: () => {}, environment: {} })
    ).toThrow(/Only the Promote stable workflow/);
    expect(local.calls).toEqual([]);
    promote(MAIN, {
      git: local.git,
      dryRun: true,
      log: () => {},
      environment: {}
    });
    expect(local.calls.some(([command]) => command === 'push')).toBe(false);
  });

  it('takes a commit SHA, never a ref or an option', () => {
    for (const target of ['origin/main', 'stable', '--upload-pack=x', 'abc']) {
      expect(() => planPromotion(target, { git: fakeGit().git })).toThrow(
        /not a commit SHA/
      );
    }
  });

  it('runs from main in the stable-promotion environment, daily or by hand', () => {
    const workflow = readFileSync(
      '.github/workflows/promote-stable.yml',
      'utf8'
    );
    expect(workflow).toMatch(
      /^on:\n {2}schedule:\n {4}# .*\n {4}- cron: '0 10 \* \* \*'\n {2}workflow_dispatch:/m
    );
    // With no commit named, it takes the latest main by full ref name.
    expect(workflow).toContain(
      'COMMIT=$(git rev-parse --verify refs/remotes/origin/main^{commit})'
    );
    expect(workflow).not.toMatch(/^ {2}(push|pull_request\w*|workflow_run):/m);
    expect(workflow).toContain('environment: stable-promotion');
    expect(workflow).toContain(
      'ssh-key: ${{ secrets.STABLE_PROMOTION_DEPLOY_KEY }}'
    );
    expect(workflow).toContain('if [[ "$REF" != refs/heads/main ]]');
    // Run the workflow code the run started at, not main as it is later.
    expect(workflow).toContain('ref: ${{ github.sha }}');
    expect(workflow).not.toMatch(/^\s+ref: main$/m);
    expect(workflow).toContain('node scripts/promote-stable.mjs');
    // Inputs reach the shell through env, never interpolated into a script.
    const inputLines = workflow
      .split('\n')
      .filter((line) => line.includes('${{ inputs.'));
    expect(inputLines.length).toBeGreaterThan(0);
    for (const line of inputLines) {
      expect(line).toMatch(/^\s+[A-Z_]+: \$\{\{ inputs\.\w+ \}\}$/);
    }
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m);
  });

  it('resolves a short SHA by object name, never by a ref that shadows it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'promote-stable-'));
    try {
      const git = gitAt(dir);
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid'
      };
      // Plumbing only: commit-tree and update-ref run no hooks.
      const run = (args: string[]) =>
        execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
      run(['init', '--quiet', '--initial-branch=main']);
      const tree = run(['mktree']);
      const approved = run(['commit-tree', tree, '-m', 'approved']);
      const newer = run(['commit-tree', tree, '-p', approved, '-m', 'newer']);
      run(['update-ref', 'refs/heads/main', newer]);
      run(['remote', 'add', 'origin', '.']);
      const short = approved.slice(0, 12);
      // A tag named like the approved short SHA, pointing at newer code;
      // `git rev-parse <short>` would pick it.
      run(['tag', short, newer]);
      run(['tag', 'origin/main', approved]);
      expect(run(['rev-parse', `${short}^{commit}`])).toBe(newer);

      const plan = planPromotion(short, { git });
      expect(plan.target).toBe(approved);
      expect(plan.current).toBeNull();
      expect(planPromotion(newer, { git }).target).toBe(newer);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires an explicit commit', () => {
    expect(() => planPromotion(undefined, { git: fakeGit().git })).toThrow(
      /Name the commit/
    );
  });
});
