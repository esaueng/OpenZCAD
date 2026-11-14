import { describe, expect, it } from 'vitest';
import {
  accountEntitlements,
  accountTier,
  syncStoredAccountLimits
} from '@openzcad/cloudflare-adapters';
import { d1Database, migratedDatabase } from './d1-sqlite';
import { deploymentAssistantAllowed } from '../apps/web/worker/settings';

const env = {
  PREMIUM_USER_EMAILS:
    ' first@example.com,SECOND@example.com, ,first@example.com '
};

describe('server account tier policy', () => {
  it('defaults to Free and requires exact normalized authenticated emails', () => {
    expect(accountTier({}, 'first@example.com')).toBe('free');
    for (const email of [
      undefined,
      '',
      ' ',
      'other@example.com',
      'first@example.com.attacker.test',
      'first+alias@example.com'
    ]) {
      expect(accountTier(env, email)).toBe('free');
    }
    expect(accountTier(env, ' FIRST@EXAMPLE.COM ')).toBe('premium');
    expect(accountTier(env, 'second@example.com')).toBe('premium');
    expect(accountTier({ PREMIUM_USER_EMAILS: '*' }, 'any@example.com')).toBe(
      'free'
    );
  });

  it('returns finite effective limits without disclosing the membership list', () => {
    // One storage bucket per account: Free 100 MiB in total, not 100 MiB each.
    expect(accountEntitlements(env, 'other@example.com')).toEqual({
      tier: 'free',
      projectLimit: 100,
      storageLimitBytes: 100 * 1024 ** 2,
      projectStorageLimitBytes: 100 * 1024 ** 2,
      artifactLimitBytes: 100 * 1024 ** 2,
      ai: {
        requestLimit: 6,
        costLimitUnits: 24,
        concurrencyLimit: 2,
        windowSeconds: 600
      }
    });
    // Premium: 1 GiB for everything, in the same one bucket.
    expect(accountEntitlements(env, 'first@example.com')).toEqual({
      tier: 'premium',
      projectLimit: 10_000,
      storageLimitBytes: 1024 ** 3,
      projectStorageLimitBytes: 1024 ** 3,
      artifactLimitBytes: 1024 ** 3,
      ai: {
        requestLimit: 600,
        costLimitUnits: 2400,
        concurrencyLimit: 8,
        windowSeconds: 600
      }
    });
    expect(
      accountEntitlements(
        {
          ...env,
          PREMIUM_ARTIFACT_LIMIT_BYTES: '-1',
          AI_PREMIUM_ACCOUNT_RATE_LIMIT_REQUESTS: 'Infinity'
        },
        'first@example.com'
      ).ai.requestLimit
    ).toBe(600);
    expect(
      accountEntitlements(
        { ...env, PREMIUM_ARTIFACT_LIMIT_BYTES: '8192' },
        'first@example.com'
      ).artifactLimitBytes
    ).toBe(8192);
  });

  it('takes one Premium storage override, the legacy names only when it is unset', () => {
    const premium = (overrides: Record<string, string>) =>
      accountEntitlements({ ...env, ...overrides }, 'first@example.com');
    const unified = premium({
      PREMIUM_STORAGE_LIMIT_BYTES: '4096',
      PREMIUM_PROJECT_STORAGE_LIMIT_BYTES: '8192',
      PREMIUM_ARTIFACT_LIMIT_BYTES: '16384'
    });
    expect(unified).toMatchObject({
      storageLimitBytes: 4096,
      projectStorageLimitBytes: 4096,
      artifactLimitBytes: 4096
    });
    expect(
      premium({
        PREMIUM_PROJECT_STORAGE_LIMIT_BYTES: '8192',
        PREMIUM_ARTIFACT_LIMIT_BYTES: '16384'
      }).storageLimitBytes
    ).toBe(8192);
    expect(
      premium({ PREMIUM_ARTIFACT_LIMIT_BYTES: '16384' }).storageLimitBytes
    ).toBe(16384);
    // Free never reads a Premium override.
    expect(
      accountEntitlements(
        { ...env, PREMIUM_STORAGE_LIMIT_BYTES: '4096' },
        'other@example.com'
      ).storageLimitBytes
    ).toBe(100 * 1024 ** 2);
  });

  it('grants premium hosted AI access while retaining the existing Free allowlist', () => {
    expect(deploymentAssistantAllowed('first@example.com', env)).toBe(true);
    expect(deploymentAssistantAllowed('other@example.com', env)).toBe(false);
    expect(
      deploymentAssistantAllowed('other@example.com', {
        ...env,
        AI_DEPLOYMENT_ALLOWED_EMAILS: 'other@example.com'
      })
    ).toBe(true);
    expect(deploymentAssistantAllowed('first@example.com', {})).toBe(false);
  });

  it('opens an opted-in free OpenRouter deployment to every verified account', () => {
    const freeEnv = {
      AI_PROVIDER: 'openrouter' as const,
      AI_MODEL: 'minimax/minimax-m3.1-flash:free',
      AI_DEPLOYMENT_FREE_ENABLED: 'true',
      OPENROUTER_API_KEY: 'test-key'
    };
    expect(deploymentAssistantAllowed('anyone@example.com', freeEnv)).toBe(
      true
    );
    expect(deploymentAssistantAllowed(undefined, freeEnv)).toBe(false);
    expect(deploymentAssistantAllowed(' ', freeEnv)).toBe(false);
    for (const overrides of [
      { AI_DEPLOYMENT_FREE_ENABLED: 'false' },
      { AI_MODEL: 'minimax/minimax-m3.1-flash' },
      { AI_MODEL: 'openrouter/auto' },
      { AI_PROVIDER: 'openai' as const },
      { AI_BASE_URL: 'https://openrouter.ai/api/v1/responses' }
    ]) {
      expect(
        deploymentAssistantAllowed('anyone@example.com', {
          ...freeEnv,
          ...overrides
        })
      ).toBe(false);
    }
  });
});

describe('stored account limit sync', () => {
  it('brings every stored limit to the current tier policy, Premium by email', async () => {
    const sqlite = migratedDatabase();
    const insert = sqlite.prepare(
      `INSERT INTO users (id, email, created_at, artifact_limit_bytes,
         project_limit, project_storage_limit_bytes)
       VALUES (?, ?, '2026-01-01T00:00:00.000Z', ?, ?, ?)`
    );
    // Written under the old defaults (2 GiB Free, 100 GiB Premium).
    insert.run(
      'user_free',
      'other@example.com',
      2 * 1024 ** 3,
      100,
      2 * 1024 ** 3
    );
    insert.run('user_none', null, 2 * 1024 ** 3, 100, 2 * 1024 ** 3);
    insert.run(
      'user_premium',
      'Second@Example.com',
      100 * 1024 ** 3,
      10_000,
      100 * 1024 ** 3
    );
    await syncStoredAccountLimits(env, d1Database(sqlite));
    const limits = (id: string) =>
      sqlite
        .prepare(
          'SELECT artifact_limit_bytes, project_limit, project_storage_limit_bytes FROM users WHERE id = ?'
        )
        .get(id);
    const free = {
      artifact_limit_bytes: 100 * 1024 ** 2,
      project_limit: 100,
      project_storage_limit_bytes: 100 * 1024 ** 2
    };
    expect(limits('user_free')).toEqual(free);
    expect(limits('user_none')).toEqual(free);
    expect(limits('user_premium')).toEqual({
      artifact_limit_bytes: 1024 ** 3,
      project_limit: 10_000,
      project_storage_limit_bytes: 1024 ** 3
    });
  });
});
