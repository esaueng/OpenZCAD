import type { CloudflareEnv } from '@openzcad/cloudflare-adapters';
import type { UserId } from '@openzcad/shared';

const DEFAULT_REQUEST_LIMIT = 6;
const DEFAULT_WINDOW_SECONDS = 10 * 60;
const MAX_REQUEST_LIMIT = 100;
const MAX_WINDOW_SECONDS = 24 * 60 * 60;

interface RateLimitBucket {
  count: number;
  windowStart: number;
}

export interface AssistantQuotaResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

const fallbackBuckets = new WeakMap<
  CloudflareEnv,
  Map<UserId, RateLimitBucket>
>();

function boundedInteger(
  value: string | undefined,
  fallback: number,
  maximum: number
): number {
  const parsed = Number.parseInt(value?.trim() ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

function rateLimitSettings(env: CloudflareEnv) {
  return {
    limit: boundedInteger(
      env.AI_RATE_LIMIT_REQUESTS,
      DEFAULT_REQUEST_LIMIT,
      MAX_REQUEST_LIMIT
    ),
    windowSeconds: boundedInteger(
      env.AI_RATE_LIMIT_WINDOW_SECONDS,
      DEFAULT_WINDOW_SECONDS,
      MAX_WINDOW_SECONDS
    )
  };
}

export async function consumeAssistantQuota(
  userId: UserId,
  env: CloudflareEnv,
  now = Date.now()
): Promise<AssistantQuotaResult> {
  const { limit, windowSeconds } = rateLimitSettings(env);
  const windowMs = windowSeconds * 1_000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  let count: number;

  if (env.DB) {
    const row = await env.DB.prepare(
      `INSERT INTO ai_rate_limits (user_id, window_start, request_count)
       VALUES (?, ?, 1)
       ON CONFLICT(user_id) DO UPDATE SET
         window_start = excluded.window_start,
         request_count = CASE
           WHEN ai_rate_limits.window_start = excluded.window_start
             THEN ai_rate_limits.request_count + 1
           ELSE 1
         END
       RETURNING request_count`
    )
      .bind(userId, windowStart)
      .first<{ request_count: number }>();
    count = row?.request_count ?? limit + 1;
  } else {
    let buckets = fallbackBuckets.get(env);
    if (!buckets) {
      buckets = new Map();
      fallbackBuckets.set(env, buckets);
    }
    const current = buckets.get(userId);
    count = current?.windowStart === windowStart ? current.count + 1 : 1;
    buckets.set(userId, { count, windowStart });
  }

  return {
    allowed: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((windowStart + windowMs - now) / 1_000)
    )
  };
}
