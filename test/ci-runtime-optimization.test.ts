import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  chmodSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { selectDependencyAudits } from '../scripts/dependency-audit-selection.mjs';
import { bashExecutable } from './support/testTools';

const staged = readFileSync('.github/workflows/fleet-ci-v8.yml', 'utf8');
const jobs = Object.fromEntries(
  [
    ...staged
      .split('\njobs:\n')[1]!
      .matchAll(/^ {2}([\w-]+):\n(.*?)(?=^ {2}[\w-]+:\n|(?![\s\S]))/gms)
  ].map((match) => [match[1]!, match[2]!])
);
const script = (job: string, name: string) => {
  const section = jobs[job]!.split(`      - name: ${name}\n`)[1]!;
  const body = section.split('        run: |\n')[1]!;
  return body.split(/\n(?= {0,8}\S)/)[0]!.replace(/^ {10}/gm, '');
};
const shell = (source: string, env: Record<string, string>) =>
  spawnSync(bashExecutable(), ['-e', '-o', 'pipefail', '-c', source], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });

describe('CI runtime optimizations preserve required coverage', () => {
  it('keeps the kernel declaration in the preflight and gates every application job on it', () => {
    expect(jobs.plan).toContain('node scripts/kernel-pin-declaration.mjs');
    expect(jobs.plan!.indexOf('kernel-pin-declaration.mjs')).toBeLessThan(
      jobs.plan!.indexOf('node scripts/ci-selection.mjs')
    );
    for (const job of [
      'quality',
      'typecheck',
      'unit',
      'validation',
      'e2e-tests',
      'e2e-tests-pr',
      'e2e-queue'
    ]) {
      expect(jobs[job]).toContain("needs.plan.result == 'success'");
      expect(jobs[job]).toContain('queue-trust, plan');
    }
    expect(jobs.unit).toContain('shard: [1, 2]');
    expect(jobs.validation).toContain('pnpm test:parity-corpus');
    expect(jobs.validation).toContain('run: pnpm build');
  });

  it('executes the validation gate against failure, cancellation, skipped and missing results', () => {
    const source = script('validate', 'Require all validation checks');
    const success = Object.fromEntries(
      ['QUALITY', 'PLAN', 'TYPECHECK', 'UNIT', 'VALIDATION'].map((name) => [
        `${name}_RESULT`,
        'success'
      ])
    );
    expect(shell(source, success).status).toBe(0);
    for (const name of Object.keys(success)) {
      for (const result of ['failure', 'cancelled', 'skipped', ''])
        expect(shell(source, { ...success, [name]: result }).status).not.toBe(
          0
        );
    }
  });

  it('requires executed browser coverage on a queue candidate and preserves its artifacts', () => {
    const source = script('e2e', 'Require one green shard set');
    const candidate = {
      EVENT_NAME: 'merge_group',
      PLAN_RESULT: 'success',
      DIRECT_RESULT: 'skipped',
      PR_RESULT: 'skipped',
      QUEUE_RESULT: 'success'
    };
    expect(shell(source, candidate).status).toBe(0);
    for (const result of ['failure', 'cancelled', 'skipped', ''])
      expect(
        shell(source, { ...candidate, QUEUE_RESULT: result }).status
      ).not.toBe(0);
    expect(
      shell(source, { ...candidate, PLAN_RESULT: 'failure' }).status
    ).not.toBe(0);
    expect(jobs['e2e-queue']).toContain('--reporter=dot,json');
    expect(jobs['e2e-queue']).toContain('e2e-queue-report');
    expect(staged).toContain(
      "retention-days: ${{ job.status == 'success' && 7 || 14 }}"
    );
  });
});

