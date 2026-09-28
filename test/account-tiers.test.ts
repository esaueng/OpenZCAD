import { describe, expect, it } from 'vitest';
import {
  accountEntitlements,
  accountTier
} from '@openzcad/cloudflare-adapters';
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
    expect(accountEntitlements(env, 'other@example.com')).toEqual({
      tier: 'free',
      projectLimit: 100,
      projectStorageLimitBytes: 2 * 1024 ** 3,
      artifactLimitBytes: 2 * 1024 ** 3,
      ai: {
        requestLimit: 6,
        costLimitUnits: 24,
        concurrencyLimit: 2,
        windowSeconds: 600
      }
    });
    expect(accountEntitlements(env, 'first@example.com')).toEqual({
      tier: 'premium',
      projectLimit: 10_000,
      projectStorageLimitBytes: 100 * 1024 ** 3,
      artifactLimitBytes: 100 * 1024 ** 3,
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
});
