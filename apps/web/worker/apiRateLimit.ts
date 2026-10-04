import type { CloudflareEnv } from '@openzcad/cloudflare-adapters';
import { PROJECT_INVITATION_RATE_WINDOW_SECONDS } from '@openzcad/persistence';
import { HttpError } from './validation';

/** Atomic fixed-window buckets share the existing expiring auth accounting table. */
export async function enforceApiRateLimit(
  env: CloudflareEnv,
  bucket: string,
  limit: number
): Promise<void> {
  if (env.ENVIRONMENT === 'development' && env.PRODUCTION_GUARD === undefined)
    return;
  if (!env.DB) throw new HttpError(503, 'API request guard is unavailable.');
  const windowStart = Math.floor(Date.now() / 60_000) * 60;
  const usage = await env.DB.prepare(
    `
    INSERT INTO auth_rate_limits (bucket, window_start, request_count)
    VALUES (?, ?, 1)
    ON CONFLICT(bucket) DO UPDATE SET
      window_start = excluded.window_start,
      request_count = CASE WHEN auth_rate_limits.window_start = excluded.window_start
        THEN auth_rate_limits.request_count + 1 ELSE 1 END
    RETURNING request_count
  `
  )
    .bind(bucket, windowStart)
    .first<{ request_count: number }>();
  if (!usage) throw new HttpError(503, 'API request guard is unavailable.');
  // Public traffic must also expire its buckets when no login flow runs.
  // The shared table includes hourly invitation counters as well as login
  // counters. Retain two of the longest windows before reclaiming rows.
  await env.DB.prepare(
    `DELETE FROM auth_rate_limits WHERE bucket IN (
      SELECT bucket FROM auth_rate_limits WHERE window_start < ?
      ORDER BY window_start LIMIT 100
    )`
  )
    .bind(windowStart - PROJECT_INVITATION_RATE_WINDOW_SECONDS * 2)
    .run();
  if (usage.request_count > limit)
    throw new HttpError(429, 'API request limit reached. Try again later.');
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
    encoder.encode(request.headers.get('cf-connecting-ip') ?? 'unknown')
  );
  return `${scope}:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
