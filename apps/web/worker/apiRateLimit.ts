import type { CloudflareEnv } from '@openzcad/cloudflare-adapters';
import { PROJECT_INVITATION_RATE_WINDOW_SECONDS } from '@openzcad/persistence';
import { requestClientAddressKey } from './clientAddress';
import { HttpError } from './validation';

/** Refuses an exhausted bucket without allocating or incrementing one. */
export async function assertApiRateLimitAvailable(
  env: CloudflareEnv,
  bucket: string,
  limit: number
): Promise<void> {
  if (env.ENVIRONMENT === 'development' && env.PRODUCTION_GUARD === undefined)
    return;
  if (!env.DB) throw new HttpError(503, 'API request guard is unavailable.');
  const usage = await env.DB.prepare(
    'SELECT request_count FROM auth_rate_limits WHERE bucket = ? AND window_start = ?'
  )
    .bind(bucket, currentWindowStart())
    .first<{ request_count: number }>();
  if (usage && usage.request_count >= limit)
    throw new HttpError(429, 'API request limit reached. Try again later.');
}

/**
 * Atomic fixed-window buckets share the existing expiring auth accounting
 * table. A request past the limit is refused without a write: the upsert
 * only counts while the window has room, so a client that keeps calling
 * after its 429 costs one keyed statement each and changes no row. Stale
 * windows are reclaimed by the scheduled `purgeStaleRateLimitBuckets`, not
 * here.
 */
export async function enforceApiRateLimit(
  env: CloudflareEnv,
  bucket: string,
  limit: number
): Promise<void> {
  if (env.ENVIRONMENT === 'development' && env.PRODUCTION_GUARD === undefined)
    return;
  if (!env.DB) throw new HttpError(503, 'API request guard is unavailable.');
  const usage = await env.DB.prepare(
    `
    INSERT INTO auth_rate_limits (bucket, window_start, request_count)
    VALUES (?, ?, 1)
    ON CONFLICT(bucket) DO UPDATE SET
      window_start = excluded.window_start,
      request_count = CASE WHEN auth_rate_limits.window_start = excluded.window_start
        THEN auth_rate_limits.request_count + 1 ELSE 1 END
    WHERE auth_rate_limits.window_start != excluded.window_start
      OR auth_rate_limits.request_count < ?
    RETURNING request_count
  `
  )
    .bind(bucket, currentWindowStart(), limit)
    .first<{ request_count: number }>();
  if (!usage || usage.request_count > limit)
    throw new HttpError(429, 'API request limit reached. Try again later.');
}

/**
 * Reclaims rate-limit rows whose window ended long ago, from the scheduled
 * handler rather than the request path. The shared table includes hourly
 * invitation counters as well as login and per-minute counters, so two of
 * the longest windows are kept. Bounded per run; anything left goes on the
 * next one.
 */
export async function purgeStaleRateLimitBuckets(
  env: CloudflareEnv,
  now = Date.now()
): Promise<void> {
  if (!env.DB) return;
  const cutoff =
    Math.floor(now / 60_000) * 60 - PROJECT_INVITATION_RATE_WINDOW_SECONDS * 2;
  for (let batch = 0; batch < STALE_PURGE_BATCHES; batch += 1) {
    const result = await env.DB.prepare(
      `DELETE FROM auth_rate_limits WHERE bucket IN (
        SELECT bucket FROM auth_rate_limits WHERE window_start < ?
        LIMIT ?
      )`
    )
      .bind(cutoff, STALE_PURGE_BATCH_ROWS)
      .run();
    if ((result.meta?.changes ?? 0) < STALE_PURGE_BATCH_ROWS) return;
  }
}

const STALE_PURGE_BATCH_ROWS = 1_000;
const STALE_PURGE_BATCHES = 50;

/** A Workers rate-limit binding (a `ratelimits` entry in the Wrangler config). */
export interface WorkersRateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Requests per minute for each Workers rate-limit binding, keyed by binding
 * name. The bindings are checked before any D1 work; their `simple.limit`
 * (with a 60-second `period`) in wrangler.jsonc and
 * wrangler.selfhost.example.jsonc must equal these, which
 * test/worker-public-request-limits.test.ts checks. They count per
 * Cloudflare location, so they are a cheap, approximate first line. A
 * deployment without a binding counts the same limit in D1 instead.
 */
