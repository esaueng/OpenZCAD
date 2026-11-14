import {
  MAX_ACCOUNT_PROJECTS,
  MAX_ACCOUNT_STORAGE_BYTES,
  type AccountEntitlements,
  type AccountTier
} from '@openzcad/shared';
import type { CloudflareEnv } from './index';

/**
 * Premium's one storage allowance, for everything the account stores
 * (projects, save states, imports, exports, encrypted files): 1 GiB.
 */
export const PREMIUM_STORAGE_BYTES = 1024 ** 3;

/**
 * The Premium storage override. `PREMIUM_STORAGE_LIMIT_BYTES` names the
 * single allowance; the two names from before it was one,
 * `PREMIUM_PROJECT_STORAGE_LIMIT_BYTES` and then
 * `PREMIUM_ARTIFACT_LIMIT_BYTES`, still apply when it is unset.
 */
function premiumStorageOverride(env: CloudflareEnv): string | undefined {
  for (const value of [
    env.PREMIUM_STORAGE_LIMIT_BYTES,
    env.PREMIUM_PROJECT_STORAGE_LIMIT_BYTES,
    env.PREMIUM_ARTIFACT_LIMIT_BYTES
  ]) {
    if (value?.trim()) return value;
  }
  return undefined;
}

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

/** What this server computes: always with the single storage allowance. */
export type ServerAccountEntitlements = AccountEntitlements & {
  storageLimitBytes: number;
};

export function accountEntitlements(
  env: CloudflareEnv,
  email?: string
): ServerAccountEntitlements {
  const tier = accountTier(env, email);
  const ai = accountAiLimits(env, email);
  // One bucket per account (migration 0049): projects and files share it.
  const storageLimitBytes =
    tier === 'premium'
      ? positiveInteger(
          premiumStorageOverride(env),
          PREMIUM_STORAGE_BYTES,
          1024 ** 4
        )
      : MAX_ACCOUNT_STORAGE_BYTES;
  return {
    tier,
    projectLimit:
      tier === 'premium'
        ? positiveInteger(env.PREMIUM_PROJECT_LIMIT, 10_000, 100_000)
        : MAX_ACCOUNT_PROJECTS,
    storageLimitBytes,
    // Older clients read these two; both name the same single allowance.
    projectStorageLimitBytes: storageLimitBytes,
    artifactLimitBytes: storageLimitBytes,
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
 * with this deployment's tier policy, once per isolate and database. Since
 * migration 0049 both byte columns hold the one storage allowance: the
 * quota triggers read `project_storage_limit_bytes`, and the in-flight
 * reservation check and older Workers read `artifact_limit_bytes`.
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
          premium.storageLimitBytes,
          free.storageLimitBytes,
          premium.projectLimit,
          free.projectLimit,
          premium.storageLimitBytes,
          free.storageLimitBytes
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
