import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import {
  isE2eeKeysEnabled,
  isE2eeProjectsEnabled,
  isE2eeMigrationEnabled,
  type CloudflareEnv
} from '@openzcad/cloudflare-adapters';

function officialEnv(): CloudflareEnv {
  const config = ts.parseConfigFileTextToJson(
    'wrangler.jsonc',
    readFileSync('wrangler.jsonc', 'utf8')
  ).config as { vars: CloudflareEnv };
  return config.vars;
}

it('offers opt-in encryption to every authenticated beta account without a canary selection', () => {
  const env = { ...officialEnv(), E2EE_CANARY_EMAILS: undefined };
  expect(env.E2EE_KEYS_ENABLED).toBe('true');
  expect(env.E2EE_PROJECTS_ENABLED).toBe('true');
  expect(env.E2EE_MIGRATION_ENABLED).toBe('true');
  expect(env.E2EE_DEFAULT_ON).toBe('false');
  expect(env.E2EE_PLAINTEXT_FROZEN).toBe('false');
  expect(env.E2EE_REVERSE_ENABLED).toBe('false');
  for (const email of ['cohort@example.test', 'outside@example.test']) {
    expect(isE2eeKeysEnabled(env, email)).toBe(true);
    expect(isE2eeProjectsEnabled(env, email)).toBe(true);
    expect(isE2eeMigrationEnabled(env, email)).toBe(true);
  }
});

it('retains the private account selection when global keys are closed again', () => {
  const env: CloudflareEnv = {
    ...officialEnv(),
    E2EE_KEYS_ENABLED: 'false',
    E2EE_CANARY_EMAILS: 'cohort@example.test'
  };
  expect(env.E2EE_KEYS_ENABLED).toBe('false');
  expect(env.E2EE_DEFAULT_ON).toBe('false');
  expect(env.E2EE_PLAINTEXT_FROZEN).toBe('false');
  expect(env.E2EE_REVERSE_ENABLED).toBe('false');
  for (const email of [undefined, '', 'outside@example.test']) {
    expect(isE2eeKeysEnabled(env, email)).toBe(false);
    expect(isE2eeProjectsEnabled(env, email)).toBe(false);
    expect(isE2eeMigrationEnabled(env, email)).toBe(false);
  }
  expect(isE2eeProjectsEnabled(env, 'cohort@example.test')).toBe(true);
  expect(isE2eeMigrationEnabled(env, 'cohort@example.test')).toBe(true);
  const withoutSelection = { ...env, E2EE_CANARY_EMAILS: undefined };
  expect(isE2eeKeysEnabled(withoutSelection, 'cohort@example.test')).toBe(
    false
  );
});
