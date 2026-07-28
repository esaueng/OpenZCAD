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

/**
 * What one turn costs against the window. A turn carrying drawings is several
 * times the work of a text turn — high-detail image tokens plus the reasoning to
 * read them — so it must not be charged the same as "make it 2mm wider".
 */
export const ASSISTANT_ATTACHMENT_QUOTA_COST = 3;

export function assistantQuotaCost(attachmentCount: number): number {
  return attachmentCount > 0 ? ASSISTANT_ATTACHMENT_QUOTA_COST : 1;
}

export async function consumeAssistantQuota(
  userId: UserId,
  env: CloudflareEnv,
  now = Date.now(),
  cost = 1
): Promise<AssistantQuotaResult> {
  const { limit, windowSeconds } = rateLimitSettings(env);
  const windowMs = windowSeconds * 1_000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  // A nonsensical cost must not become a free request.
  const charge = Number.isInteger(cost) && cost > 0 ? Math.min(cost, limit) : 1;
  let count: number;

  if (env.DB) {
    const row = await env.DB.prepare(
      `INSERT INTO ai_rate_limits (user_id, window_start, request_count)
       VALUES (?, ?, ?3)
       ON CONFLICT(user_id) DO UPDATE SET
         window_start = excluded.window_start,
         request_count = CASE
           WHEN ai_rate_limits.window_start = excluded.window_start
             THEN ai_rate_limits.request_count + ?3
           ELSE ?3
         END
       RETURNING request_count`
    )
      .bind(userId, windowStart, charge)
      .first<{ request_count: number }>();
    count = row?.request_count ?? limit + 1;
  } else {
    let buckets = fallbackBuckets.get(env);
    if (!buckets) {
      buckets = new Map();
      fallbackBuckets.set(env, buckets);
    }
    const current = buckets.get(userId);
    count =
      current?.windowStart === windowStart ? current.count + charge : charge;
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