export const REQUEST_LIMITS = {
  /**
   * Email-code verification and desktop refresh, per address: sign-in
   * routes with no other per-address limit before their body is read
   * (judgment: far above what a person typing a code needs).
   */
  AUTH_REQUEST_LIMITER: 30,
  /**
   * Desktop sign-in exchange, per address (judgment: far above a desktop
   * app polling for its approval every couple of seconds).
   */
  DESKTOP_EXCHANGE_LIMITER: 60,
  /** Anonymous assistant proposals (development only), per address. */
  ANONYMOUS_ASSISTANT_LIMITER: 20,
  /**
   * Plaintext share-link reads per address outside a load's own budget:
   * document reads, and asset and source reads of a link this address has
   * not loaded (judgment; set like the encrypted routes' blob budget).
   */
  SHARE_LINK_LIMITER: 300,
  /**
   * Signed-in GET and HEAD requests, per account. Writes keep their tighter
   * `api:` budget; reads get one generous enough for loading a large
   * project's assets or encrypted blobs several times a minute.
   */
  ACCOUNT_READ_LIMITER: 1_200
} as const;

export type RequestLimiter = keyof typeof REQUEST_LIMITS;

export type RequestLimiterEnv = { [Name in RequestLimiter]?: WorkersRateLimit };

/**
 * Counts one request against `bucket` and the limiter's limit: in the named
 * Workers rate-limit binding when the deployment has it, with no D1 work at
 * all, and otherwise in D1 like `enforceApiRateLimit`.
 */
export async function enforceRequestLimit(
  env: CloudflareEnv & RequestLimiterEnv,
  limiter: RequestLimiter,
  bucket: string
): Promise<void> {
  if (env.ENVIRONMENT === 'development' && env.PRODUCTION_GUARD === undefined)
    return;
  const binding = env[limiter];
  if (binding && typeof binding.limit === 'function') {
    let outcome: { success: boolean } | null = null;
    try {
      outcome = await binding.limit({ key: bucket });
    } catch {
      // An unavailable binding falls back to D1 below.
    }
    if (outcome) {
      if (!outcome.success)
        throw new HttpError(429, 'API request limit reached. Try again later.');
      return;
    }
  }
  await enforceApiRateLimit(env, bucket, REQUEST_LIMITS[limiter]);
}

/** Counts one signed-in read against the account's read budget. */
export async function enforceAccountReadRateLimit(
  env: CloudflareEnv & RequestLimiterEnv,
  userId: string
): Promise<void> {
  await enforceRequestLimit(env, 'ACCOUNT_READ_LIMITER', `api-read:${userId}`);
}

/**
 * A bucket whose limit is known only after the work it should spare (the
 * anonymous share-link blob route sizes a link's budget from its snapshot):
 * `markApiRateLimitSpent` records, in the same table and window, that the
 * bucket went over its limit this minute, and `isApiRateLimitSpent` answers
 * that with one keyed read before any of that work. Both expire with the
 * window.
 */
export async function markApiRateLimitSpent(
  env: CloudflareEnv,
  bucket: string
): Promise<void> {
  if (env.ENVIRONMENT === 'development' && env.PRODUCTION_GUARD === undefined)
    return;
  if (!env.DB) throw new HttpError(503, 'API request guard is unavailable.');
  await env.DB.prepare(
    `INSERT INTO auth_rate_limits (bucket, window_start, request_count)
     VALUES (?, ?, 1)
     ON CONFLICT(bucket) DO UPDATE SET
       window_start = excluded.window_start, request_count = 1`
  )
    .bind(bucket, currentWindowStart())
    .run();
}

export async function isApiRateLimitSpent(
  env: CloudflareEnv,
  bucket: string
): Promise<boolean> {
  if (env.ENVIRONMENT === 'development' && env.PRODUCTION_GUARD === undefined)
    return false;
  if (!env.DB) throw new HttpError(503, 'API request guard is unavailable.');
  const row = await env.DB.prepare(
    `SELECT 1 AS spent FROM auth_rate_limits
     WHERE bucket = ? AND window_start = ?`
  )
    .bind(bucket, currentWindowStart())
    .first<{ spent: number }>();
  return row !== null;
}

function currentWindowStart(): number {
  return Math.floor(Date.now() / 60_000) * 60;
}

export async function publicRequestBucket(
  request: Request,
  env: CloudflareEnv,
  scope: string
): Promise<string> {
  const secret = env.AUTH_OTP_PEPPER;
  if (!secret) throw new HttpError(503, 'API request guard is unavailable.');
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(requestClientAddressKey(request))
  );
  return `${scope}:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Counts one anonymous request against its client address's bucket for
 * `scope`, before the route reads a body or looks anything up: in the named
 * Workers rate-limit binding when there is one, else in D1. Skipped exactly
 * where `enforceApiRateLimit` is, so local development needs no pepper.
 */
export async function enforcePublicRequestRateLimit(
  request: Request,
  env: CloudflareEnv & RequestLimiterEnv,
  scope: string,
  limiter: RequestLimiter
): Promise<void> {
  if (env.ENVIRONMENT === 'development' && env.PRODUCTION_GUARD === undefined)
    return;
  await enforceRequestLimit(
    env,
    limiter,
    await publicRequestBucket(request, env, scope)
  );
}
