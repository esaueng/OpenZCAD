import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('resolves a bounded CI browser pool without relaxing test budgets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'playwright-config-'));
  const report = join(directory, 'report.json');
  try {
    // Ask Playwright to resolve the real configuration and collect a real
    // spec, without starting browsers or the preview server. This catches a
    // worker setting that is ignored or overridden by another config value.
    execFileSync(
      process.execPath,
      [
        resolve('node_modules/@playwright/test/cli.js'),
        'test',
        '--list',
        '--reporter=json',
        'test/e2e/cloud-sync\\.spec\\.ts$'
      ],
      {
        env: {
          ...process.env,
          CI: '1',
          PLAYWRIGHT_JSON_OUTPUT_FILE: report
        },
        timeout: 30_000,
        stdio: 'pipe'
      }
    );
    const { config, suites } = JSON.parse(readFileSync(report, 'utf8'));
    expect(config.workers).toBe(2);
    expect(config.fullyParallel).toBe(true);
    expect(config.projects[0]).toMatchObject({ timeout: 90_000, retries: 2 });
    expect(suites.length).toBeGreaterThan(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 40_000);
