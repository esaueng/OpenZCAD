import {
  MAX_ACCOUNT_ARTIFACT_BYTES,
  MAX_ACCOUNT_PROJECTS,
  MAX_ACCOUNT_PROJECT_STORAGE_BYTES,
  type AccountEntitlements,
  type AccountTier
} from '@openzcad/shared';
import type { CloudflareEnv } from './index';

/** Invalid configuration falls back to a finite operational ceiling. */
function positiveInteger(
  value: string | undefined,
  fallback: number,
  max: number
): number {
  if (!value || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, max)
    : fallback;
}

/** Call only with an email obtained from authenticated identity or the owner row. */
export function accountTier(env: CloudflareEnv, email?: string): AccountTier {
  const normalized = email?.trim().toLowerCase();
  return normalized &&
    env.PREMIUM_USER_EMAILS?.split(',').some(
      (entry) => entry.trim().toLowerCase() === normalized
    )
    ? 'premium'
    : 'free';
}

export function accountAiLimits(env: CloudflareEnv, email?: string) {
  const premium = accountTier(env, email) === 'premium';
  return {
    accountRequestLimit: positiveInteger(
      premium
        ? env.AI_PREMIUM_ACCOUNT_RATE_LIMIT_REQUESTS
        : env.AI_ACCOUNT_RATE_LIMIT_REQUESTS,
      premium ? 600 : 6,
      1_000
    ),
    accountCostLimit: positiveInteger(
      premium
        ? env.AI_PREMIUM_ACCOUNT_COST_LIMIT_UNITS
        : env.AI_ACCOUNT_COST_LIMIT_UNITS,
      premium ? 2_400 : 24,
      10_000
    ),
    accountConcurrencyLimit: positiveInteger(
      premium
        ? env.AI_PREMIUM_ACCOUNT_CONCURRENCY_LIMIT
        : env.AI_ACCOUNT_CONCURRENCY_LIMIT,
      premium ? 8 : 2,
      100
    ),
    windowSeconds: positiveInteger(
      env.AI_RATE_LIMIT_WINDOW_SECONDS,
      600,
      86_400
    )
  };
}

export function accountEntitlements(
  env: CloudflareEnv,
  email?: string
): AccountEntitlements {
  const tier = accountTier(env, email);
  const ai = accountAiLimits(env, email);
  return {
    tier,
    projectLimit:
      tier === 'premium'
        ? positiveInteger(env.PREMIUM_PROJECT_LIMIT, 10_000, 100_000)
        : MAX_ACCOUNT_PROJECTS,
    projectStorageLimitBytes:
      tier === 'premium'
        ? positiveInteger(
            env.PREMIUM_PROJECT_STORAGE_LIMIT_BYTES,
            100 * 1024 ** 3,
            1024 ** 4
          )
        : MAX_ACCOUNT_PROJECT_STORAGE_BYTES,
    artifactLimitBytes:
      tier === 'premium'
        ? positiveInteger(
            env.PREMIUM_ARTIFACT_LIMIT_BYTES,
            100 * 1024 ** 3,
            1024 ** 4
          )
        : MAX_ACCOUNT_ARTIFACT_BYTES,
    ai: {
      requestLimit: ai.accountRequestLimit,
      costLimitUnits: ai.accountCostLimit,
      windowSeconds: ai.windowSeconds,
      concurrencyLimit: ai.accountConcurrencyLimit
    }
  };
}