describe('dependency audits select inputs without suppressing new advisory checks', () => {
  it('runs complete validation when the real CLI cannot read its comparison history', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ci-history-fallback-'));
    try {
      const event = join(directory, 'event.json');
      writeFileSync(
        event,
        JSON.stringify({
          pull_request: {
            base: { sha: 'f'.repeat(40) },
            labels: []
          }
        })
      );
      for (const [file, expected] of [
        ['scripts/ci-selection.mjs', ['unit=full', 'e2e=full']],
        [
          'scripts/dependency-audit-selection.mjs',
          ['javascript=true', 'rust=true']
        ]
      ] as const) {
        const result = spawnSync(process.execPath, [file], {
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_DIR: join(directory, 'missing'),
            GITHUB_EVENT_PATH: event,
            GITHUB_EVENT_NAME: 'pull_request',
            GITHUB_OUTPUT: join(directory, 'outputs')
          }
        });
        expect(result.status, result.stderr).toBe(0);
        for (const value of expected) expect(result.stdout).toContain(value);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps complete scheduled/manual and unavailable-input audits', () => {
    for (const event of ['schedule', 'workflow_dispatch', 'unknown'])
      expect(selectDependencyAudits(['docs/notes.md'], event)).toEqual({
        javascript: true,
        rust: true
      });
    expect(selectDependencyAudits(undefined, 'push')).toEqual({
      javascript: true,
      rust: true
    });
    expect(selectDependencyAudits([], 'pull_request')).toEqual({
      javascript: true,
      rust: true
    });
  });

  it('separates JS dependency changes from Rust and native regression inputs', () => {
    for (const event of ['push', 'pull_request']) {
      expect(selectDependencyAudits(['pnpm-lock.yaml'], event)).toEqual({
        javascript: true,
        rust: false
      });
      expect(
        selectDependencyAudits(['packages/shared/package.json'], event)
      ).toEqual({ javascript: true, rust: false });
      for (const path of [
        'apps/desktop/src-tauri/Cargo.lock',
        'apps/desktop/device-keys/src/lib.rs',
        'apps/desktop/glib-regression/src/lib.rs',
        'apps/desktop/src-tauri/vendor/glib/src/lib.rs',
        '.cargo/config.toml'
      ])
        expect(selectDependencyAudits([path], event)).toEqual({
          javascript: false,
          rust: true
        });
      expect(
        selectDependencyAudits(
          ['pnpm-lock.yaml', 'apps/desktop/src-tauri/Cargo.toml'],
          event
        )
      ).toEqual({ javascript: true, rust: true });
      expect(
        selectDependencyAudits(['scripts/install-cargo-audit.sh'], event)
      ).toEqual({ javascript: true, rust: true });
    }
  });

  it('retains daily advisory checks and installs a fixed release without disabling DB refresh', () => {
    const audit = readFileSync(
      '.github/workflows/dependency-audit.yml',
      'utf8'
    );
    expect(audit).toContain("cron: '41 8 * * *'");
    expect(audit).toContain('bash scripts/install-cargo-audit.sh');
    expect(audit).not.toContain('cargo install cargo-audit');
    expect(audit).not.toMatch(/--no-fetch|--ignore|continue-on-error/);
    expect(audit).toContain(
      'cargo audit --file apps/desktop/src-tauri/Cargo.lock'
    );
    expect(audit).toContain(
      'cargo audit --file apps/desktop/device-keys/Cargo.lock'
    );
    expect(
      readFileSync('.github/workflows/dependency-review.yml', 'utf8')
    ).toContain('fail-on-severity: high');
  });

  it('refuses a corrupt downloaded tool before extraction or PATH publication', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cargo-audit-refusal-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const stub = (name: string, body: string) => {
        const path = join(bin, name);
        writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
        chmodSync(path, 0o755);
      };
      stub(
        'uname',
        'if [[ "$1" == -s ]]; then echo Linux; else echo x86_64; fi'
      );
      stub(
        'curl',
        'while [[ "$1" != --output ]]; do shift; done; printf corrupt > "$2"'
      );
      stub('sha256sum', 'cat > "$RUNNER_TEMP/check-request"; exit 1');
      stub('tar', 'touch "$RUNNER_TEMP/extracted"; exit 1');
      const result = spawnSync(
        bashExecutable(),
        [resolve('scripts/install-cargo-audit.sh')],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
            RUNNER_TEMP: dir,
            GITHUB_PATH: join(dir, 'paths')
          }
        }
      );
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(dir, 'check-request'), 'utf8')).toContain(
        'ab28a1bdb54db4d5d8ad5981cf1f959410370b3d28250dbd35f6a44248620e39'
      );
      expect(
        spawnSync(
          bashExecutable(),
          [
            '-c',
            'test ! -e "$RUNNER_TEMP/extracted" && test ! -e "$GITHUB_PATH"'
          ],
          {
            env: {
              ...process.env,
              RUNNER_TEMP: dir,
              GITHUB_PATH: join(dir, 'paths')
            }
          }
        ).status
      ).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
