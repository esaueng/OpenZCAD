import {
  MAX_ACCOUNT_ARTIFACT_BYTES,
  MAX_ACCOUNT_PROJECTS,
  MAX_ACCOUNT_PROJECT_STORAGE_BYTES,
  type AccountEntitlements,
  type AccountTier
} from '@openzcad/shared';
import type { CloudflareEnv } from './index';

/** Premium project storage and cloud file storage, each: 25 GiB. */
export const PREMIUM_STORAGE_BYTES = 25 * 1024 ** 3;

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
            PREMIUM_STORAGE_BYTES,
            1024 ** 4
          )
        : MAX_ACCOUNT_PROJECT_STORAGE_BYTES,
    artifactLimitBytes:
      tier === 'premium'
        ? positiveInteger(
            env.PREMIUM_ARTIFACT_LIMIT_BYTES,
            PREMIUM_STORAGE_BYTES,
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

/** Databases whose stored limits already match this isolate's tier policy. */
const syncedAccountLimits = new WeakMap<D1Database, Promise<void>>();

/**
 * Brings every account's derived limits (`users.artifact_limit_bytes`,
 * `project_limit`, `project_storage_limit_bytes`, migration 0022) in line
 * with this deployment's tier policy, once per isolate and database.
 *
 * The quota triggers read those columns. The plaintext write paths refresh
 * the owner's row before each write, but encrypted saves, copies and
 * migrations do not, so an account that only writes encrypted projects
 * would otherwise keep the limits of whatever policy last touched its row,
 * such as the column defaults. One conditional UPDATE writes only rows
 * that differ; a failure (an older schema) is retried on a later request.
 */
export function syncStoredAccountLimits(
  env: CloudflareEnv,
  db: D1Database | undefined
): Promise<void> {
  if (!db) return Promise.resolve();
  const cached = syncedAccountLimits.get(db);
  if (cached) return cached;
  const premiumEmails = (env.PREMIUM_USER_EMAILS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const free = accountEntitlements(env);
  const premium = premiumEmails[0]
    ? accountEntitlements(env, premiumEmails[0])
    : free;
  const isPremium = `lower(trim(email)) IN (SELECT value FROM json_each(?1))`;
  const artifact = `CASE WHEN ${isPremium} THEN ?2 ELSE ?3 END`;
  const projects = `CASE WHEN ${isPremium} THEN ?4 ELSE ?5 END`;
  const storage = `CASE WHEN ${isPremium} THEN ?6 ELSE ?7 END`;
  const sync = Promise.resolve()
    .then(() =>
      db
        .prepare(
          `UPDATE users
       SET artifact_limit_bytes = ${artifact},
           project_limit = ${projects},
           project_storage_limit_bytes = ${storage}
       WHERE artifact_limit_bytes IS NOT ${artifact}
          OR project_limit IS NOT ${projects}
          OR project_storage_limit_bytes IS NOT ${storage}`
        )
        .bind(
          JSON.stringify(premiumEmails),
          premium.artifactLimitBytes,
          free.artifactLimitBytes,
          premium.projectLimit,
          free.projectLimit,
          premium.projectStorageLimitBytes,
          free.projectStorageLimitBytes
        )
        .run()
    )
    .then(() => undefined)
    .catch((error: unknown) => {
      // Retry a minute later, not on every request of an older schema.
      setTimeout(() => syncedAccountLimits.delete(db), 60_000);
      console.error('Account limit sync failed:', {
        message: error instanceof Error ? error.message : String(error)
      });
    });
  syncedAccountLimits.set(db, sync);
  return sync;
}
